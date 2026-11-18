import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentQuestion } from "../src/client/agent-question.tsx";
import { createApp } from "../src/server/app.ts";
import { answerQuestion, questionProjection } from "../src/server/question-routes.ts";
import { CatalogDoc, openChats } from "../src/server/chats.ts";
import { openChat } from "../src/server/chat.ts";
import {
  createQuestionExtension,
  readQuestions,
  resolveQuestion,
  type QuestionAccessGuard,
} from "../src/server/questions.ts";
import { normalizeResolution, QuestionSpecSchema } from "../src/shared/questions.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const spec = {
  message: "Choose",
  fields: [
    { kind: "text", id: "name", label: "Name", required: true },
    {
      kind: "choice",
      id: "color",
      label: "Color",
      options: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
      default: "red",
    },
    {
      kind: "multi",
      id: "extras",
      label: "Extras",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  ],
};
const answer = { kind: "answer", values: { name: "Ada", extras: ["b", "a"] } };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "question-test-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const provider = testModels();
  const registry = createRegistry();
  registry.install(createQuestionExtension());
  const open = async () =>
    Harness.open(await openNodeSqliteStorage(path), { models: provider.models, registry }, context);
  const harness = await open();
  const chat = await harness.root(context, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
  });
  let mode: "active" | "archived" | "deleted" | "readonly" = "active";
  const guard: QuestionAccessGuard = async (tx: Tx, id: ConversationId, action) => {
    if (
      !(await tx.conversation(id)) ||
      mode === "deleted" ||
      (action === "resolve" && mode !== "active")
    )
      throw new Error("Unavailable chat");
  };
  async function ask() {
    await chat.submit({ type: "input", content: "ask" }, context);
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(0));
    provider.calls.at(-1)!.tools([{ id: "call", name: "ask_user", arguments: spec }]);
    await vi.waitFor(async () =>
      expect((await readQuestions(harness, chat.id, guard)).some((q) => q.actionable)).toBe(true),
    );
    return (await readQuestions(harness, chat.id, guard)).find((q) => q.actionable)!;
  }
  return {
    root,
    path,
    provider,
    registry,
    open,
    harness,
    chat,
    guard,
    ask,
    setMode: (m: typeof mode) => {
      mode = m;
    },
  };
}

describe("structured questions", () => {
  it("polls every outstanding question without returning resolved history", async () => {
    const f = await fixture();
    try {
      await f.chat.submit({ type: "input", content: "two questions" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1));
      f.provider.calls[0]!.tools([
        { id: "first", name: "ask_user", arguments: spec },
        { id: "second", name: "ask_user", arguments: spec },
      ]);
      await vi.waitFor(async () =>
        expect(
          (await readQuestions(f.harness, f.chat.id, f.guard)).filter((q) => q.actionable),
        ).toHaveLength(2),
      );
      const first = (await readQuestions(f.harness, f.chat.id, f.guard))[0]!;
      await resolveQuestion(
        f.harness,
        f.chat.id,
        first.questionId,
        first.taskId,
        first.revision,
        answer,
        f.guard,
      );
      const remaining = await readQuestions(f.harness, f.chat.id, f.guard);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.questionId).not.toBe(first.questionId);
      await resolveQuestion(
        f.harness,
        f.chat.id,
        remaining[0]!.questionId,
        remaining[0]!.taskId,
        remaining[0]!.revision,
        { kind: "decline" },
        f.guard,
      );
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.finish("done");
      await f.chat.waitForIdle(context);
      expect(await readQuestions(f.harness, f.chat.id, f.guard)).toEqual([]);
    } finally {
      await f.harness.close(context);
    }
  });
  it("uses the production host registry, real Hono routes and provider continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "question-host-"));
    roots.push(root);
    const provider = testModels();
    const chat = await openChat(join(root, "data"), provider.models, root);
    const app = createApp(chat);
    const base = `http://localhost:3000/api/chats/${chat.conversation.id}`;
    const input = (text: string) =>
      app.request(`${base}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, requestId: crypto.randomUUID() }),
      });
    const resolve = (body: unknown) =>
      app.request(`${base}/questions/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      expect((await chat.conversation.agent(context)).tools.map((tool) => tool.name)).toContain(
        "ask_user",
      );
      expect((await app.request(`${base}/questions`)).status).toBe(200);
      expect(provider.calls).toHaveLength(0);
      expect((await input("Synthetic request")).status).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "actual-host-question", name: "ask_user", arguments: spec }]);
      let q: { questionId: string; taskId: number; revision: number } | undefined;
      await vi.waitFor(async () => {
        const response = await app.request(`${base}/questions`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { conversationId: string; questions: (typeof q)[] };
        expect(body.conversationId).toBe(String(chat.conversation.id));
        q = body.questions[0];
        expect(q).toBeDefined();
      });
      const question = q!;
      expect(question.questionId).toBe(`q-${question.taskId}`);
      expect(question.revision).toBe(1);
      const payload = {
        questionId: question.questionId,
        taskId: question.taskId,
        revision: question.revision,
        resolution: answer,
      };
      expect((await resolve(payload)).status).toBe(200);
      expect((await resolve(payload)).status).toBe(200);
      expect((await resolve({ ...payload, resolution: { kind: "decline" } })).status).toBe(409);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const messages = provider.calls[1]!.context.messages;
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain("Ada");
      expect(
        ((await (await app.request(`${base}/questions`)).json()) as { questions: unknown[] })
          .questions,
      ).toEqual([]);
      provider.calls[1]!.finish("finished");
      await chat.conversation.waitForIdle(context);
      expect((await input("Another synthetic request")).status).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
      provider.calls[2]!.tools([{ id: "second-host-question", name: "ask_user", arguments: spec }]);
      let second: typeof question | undefined;
      await vi.waitFor(async () => {
        second = (
          (await (await app.request(`${base}/questions`)).json()) as {
            questions: (typeof second)[];
          }
        ).questions[0];
        expect(second).toBeDefined();
      });
      expect((await app.request(`${base}/stop`, { method: "POST" })).status).toBe(204);
      expect(
        (
          await resolve({
            questionId: second!.questionId,
            taskId: second!.taskId,
            revision: second!.revision,
            resolution: { kind: "decline" },
          })
        ).status,
      ).toBe(409);
      const cancelled = (await (await app.request(`${base}/questions`)).json()) as {
        questions: { cancelled: boolean; status: string }[];
      };
      expect(cancelled.questions[0]).toMatchObject({ cancelled: true, status: "pending" });
      expect(provider.calls).toHaveLength(3);
    } finally {
      await chat.close();
    }
  });
  it("guards scoped HTTP reads and answers through the real catalog transaction", async () => {
    const f = await fixture();
    try {
      const chats = await openChats(
        f.harness,
        f.chat,
        {
          model: { provider: PROVIDER_ID, modelId: MODEL_ID },
        },
        f.provider.models,
      );
      const app = createApp({
        conversation: f.chat,
        chats,
        withdraw: (id) => f.harness.abortSubmission(id, context, f.chat.id),
      });
      const q = await f.ask();
      const base = `http://localhost:3000/api/chats/${f.chat.id}/questions`;
      const get = () => app.request(base);
      const post = (body: unknown) =>
        app.request(`${base}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const payload = {
        questionId: q.questionId,
        taskId: q.taskId,
        revision: q.revision,
        resolution: answer,
      };
      const capturedScope = (await chats.resolve(String(f.chat.id)))!;
      await questionProjection(capturedScope);
      const second = await chats.create(crypto.randomUUID());
      const wrongChat = await app.request(
        `http://localhost:3000/api/chats/${second.id}/questions/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      expect(wrongChat.status).toBe(409);
      const read = await get();
      expect(read.status).toBe(200);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(
        ((await read.json()) as { questions: { actionable: boolean }[] }).questions[0]?.actionable,
      ).toBe(true);
      expect(f.provider.calls).toHaveLength(1);
      expect(
        (await app.request(base, { headers: { origin: "http://foreign.invalid" } })).status,
      ).toBe(403);
      expect(
        (await app.request(base, { headers: { "sec-fetch-site": "cross-site" } })).status,
      ).toBe(403);
      expect((await app.request(base, { headers: { host: "foreign.invalid" } })).status).toBe(403);
      expect((await post({ ...payload, taskId: q.taskId + 1 })).status).toBe(409);
      expect((await post({ ...payload, unexpected: true })).status).toBe(400);
      await f.harness.commit(async (tx) => {
        const item = (await tx.doc(CatalogDoc)).items.find((item) => item.id === f.chat.id)!;
        item.status = "archived";
      }, context);
      const archived = await get();
      expect(archived.status).toBe(200);
      expect(
        ((await archived.json()) as { questions: { actionable: boolean }[] }).questions[0]
          ?.actionable,
      ).toBe(false);
      expect((await post(payload)).status).toBe(409);
      // A previously captured active scope must not bypass the catalog check at commit time.
      await expect(answerQuestion(capturedScope, payload)).rejects.toThrow("archived");
      await f.harness.commit(async (tx) => {
        const item = (await tx.doc(CatalogDoc)).items.find((item) => item.id === f.chat.id)!;
        delete item.status;
      }, context);
      expect((await post(payload)).status).toBe(200);
      expect((await post(payload)).status).toBe(200);
      expect((await post({ ...payload, resolution: { kind: "decline" } })).status).toBe(409);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.finish("done");
      await f.chat.waitForIdle(context);
      await f.harness.commit(async (tx) => {
        (await tx.doc(CatalogDoc)).items.find((item) => item.id === f.chat.id)!.status = "deleted";
      }, context);
      expect((await get()).status).toBe(404);
    } finally {
      await f.harness.close(context);
    }
  });
  it("renders validated question fields through ElicitationForm without raw HTML", () => {
    const view = {
      questionId: "q-1",
      taskId: 1,
      revision: 1,
      spec: { ...spec, message: "<script>unsafe</script>" },
      status: "pending",
      actionable: true,
      cancelled: false,
    };
    const render = (question: unknown) =>
      renderToStaticMarkup(createElement(AgentQuestion, { question, onResolve: async () => {} }));
    const html = render(view);
    expect(html).toContain('data-slot="elicitation-form"');
    expect(html).toContain("Red (red)");
    expect(html).toContain("Extras: A");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(render({ ...view, taskId: 2 })).toBe("");
    expect(render({ ...view, actionable: false, cancelled: true })).toBe("");
  });
  it("validates finite fields, defaults, duplicates, required and unknown answers", () => {
    const parsed = QuestionSpecSchema.parse(spec);
    expect(normalizeResolution(parsed, answer)).toEqual({
      kind: "answer",
      values: { name: "Ada", color: "red", extras: ["a", "b"] },
    });
    expect(() => normalizeResolution(parsed, { kind: "answer", values: { name: "" } })).toThrow();
    expect(() =>
      normalizeResolution(parsed, { kind: "answer", values: { name: "x", extra: "y" } }),
    ).toThrow();
    expect(() =>
      normalizeResolution(parsed, { kind: "answer", values: { name: "x", extras: ["a", "a"] } }),
    ).toThrow();
    expect(() =>
      QuestionSpecSchema.parse({ message: "x", fields: [{ kind: "html", id: "x", label: "x" }] }),
    ).toThrow();
    expect(() =>
      QuestionSpecSchema.parse({ message: "x", fields: [spec.fields[0], spec.fields[0]] }),
    ).toThrow();
    const optional = QuestionSpecSchema.parse({
      message: "Optional",
      fields: [
        { kind: "text", id: "constructor", label: "Optional" },
        { kind: "multi", id: "items", label: "Items", options: [{ id: "a", label: "A" }] },
      ],
    });
    expect(normalizeResolution(optional, { kind: "answer", values: {} })).toEqual({
      kind: "answer",
      values: {},
    });
    expect(
      normalizeResolution(optional, { kind: "answer", values: { constructor: "", items: [] } }),
    ).toEqual({ kind: "answer", values: { constructor: "", items: [] } });
  });
  it("waits for atomic answer, supports identical retry, rejects conflicts/stale and wrong chat", async () => {
    const f = await fixture();
    try {
      const q = await f.ask();
      expect(f.provider.calls).toHaveLength(1);
      await readQuestions(f.harness, f.chat.id, f.guard);
      expect(f.provider.calls).toHaveLength(1);
      const other = await f.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      await expect(
        resolveQuestion(f.harness, other.id, q.questionId, q.taskId, q.revision, answer, f.guard),
      ).rejects.toThrow();
      await expect(
        resolveQuestion(f.harness, f.chat.id, q.questionId, q.taskId, 9, answer, f.guard),
      ).rejects.toThrow("Stale");
      await expect(
        resolveQuestion(
          f.harness,
          f.chat.id,
          q.questionId,
          q.taskId,
          q.revision,
          { kind: "answer", values: { name: "Ada", color: "not-a-choice" } },
          f.guard,
        ),
      ).rejects.toThrow();
      expect((await readQuestions(f.harness, f.chat.id, f.guard))[0]?.actionable).toBe(true);
      const results = await Promise.allSettled([
        resolveQuestion(f.harness, f.chat.id, q.questionId, q.taskId, q.revision, answer, f.guard),
        resolveQuestion(
          f.harness,
          f.chat.id,
          q.questionId,
          q.taskId,
          q.revision,
          { kind: "decline" },
          f.guard,
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const winner = results[0]?.status === "fulfilled" ? answer : { kind: "decline" };
      expect(
        await resolveQuestion(
          f.harness,
          f.chat.id,
          q.questionId,
          q.taskId,
          q.revision,
          winner,
          f.guard,
        ),
      ).toBe("already-resolved");
      await expect(
        resolveQuestion(
          f.harness,
          f.chat.id,
          q.questionId,
          q.taskId,
          q.revision + 1,
          winner,
          f.guard,
        ),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      expect(JSON.stringify(f.provider.calls[1]!.context.messages)).toContain(
        winner.kind === "answer" ? "Ada" : "decline",
      );
      f.provider.calls[1]!.finish("done");
      await f.chat.waitForIdle(context);
    } finally {
      await f.harness.close(context);
    }
  });
  it("rejects archived/deleted/read-only actions; stop invalidates pending without declining", async () => {
    const f = await fixture();
    try {
      const q = await f.ask();
      for (const mode of ["archived", "deleted", "readonly"] as const) {
        f.setMode(mode);
        await expect(
          resolveQuestion(
            f.harness,
            f.chat.id,
            q.questionId,
            q.taskId,
            q.revision,
            answer,
            f.guard,
          ),
        ).rejects.toThrow();
      }
      f.setMode("active");
      await f.chat.abort(context);
      const current = (await readQuestions(f.harness, f.chat.id, f.guard))[0]!;
      expect(current.cancelled).toBe(true);
      expect(current.status).toBe("pending");
      await expect(
        resolveQuestion(f.harness, f.chat.id, q.questionId, q.taskId, q.revision, answer, f.guard),
      ).rejects.toThrow("no longer actionable");
    } finally {
      await f.harness.close(context);
    }
  });
  it("reattaches on restart and forks do not inherit actionable questions", async () => {
    const f = await fixture();
    let harness = f.harness;
    try {
      const q = await f.ask();
      const entries = await f.chat.entries({ order: "ascending" }, 100, undefined, context);
      const at = entries.items.at(-1)!.id;
      const fork = await f.chat.fork(at, { ownership: { kind: "ownerless" } }, context);
      expect(await readQuestions(harness, fork.id, f.guard)).toEqual([]);
      await harness.close(context);
      harness = await f.open();
      harness.resume();
      await vi.waitFor(async () =>
        expect(
          (await readQuestions(harness, f.chat.id, f.guard)).filter((x) => x.actionable),
        ).toHaveLength(1),
      );
      const restored = (await readQuestions(harness, f.chat.id, f.guard))[0]!;
      expect(restored.questionId).toBe(q.questionId);
      expect(
        await resolveQuestion(
          harness,
          f.chat.id,
          q.questionId,
          q.taskId,
          q.revision,
          { kind: "decline" },
          f.guard,
        ),
      ).toBe("resolved");
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.finish("done");
      await (await harness.conversation(f.chat.id, context))!.waitForIdle(context);
    } finally {
      await harness.close(context);
    }
  });
});
