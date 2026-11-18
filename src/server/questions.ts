import type { JsonRepresentation } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type ConversationId,
  type Conversation,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  normalizeResolution,
  QuestionSpecSchema,
  QuestionViewSchema,
  type QuestionSpec,
  type QuestionView,
  type Resolution,
} from "../shared/questions.ts";

type Question = {
  questionId: string;
  taskId: number;
  revision: number;
  spec: QuestionSpec;
  status: "pending" | "answered" | "declined";
  resolution?: Resolution;
};
type QuestionState = { questions: Question[] };
// No actionable state is inherited by forks, even when the fork includes the originating tool call.
export const QuestionsDoc = defineDoc<JsonRepresentation<QuestionState>>({
  kind: "cpd.questions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ questions: [] }),
  checkpointWhen: () => true,
});

// The polling projection reads only pending questions, not the retained retry records.
// A stopped task is removed from this index when next observed; its historical record remains.
export const PendingQuestionsDoc = defineDoc<JsonRepresentation<QuestionState>>({
  kind: "cpd.questions.pending",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ questions: [] }),
  checkpointWhen: () => true,
});

/** Must check existence, archive/delete and read-only policy atomically in this transaction.
 * The host must supply this guard; a prior asynchronous catalog check is insufficient. */
export type QuestionAccessGuard = (
  tx: Tx,
  conversationId: ConversationId,
  action: "read" | "resolve",
) => Promise<void>;

function live(task: Awaited<ReturnType<Tx["task"]>>, conversationId: ConversationId): boolean {
  return (
    !!task &&
    task.conversationId === conversationId &&
    !task.abortRequested &&
    task.state.status !== "terminal" &&
    task.state.status !== "completing"
  );
}

/** Read through the lifecycle guard; no model invocation or chat input is admitted. */
export async function readQuestions(
  harness: Pick<Conversation, "commit">,
  conversationId: ConversationId,
  guard: QuestionAccessGuard,
  context: Context = BACKGROUND_CONTEXT,
): Promise<QuestionView[]> {
  return harness.commit(async (tx) => {
    await guard(tx, conversationId, "read");
    const state = await tx.doc(PendingQuestionsDoc, conversationId);
    const result: QuestionView[] = [];
    const cancelled: string[] = [];
    for (const item of state.questions) {
      const active =
        item.status === "pending" && live(await tx.task(item.taskId as TaskId), conversationId);
      // Parse inside the transaction to detach nested SDK draft proxies before commit settles.
      result.push(
        QuestionViewSchema.parse({
          ...item,
          actionable: active,
          cancelled: item.status === "pending" && !active,
        }),
      );
      if (!active) cancelled.push(item.questionId);
    }
    // GET may initialize or update SDK metadata, but does not submit work or call a provider.
    if (cancelled.length > 0)
      state.questions = state.questions.filter((item) => !cancelled.includes(item.questionId));
    return result;
  }, context);
}

/** First writer wins. A retry is identical only for the original pending revision and normalized resolution. */
export async function resolveQuestion(
  harness: Pick<Conversation, "commit">,
  conversationId: ConversationId,
  questionId: string,
  taskId: number,
  revision: number,
  input: unknown,
  guard: QuestionAccessGuard,
  context: Context = BACKGROUND_CONTEXT,
): Promise<"resolved" | "already-resolved"> {
  if (
    !Number.isSafeInteger(taskId) ||
    taskId < 1 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    questionId !== `q-${taskId}`
  )
    throw new Error("Invalid question identity");
  return harness.commit(async (tx) => {
    await guard(tx, conversationId, "resolve");
    const task = await tx.task(taskId as TaskId);
    const state = await tx.doc(QuestionsDoc, conversationId);
    const question = state.questions.find(
      (item) => item.questionId === questionId && item.taskId === taskId,
    );
    if (!question) throw new Error("Question not found");
    const resolution = normalizeResolution(QuestionSpecSchema.parse(question.spec), input);
    if (question.status !== "pending") {
      if (
        revision === question.revision - 1 &&
        JSON.stringify(question.resolution) === JSON.stringify(resolution)
      )
        return "already-resolved";
      throw new Error("Question already resolved or stale revision");
    }
    if (revision !== question.revision) throw new Error("Stale question revision");
    if (!live(task, conversationId)) throw new Error("Question is no longer actionable");
    const pending = await tx.doc(PendingQuestionsDoc, conversationId);
    question.status = resolution.kind === "answer" ? "answered" : "declined";
    question.resolution = resolution;
    question.revision++;
    pending.questions = pending.questions.filter((item) => item.questionId !== questionId);
    return "resolved";
  }, context);
}

/** A safe replay reuses the same task ID and its existing durable request. */
export function createQuestionExtension() {
  return defineExtension({
    name: "cpd-questions",
    tools: [
      defineTool({
        name: "ask_user",
        description:
          "Ask the user for structured input; use when an answer is needed. This is not a tool permission request.",
        parameters: z.toJSONSchema(QuestionSpecSchema),
        replay: "safe",
        async execute(args, api, context) {
          const spec = JSON.parse(
            JSON.stringify(QuestionSpecSchema.parse(args)),
          ) as JsonRepresentation<QuestionSpec>;
          const questionId = `q-${api.taskId}`;
          await api.commit(async (tx) => {
            const state = await tx.doc(QuestionsDoc, api.conversationId);
            if (!state.questions.some((q) => q.questionId === questionId)) {
              const question = {
                questionId,
                taskId: api.taskId,
                revision: 1,
                spec,
                status: "pending" as const,
              };
              state.questions.push(question);
              (await tx.doc(PendingQuestionsDoc, api.conversationId)).questions.push(question);
            }
          }, context);
          const watch = await api.watchDoc(QuestionsDoc, api.conversationId, context);
          if (!watch) throw new Error("Question state unavailable");
          try {
            const resolution = await new Promise<Resolution>((resolve, reject) => {
              const accept = (state: Readonly<QuestionState>) => {
                const item = state.questions.find(
                  (q) => q.questionId === questionId && q.taskId === api.taskId,
                );
                if (!item) reject(new Error("Question disappeared"));
                else if (item.resolution) resolve(item.resolution);
              };
              watch.start(async (call) => {
                if (call.kind === "failed") reject(call.error);
                else accept(call.value);
              });
              accept(watch.value);
              void watch.closed.then((end) =>
                reject(new Error(`Question watch ended: ${end.kind}`)),
              );
            });
            return { output: [{ type: "text", text: JSON.stringify(resolution) }] };
          } finally {
            await watch.stop();
          }
        },
      }),
    ],
  });
}
