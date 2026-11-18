import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { testModels } from "./models.ts";

describe("durable rename and history forks", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-branches-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function seed(text: string) {
    await chat.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "test.saved",
          model: [{ role: "user", content: text, timestamp: Date.now() }],
        },
      },
      BACKGROUND_CONTEXT,
    );
    return (await chat.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]!.id;
  }
  it("inherits through the inclusive selected boundary with as-of config, no live work or later entries", async () => {
    await chat.conversation.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    const first = await seed("First boundary");
    await chat.conversation.configure({ thinkingLevel: "low" }, BACKGROUND_CONTEXT);
    const second = await seed("Later history");
    const rootId = String(chat.conversation.id);
    const requestId = crypto.randomUUID();
    const fork = await chat.chats.fork(rootId, requestId, String(first));
    const scoped = (await chat.chats.resolve(fork.id))!;
    expect(fork).toMatchObject({
      parentId: rootId,
      forkEntryId: String(first),
      branchRootId: rootId,
      running: false,
    });
    expect(
      (await scoped.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([first]);
    expect((await scoped.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
    expect(provider.calls).toHaveLength(0);
    const copies = await Promise.all([
      chat.chats.fork(rootId, requestId, String(first)),
      chat.chats.fork(rootId, requestId, String(first)),
    ]);
    expect(copies.map((copy) => copy.id)).toEqual([fork.id, fork.id]);
    expect((await chat.chats.list()).chats).toHaveLength(2);
    await expect(chat.chats.fork(rootId, requestId, String(second))).rejects.toThrow("identity");
    await scoped.admit({ type: "input", content: "Only the fork" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(JSON.stringify(provider.calls[0]!.context)).toContain("First boundary");
    expect(JSON.stringify(provider.calls[0]!.context)).not.toContain("Later history");
    provider.calls[0]!.finish("Branch answer");
    await scoped.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(
      (await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items,
    ).toHaveLength(2);
    const branchEntries = (
      await scoped.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)
    ).items;
    expect(branchEntries.some((entry) => entry.id === second)).toBe(false);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect((await chat.chats.list()).chats.find((item) => item.id === fork.id)).toMatchObject(fork);
    const reopened = (await chat.chats.resolve(fork.id))!;
    expect((await chat.chats.fork(rootId, requestId, String(first))).id).toBe(fork.id);
    expect((await reopened.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
    expect(
      (await reopened.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items,
    ).toEqual(branchEntries);
  });
  it("rejects foreign/missing boundaries, allows inherited boundaries, and never resurrects deleted forks", async () => {
    const rootId = String(chat.conversation.id);
    const first = await seed("Root history");
    const other = await chat.chats.create(crypto.randomUUID());
    await expect(chat.chats.fork(other.id, crypto.randomUUID(), String(first))).rejects.toThrow(
      "not visible",
    );
    await expect(chat.chats.fork(rootId, crypto.randomUUID(), "999999")).rejects.toThrow(
      "not visible",
    );
    const requestId = crypto.randomUUID();
    const fork = await chat.chats.fork(rootId, requestId, String(first));
    const nested = await chat.chats.fork(fork.id, crypto.randomUUID(), String(first));
    expect(nested).toMatchObject({ parentId: fork.id, branchRootId: rootId });
    await chat.chats.change(fork.id, "delete");
    await expect(chat.chats.fork(rootId, requestId, String(first))).rejects.toThrow(
      "archived or deleted",
    );
    expect((await chat.chats.resolve(nested.id))?.conversation).toBeDefined();
    await chat.chats.change(rootId, "delete");
    const surviving = (await chat.chats.resolve(nested.id))!;
    expect(
      (await surviving.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([first]);
  });
  it("forks committed history while the source runs without copying or stopping its task", async () => {
    const first = await seed("Committed");
    await chat.conversation.submit({ type: "input", content: "Keep running" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const fork = await chat.chats.fork(
      String(chat.conversation.id),
      crypto.randomUUID(),
      String(first),
    );
    expect(
      (await chat.chats.list()).chats.find((item) => item.id === String(chat.conversation.id))
        ?.running,
    ).toBe(true);
    expect(fork.running).toBe(false);
    expect(provider.calls).toHaveLength(1);
    provider.calls[0]!.finish("Original answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
  it("validates durable renames, keeps explicit empty titles from first-input overwrite and rejects stale saves", async () => {
    const id = String(chat.conversation.id);
    const app = createApp(chat);
    const rename = (title: string, expected = "Original chat") =>
      app.request(`http://localhost:3000/api/chats/${id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, expected }),
      });
    expect((await rename("   ")).status).toBe(400);
    expect((await rename("x".repeat(81))).status).toBe(400);
    expect((await rename("Named by user")).status).toBe(200);
    expect((await rename("Named by user")).status).toBe(200);
    expect((await rename("Stale")).status).toBe(409);
    await chat.conversation.submit(
      { type: "input", content: "Do not rename me" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("Done");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect((await chat.chats.list()).chats[0]?.title).toBe("Named by user");
    await chat.chats.change(id, "archive");
    await expect(chat.chats.rename(id, "No", "Named by user")).rejects.toThrow("Restore");
  });
  it("validates fork admission and refuses archived/deleted sources", async () => {
    const id = String(chat.conversation.id);
    const at = String(await seed("Boundary"));
    const app = createApp(chat);
    const request = (body: unknown) =>
      app.request(`http://localhost:3000/api/chats/${id}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await request({ at: "0", requestId: crypto.randomUUID() })).status).toBe(400);
    expect((await request({ at, requestId: "invalid" })).status).toBe(400);
    await chat.chats.change(id, "archive");
    expect((await request({ at, requestId: crypto.randomUUID() })).status).toBe(409);
    await chat.chats.change(id, "delete");
    expect((await request({ at, requestId: crypto.randomUUID() })).status).toBe(404);
  });
});
