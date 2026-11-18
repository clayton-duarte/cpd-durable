import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { FeedbackViewSchema } from "../src/shared/feedback.ts";
import { testModels } from "./models.ts";

describe("private response feedback", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  let entryId: number;
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const change = {
    requestId: "feedback-one",
    expectedRevision: 0,
    value: { vote: "helpful", comment: "Synthetic private comment" },
  } as const;
  const url = (id = String(chat.conversation.id), entry = entryId, index = 0) =>
    `http://localhost:3000/api/chats/${id}/feedback/${entry}/${index}`;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-feedback-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
    await chat.conversation.submit(
      { type: "input", content: "Synthetic question" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("Synthetic response");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const entries = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    entryId = entries.items.find((entry) => entry.kind === "pi.assistant")!.id;
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists CAS updates, idempotent receipts and explicit clearing without a model request", async () => {
    const app = createApp(chat);
    const before = FeedbackViewSchema.parse(await (await app.request(url())).json());
    expect(before).toMatchObject({ revision: 0, value: null, readOnly: false });
    const [first, retry] = await Promise.all([
      app.request(url(), post(change)),
      app.request(url(), post(change)),
    ]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await retry.json());
    expect(
      (
        await app.request(
          url(),
          post({ ...change, value: { ...change.value, comment: "different" } }),
        )
      ).status,
    ).toBe(409);
    expect((await app.request(url(), post({ ...change, requestId: "stale" }))).status).toBe(409);
    const clear = await app.request(
      url(),
      post({ requestId: "clear", expectedRevision: 1, value: null }),
    );
    expect(FeedbackViewSchema.parse(await clear.json())).toMatchObject({
      revision: 2,
      value: null,
    });
    expect(provider.calls).toHaveLength(1);
    expect(
      JSON.stringify((await chat.conversation.context(BACKGROUND_CONTEXT)).messages),
    ).not.toContain("Synthetic private comment");
    await chat.close();
    chat = await openChat(directory, provider.models, directory);
    expect(
      FeedbackViewSchema.parse(await (await createApp(chat).request(url())).json()),
    ).toMatchObject({ revision: 2, value: null });
    expect(provider.calls).toHaveLength(1);
  });

  it("scopes inherited fork feedback independently and rejects unrelated or invalid targets", async () => {
    const app = createApp(chat);
    const original = String(chat.conversation.id);
    expect((await app.request(url(), post(change))).status).toBe(200);
    const fork = await chat.chats.fork(original, crypto.randomUUID(), String(entryId));
    expect(FeedbackViewSchema.parse(await (await app.request(url(fork.id))).json())).toMatchObject({
      revision: 0,
      value: null,
    });
    expect(
      (
        await app.request(
          url(fork.id),
          post({ ...change, requestId: "fork-vote", value: { vote: "unhelpful", comment: null } }),
        )
      ).status,
    ).toBe(200);
    expect(FeedbackViewSchema.parse(await (await app.request(url())).json()).value?.vote).toBe(
      "helpful",
    );
    const other = await chat.chats.create(crypto.randomUUID());
    expect((await app.request(url(other.id))).status).toBe(404);
    expect((await app.request(url(original, entryId, 1))).status).toBe(404);
    expect((await app.request(url(original, 999999))).status).toBe(404);
    const entries = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const user = entries.items.find((entry) => entry.kind === "pi.user")!;
    expect((await app.request(url(original, user.id))).status).toBe(404);
  });

  it("allows archived reads but refuses mutations and deleted chats", async () => {
    const app = createApp(chat);
    expect((await app.request(url(), post(change))).status).toBe(200);
    const id = String(chat.conversation.id);
    await chat.chats.change(id, "archive");
    expect(FeedbackViewSchema.parse(await (await app.request(url())).json()).readOnly).toBe(true);
    expect(
      (await app.request(url(), post({ requestId: "new", expectedRevision: 1, value: null })))
        .status,
    ).toBe(409);
    await chat.chats.change(id, "delete");
    expect((await app.request(url())).status).toBe(404);
  });
  it("rejects a committed tool-only assistant entry and never accepts a live identifier", async () => {
    const app = createApp(chat);
    await chat.conversation.submit({ type: "input", content: "Tool round" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.tools([{ id: "call", name: "unavailable_test_tool", arguments: {} }]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
    const entries = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const toolOnly = entries.items.find(
      (entry) =>
        entry.kind === "pi.assistant" &&
        entry.model?.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((part) => part.type === "toolCall"),
        ),
    );
    expect(toolOnly).toBeDefined();
    expect((await app.request(url(String(chat.conversation.id), toolOnly!.id))).status).toBe(404);
    expect(
      (
        await app.request(
          `http://localhost:3000/api/chats/${chat.conversation.id}/feedback/generation:1/0`,
        )
      ).status,
    ).toBe(404);
    provider.calls[2]!.finish("After tool");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
});
