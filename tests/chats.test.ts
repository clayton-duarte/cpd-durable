import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { ChatCatalogSchema, ChatSummarySchema } from "../src/shared/chats.ts";
import { testModels } from "./models.ts";
import { vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ChatStateSchema } from "../src/shared/chat.ts";
import { CatalogDoc } from "../src/server/chats.ts";

describe("durable chat catalog", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-chats-"));
    chat = await openChat(directory, testModels().models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("adopts the root and deduplicates concurrent creation and retries across reopen", async () => {
    const requestId = crypto.randomUUID();
    const created = await Promise.all([chat.chats.create(requestId), chat.chats.create(requestId)]);
    expect(created[0]).toEqual(created[1]);
    expect((await chat.chats.list()).chats).toHaveLength(2);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect(await chat.chats.create(requestId)).toEqual(created[0]);
    expect((await chat.chats.list()).chats.map((item) => item.title)).toEqual([
      "Original chat",
      "New chat",
    ]);
  });
  it("reuses one empty chat across distinct requests and preserves retry identity after it is named", async () => {
    const requests = Array.from({ length: 8 }, () => crypto.randomUUID());
    const created = await Promise.all(requests.map((id) => chat.chats.create(id)));
    expect(new Set(created.map((item) => item.id)).size).toBe(1);
    const scope = await chat.chats.resolve(created[0]!.id);
    await scope!.admit({ type: "input", content: "Named chat", requestId: crypto.randomUUID() });
    expect((await chat.chats.create(requests[1]!)).id).toBe(created[0]!.id);
    const next = await chat.chats.create(crypto.randomUUID());
    expect(next.id).not.toBe(created[0]!.id);
  });
  it("archives, restores and tombstones deletion across reopen, including the original", async () => {
    const created = await chat.chats.create(crypto.randomUUID());
    await chat.chats.change(created.id, "archive");
    expect((await chat.chats.list()).chats.find((item) => item.id === created.id)?.status).toBe(
      "archived",
    );
    await chat.chats.change(created.id, "unarchive");
    expect((await chat.chats.list()).chats.find((item) => item.id === created.id)?.status).toBe(
      "regular",
    );
    await chat.chats.change(created.id, "delete");
    await chat.chats.change(created.id, "delete");
    await chat.chats.change(String(chat.conversation.id), "delete");
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect((await chat.chats.list()).chats).toEqual([]);
    expect(await chat.chats.resolve(created.id)).toBeUndefined();
    expect(
      (await createApp(chat).request("http://localhost:3000/api/stop", { method: "POST" })).status,
    ).toBe(404);
    expect((await chat.chats.create(crypto.randomUUID())).id).not.toBe(created.id);
  });
  it("does not restore a second empty chat into the active list", async () => {
    const first = await chat.chats.create(crypto.randomUUID());
    await chat.chats.change(first.id, "archive");
    const second = await chat.chats.create(crypto.randomUUID());
    expect(second.id).not.toBe(first.id);
    await expect(chat.chats.change(first.id, "unarchive")).rejects.toThrow(
      "An empty chat is already open",
    );
    await chat.chats.change(second.id, "delete");
    await chat.chats.change(first.id, "unarchive");
  });
  it("archives surplus empty chats from an older catalog without dropping their records", async () => {
    await chat.chats.create(crypto.randomUUID());
    await chat.conversation.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      const duplicate = await tx.createConversation({ ownership: { kind: "ownerless" } });
      catalog.items.push({ id: duplicate.id, title: "New chat", named: false, requestId: null });
    }, BACKGROUND_CONTEXT);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    const catalog = await chat.chats.list();
    expect(
      catalog.chats.filter((item) => item.title === "New chat" && item.status === "regular"),
    ).toHaveLength(1);
    expect(catalog.chats.filter((item) => item.status === "archived")).toHaveLength(1);
  });
  it("validates creation and scoped routes without treating unknown chats as the root", async () => {
    const app = createApp(chat);
    const root = ChatCatalogSchema.parse(
      await (await app.request("http://localhost:3000/api/chats")).json(),
    );
    const response = await app.request("http://localhost:3000/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(201);
    const created = ChatSummarySchema.parse(await response.json());
    expect(created.id).not.toBe(root.rootId);
    for (const id of ["99999", "bad", "0"]) {
      expect(
        (await app.request(`http://localhost:3000/api/chats/${id}/stop`, { method: "POST" }))
          .status,
      ).toBe(404);
    }
    expect(
      (await app.request(`http://localhost:3000/api/chats/${created.id}/stop`, { method: "POST" }))
        .status,
    ).toBe(204);
    expect(
      (
        await app.request("http://localhost:3000/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
  it("names only the admitted chat, keeps history views scoped and does not stop a different run", async () => {
    await chat.close();
    const provider = testModels();
    chat = await openChat(directory, provider.models, directory);
    const created = await chat.chats.create(crypto.randomUUID());
    const app = createApp(chat);
    const post = (id: string, action: string, body?: unknown) =>
      app.request(`http://localhost:3000/api/chats/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const requestId = crypto.randomUUID();
    expect((await post(created.id, "input", { text: "First\n  question", requestId })).status).toBe(
      202,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await expect(chat.chats.change(created.id, "delete")).rejects.toThrow("Stop this chat");
    await expect(chat.chats.change(created.id, "archive")).rejects.toThrow("Stop this chat");
    expect((await chat.chats.list()).chats.find((item) => item.id === created.id)).toMatchObject({
      title: "First question",
      running: true,
    });
    expect((await post(String(chat.conversation.id), "stop")).status).toBe(204);
    expect((await chat.chats.list()).chats.find((item) => item.id === created.id)?.running).toBe(
      true,
    );
    const view = crypto.randomUUID();
    const stream = await app.request(
      `http://localhost:3000/api/chats/${created.id}/events?view=${view}`,
    );
    const reader = stream.body!.getReader();
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      const state = ChatStateSchema.parse(
        JSON.parse(
          frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        ),
      );
      expect(String(state.conversationId)).toBe(created.id);
      expect((await post(String(chat.conversation.id), "history", { view })).status).toBe(410);
    } finally {
      await reader.cancel();
    }
    provider.calls[0]!.finish("Done");
    const scope = await chat.chats.resolve(created.id);
    await scope!.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await chat.chats.list()).chats[0]?.title).toBe("Original chat");
  });
});
