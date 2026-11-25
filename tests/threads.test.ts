import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import {
  CreateThreadResponseSchema,
  ThreadListSchema,
  ThreadSourceResponseSchema,
} from "../src/shared/threads.ts";
import { testModels } from "./models.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cpd-threads-"));
  roots.push(root);
  const provider = testModels();
  const chat = await openChat(join(root, "data"), provider.models, root, {
    tangentPolicy: () => ({
      resolveModel: async () => ({
        selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
        revision: 1,
        assignment: "tangent",
      }),
      assertResolvedModel: async () => {},
    }),
  });
  const app = createApp(chat);
  const main = String(chat.conversation.id);
  const base = `http://localhost:3000/api/chats/${main}/threads`;
  const get = (url: string) => app.request(url);
  const post = (url: string, data: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  /** A real turn: the saved entries are produced by an actual model run. */
  async function turn(question: string, answer: string) {
    const before = provider.calls.length;
    await chat.conversation.submit({ type: "input", content: question }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls.length).toBe(before + 1));
    provider.calls[before]!.finish(answer);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  }
  async function saved(text: string) {
    const page = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const entry = page.items.find((item) =>
      (item.model ?? []).some((message) => {
        const content = message.content;
        const parts =
          typeof content === "string"
            ? [content]
            : content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        return parts.some((part) => part === text);
      }),
    );
    if (!entry) throw new Error("Seeded entry missing");
    return String(entry.id);
  }
  return { root, chat, provider, app, main, base, get, post, turn, saved };
}

describe("message threads", () => {
  it("forks the exact saved message with the tangent model and admits the first reply", async () => {
    const f = await setup();
    try {
      await f.turn("Earlier question", "Selected answer");
      await f.turn("Later turn", "Later answer");
      const source = await f.saved("Selected answer");
      const later = await f.saved("Later answer");
      expect(f.provider.calls).toHaveLength(2);

      const created = CreateThreadResponseSchema.parse(
        await (
          await f.post(f.base, {
            requestId: "first-thread",
            parentId: f.main,
            sourceEntryId: source,
            text: "How does this work?",
          })
        ).json(),
      );
      expect(created.admitted).toBe(true);
      expect(created.thread).toMatchObject({
        parentId: f.main,
        sourceEntryId: source,
        replyCount: 1,
        activity: "running",
      });
      expect(created.thread.slug.startsWith(`${created.thread.id}-`)).toBe(true);
      expect(created.thread.source).toMatchObject({ role: "assistant", text: "Selected answer" });

      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
      const request = JSON.stringify(f.provider.calls[2]!.context.messages);
      expect(request).toContain("Earlier question");
      expect(request).toContain("Selected answer");
      expect(request).toContain("How does this work?");
      expect(request).not.toContain("Later turn");
      expect(request).not.toContain("Later answer");
      f.provider.calls[2]!.finish("Thread answer");

      const scoped = (await f.chat.chats.resolve(created.thread.id))!;
      expect((await scoped.conversation.agent(BACKGROUND_CONTEXT)).model).toMatchObject({
        provider: PROVIDER_ID,
        modelId: MODEL_ID,
      });
      // Inherited history stops at the selected entry; the later turn is excluded.
      const inherited = (
        await scoped.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)
      ).items.map((entry) => String(entry.id));
      expect(inherited).toContain(source);
      expect(inherited).not.toContain(later);
      // A thread is not a sidebar chat.
      expect((await f.chat.chats.list()).chats.some((item) => item.id === created.thread.id)).toBe(
        false,
      );

      const list = ThreadListSchema.parse(await (await f.get(f.base)).json());
      expect(list.threads).toHaveLength(1);
      expect(list.threads[0]!.sourceEntryId).toBe(source);

      const preview = ThreadSourceResponseSchema.parse(
        await (await f.get(`${f.base}/source/${source}`)).json(),
      );
      expect(preview.source).toMatchObject({ entryId: source, text: "Selected answer" });
    } finally {
      await f.chat.close();
    }
  });

  it("retries the same identity without forking again or replaying the reply", async () => {
    const f = await setup();
    try {
      await f.turn("Question", "Answer");
      const source = await f.saved("Answer");
      const body = {
        requestId: "retry-thread",
        parentId: f.main,
        sourceEntryId: source,
        text: "Same reply",
        quote: "Answer",
      };
      const first = CreateThreadResponseSchema.parse(await (await f.post(f.base, body)).json());
      const second = CreateThreadResponseSchema.parse(await (await f.post(f.base, body)).json());
      expect(second.thread.id).toBe(first.thread.id);
      expect((await f.post(f.base, { ...body, quote: "Changed selection" })).status).toBe(409);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      expect(JSON.stringify(f.provider.calls[1]!.context.messages)).toContain(
        JSON.stringify("> Answer\n\nSame reply"),
      );
      f.provider.calls[1]!.finish("Thread answer");
      expect((await f.chat.chats.list()).chats).toHaveLength(1);
      await vi.waitFor(async () => {
        const list = ThreadListSchema.parse(await (await f.get(f.base)).json());
        expect(list.threads[0]!.replyCount).toBe(1);
      });
    } finally {
      await f.chat.close();
    }
  });

  it("refuses a second thread for the same saved message", async () => {
    const f = await setup();
    try {
      await f.turn("Question", "Answer");
      const source = await f.saved("Answer");
      const created = CreateThreadResponseSchema.parse(
        await (
          await f.post(f.base, {
            requestId: "one-thread",
            parentId: f.main,
            sourceEntryId: source,
            text: "First reply",
          })
        ).json(),
      );
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.finish("Thread answer");
      const createdScope = (await f.chat.chats.resolve(created.thread.id))!;
      await createdScope.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const duplicate = await f.post(f.base, {
        requestId: "another-thread",
        parentId: f.main,
        sourceEntryId: source,
        text: "Second reply",
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ existingThreadId: created.thread.id });
      const mismatched = await f.post(f.base, {
        requestId: "one-thread",
        parentId: f.main,
        sourceEntryId: source,
        text: "Changed reply",
      });
      expect(mismatched.status).toBe(409);
      expect(f.provider.calls).toHaveLength(2);
      const list = ThreadListSchema.parse(await (await f.get(f.base)).json());
      expect(list.threads).toHaveLength(1);
    } finally {
      await f.chat.close();
    }
  });

  it("rejects unknown entries and read-only parents without forking", async () => {
    const f = await setup();
    try {
      await f.turn("Question", "Answer");
      const source = await f.saved("Answer");
      const unknown = await f.post(f.base, {
        requestId: "unknown-entry",
        parentId: f.main,
        sourceEntryId: "999999",
        text: "Reply",
      });
      expect(unknown.status).toBe(409);
      const wrongParent = await f.post(f.base, {
        requestId: "wrong-parent",
        parentId: "999999",
        sourceEntryId: source,
        text: "Reply",
      });
      expect(wrongParent.status).toBe(400);
      expect(f.provider.calls).toHaveLength(1);
      expect((await f.chat.chats.list()).chats).toHaveLength(1);
    } finally {
      await f.chat.close();
    }
  });
});
