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
