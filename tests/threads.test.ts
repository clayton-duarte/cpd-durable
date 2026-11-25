import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
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
  it("applies a tier save to an existing main and thread without rerunning either", async () => {
    const f = await setup();
    try {
      await f.turn("Main task", "Shared source");
      const source = await f.saved("Shared source");
      const created = CreateThreadResponseSchema.parse(
        await (
          await f.post(f.base, {
            requestId: "retier-thread",
            parentId: f.main,
            sourceEntryId: source,
            text: "Thread work",
          })
        ).json(),
      ).thread;
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      const child = (await f.chat.chats.resolve(created.id))!.conversation;
      const state = await f.chat.modelPolicy.read();
      const [main, tangent] = state.choices.filter((choice) => choice.modelId !== MODEL_ID);
      if (!main || !tangent) throw new Error("Need two alternate mock models");
      const next = (model: typeof main) => ({
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevels[0]!,
      });
      const response = await f.post("http://localhost:3000/api/model-policy", {
        expected: { revision: state.revision, assignments: state.assignments },
        assignments: { main: next(main), tangent: next(tangent), worker: null },
      });
      expect(response.status).toBe(200);
      expect(f.provider.calls.map((call) => call.modelId)).toEqual([MODEL_ID, MODEL_ID]);
      f.provider.calls[1]!.finish("Original thread reply");
      await child.waitForIdle(BACKGROUND_CONTEXT);
      await f.turn("Follow up in main", "Follow-up reply");
      await child.submit({ type: "input", content: "Follow up in the thread" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(4));
      expect(f.provider.calls.map((call) => call.modelId)).toEqual([
        MODEL_ID,
        MODEL_ID,
        main.modelId,
        tangent.modelId,
      ]);
      f.provider.calls[3]!.finish("Follow-up thread reply");
      await child.waitForIdle(BACKGROUND_CONTEXT);
      const fork = await f.chat.chats.fork(f.main, "retier-fork", source);
      const forkConfig = await (await f.chat.chats.resolve(fork.id))!.configuration();
      expect(forkConfig.selection).toEqual(next(main));
    } finally {
      await f.chat.close();
    }
  });

  it("orients both agents without waking the parent, and exposes owned thread evidence on demand", async () => {
    const f = await setup();
    function scope(context: TranscriptContext) {
      return context.messages
        .flatMap((message) =>
          message.role === "system" && typeof message.sections?.["conversation-scope"] === "string"
            ? [message.sections["conversation-scope"]]
            : [],
        )
        .at(-1);
    }
    try {
      await f.turn("Main task", "Shared source");
      expect(scope(f.provider.calls[0]!.context)).toContain('"threadCount":0');
      const source = await f.saved("Shared source");
      const created = CreateThreadResponseSchema.parse(
        await (
          await f.post(f.base, {
            requestId: "aware-thread",
            parentId: f.main,
            sourceEntryId: source,
            quote: "Shared source",
            text: "Investigate only the tangent",
          })
        ).json(),
      ).thread;
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      const childScope = scope(f.provider.calls[1]!.context);
      expect(childScope).toContain(`"role":"thread","id":"${created.id}"`);
      expect(childScope).toContain(`"fork":{"conversationId":${f.main},"at":${source}}`);
      expect(childScope).toContain('"taskOwner":null');
      expect(childScope).toContain('"focusExcerpt":"Investigate only the tangent"');
      expect(childScope).toContain("Use inherited history only as background");
      expect(childScope).not.toContain('"threadCount"');
      f.provider.calls[1]!.finish("The tangent found its own answer.");
      const child = (await f.chat.chats.resolve(created.id))!.conversation;
      await child.waitForIdle(BACKGROUND_CONTEXT);
      expect(f.provider.calls).toHaveLength(2);

      await f.chat.conversation.submit(
        { type: "input", content: "What have the threads addressed?" },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
      const parent = f.provider.calls[2]!;
      expect(scope(parent.context)).toContain('"threadCount":1');
      expect(scope(parent.context)).toContain(`"sourceEntryId":"${source}"`);
      expect(JSON.stringify(parent.context.messages)).not.toContain("The tangent found");
      parent.tools([
        { id: "list", name: "inspect_threads", arguments: {} },
        { id: "check", name: "inspect_threads", arguments: { threadId: created.id } },
        { id: "wrong", name: "inspect_threads", arguments: { threadId: f.main } },
      ]);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(4));
      const next = f.provider.calls[3]!;
      const results = JSON.stringify(
        next.context.messages.filter((message) => message.role === "toolResult"),
      );
      expect(results).toContain('\\\"activity\\\":\\\"idle\\\"');
      expect(results).toContain("Shared source");
      expect(results).toContain("The tangent found its own answer.");
      expect(results).toContain("not tracked");
      expect(results).toContain("That thread is not owned by this chat.");
      next.finish("One idle thread; completion is not tracked.");
      await f.chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await f.chat.close();
    }
  });

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
