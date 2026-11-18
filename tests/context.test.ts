import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { ContextSchema } from "../src/shared/context.ts";
import { testModels } from "./models.ts";

describe("SDK context and compaction", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-context-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function read() {
    const response = await createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/context`,
    );
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    return ContextSchema.parse(raw);
  }
  async function seed() {
    await chat.conversation.configure({ compaction: { keepRecentTokens: 1 } }, BACKGROUND_CONTEXT);
    for (let index = 0; index < 6; index++)
      await chat.conversation.submit(
        {
          type: "write",
          entry: {
            kind: "test.context",
            model: [
              { role: "user", content: `Saved history ${index} `.repeat(100), timestamp: index },
            ],
          },
        },
        BACKGROUND_CONTEXT,
      );
  }
  async function compact() {
    return createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/compact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: "Keep decisions" }),
      },
    );
  }
  it("inspects real committed entries and places idle summaries without erasing history", async () => {
    await seed();
    const before = await read();
    expect(before.entryCount).toBe(6);
    expect(before.headId).toBeNull();
    const response = await compact();
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await read()).compactions).toMatchObject([{ trigger: "manual", blocking: false }]);
    await expect(chat.chats.change(String(chat.conversation.id), "archive")).rejects.toThrow();
    expect((await read()).headId).toBeNull();
    provider.calls[0]!.finish("Durable summary");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect((await read()).headId).not.toBeNull());
    const after = await read();
    expect(after.entryCount).toBeLessThan(before.entryCount);
    const history = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(history.items.filter((entry) => entry.kind === "test.context")).toHaveLength(6);
    expect(after.compactions).toEqual([]);
  });
  it("admits while busy but does not claim the summary has been placed", async () => {
    await seed();
    await chat.conversation.submit({ type: "input", content: "Work" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.finish("Queued summary");
    await vi.waitFor(async () => expect((await read()).compactions).toEqual([]));
    expect((await read()).headId).toBeNull();
    provider.calls[0]!.finish("Finished");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read()).headId).not.toBeNull();
  });
  it("sanitizes summary failure and rejects archived, deleted and malformed requests", async () => {
    await seed();
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.fail();
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect((await read()).failure?.trigger).toBe("manual"));
    const id = String(chat.conversation.id);
    await chat.chats.change(id, "archive");
    expect((await compact()).status).toBe(409);
    await chat.chats.change(id, "delete");
    expect((await compact()).status).toBe(404);
  });
  it("aborts summarization without losing committed context and safely no-ops empty context", async () => {
    const malformed = await createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/compact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: 4 }),
      },
    );
    expect(malformed.status).toBe(400);
    expect((await compact()).status).toBe(202);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(provider.calls).toHaveLength(0);
    await seed();
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await chat.conversation.abort(BACKGROUND_CONTEXT);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read()).entryCount).toBe(6);
    expect((await read()).headId).toBeNull();
    expect((await read()).compactions).toEqual([]);
  });
});
