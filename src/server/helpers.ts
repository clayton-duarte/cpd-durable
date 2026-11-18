import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  type Conversation,
  type ConversationId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { HelperLaunchSchema, HelpersViewSchema, type HelperLaunch } from "../shared/helpers.ts";

type Item = {
  request: HelperLaunch;
  taskId: number;
  childId: number | null;
  receipt: { status: "success" | "failure" | "cancelled"; answerEntryId: number | null } | null;
};
type SavedAgent = {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: NonNullable<Awaited<ReturnType<Conversation["agent"]>>["thinkingLevel"]> | null;
  cwd: string | null;
};
type Input = { request: HelperLaunch; agent: SavedAgent };

export const HelpersDoc = defineDoc<{ items: Item[] }>({
  kind: "cpd.helpers",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export const ForegroundHelperTask = defineTask<Input, { phase: "run" }, null>({
  name: "cpd.helper.foreground",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      let childId: ConversationId | undefined;
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(HelpersDoc, runtime.conversationId);
        const item = doc.items.find((candidate) => candidate.taskId === task.id);
        if (!item) throw new Error("Helper launch record unavailable");
        if (item.childId !== null) {
          childId = item.childId as ConversationId;
          return;
        }
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
        await configure(tx, child.id, task.input.agent);
        item.childId = child.id;
        childId = child.id;
      }, context);
      if (childId === undefined) throw new Error("Helper child unavailable");
      const child = await runtime.conversation(childId, context);
      if (!child) throw new Error("Helper child unavailable");
      const submission = await child.submit(
        {
          type: "input",
          content: `Assignment:\n${task.input.request.assignment}\n\nExplicit context:\n${task.input.request.context}`,
          requestId: `cpd-helper:${task.id}`,
        },
        context,
      );
      const result = await submission.wait(context);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(HelpersDoc, runtime.conversationId);
        const item = doc.items.find((candidate) => candidate.taskId === task.id);
        if (!item) throw new Error("Helper launch record unavailable");
        item.receipt =
          result.status === "done" && result.answer !== undefined
            ? { status: "success", answerEntryId: result.answer }
            : {
                status: result.reason === "aborted" ? "cancelled" : "failure",
                answerEntryId: null,
              };
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(HelpersDoc, runtime.conversationId);
      const item = doc.items.find((candidate) => candidate.taskId === task.id);
      if (item && !item.receipt) item.receipt = { status: "cancelled", answerEntryId: null };
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

/** Install this extension into the host registry before opening/reopening the Harness. */
export const HelpersExtension = defineExtension({
  name: "cpd.helpers",
  tasks: [ForegroundHelperTask],
});

/** Admission is atomic with the request identity and saved parent agent snapshot. */
export async function launchHelper(conversation: Conversation, raw: unknown) {
  const request = HelperLaunchSchema.parse(raw);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(HelpersDoc, conversation.id);
    const prior = doc.items.find((item) => item.request.requestId === request.requestId);
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request))
        throw new Error("Helper request identity already used with different input");
      return String(prior.taskId);
    }
    const agent = await tx.doc(AgentDoc, conversation.id);
    const saved: SavedAgent = {
      model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
      thinkingLevel: agent.thinkingLevel ?? null,
      cwd: agent.cwd ?? null,
    };
    const taskId = await tx.createTask(
      ForegroundHelperTask,
      { request, agent: saved },
      { ownership: { kind: "conversation" } },
    );
    doc.items.push({ request, taskId, childId: null, receipt: null });
    return String(taskId);
  }, BACKGROUND_CONTEXT);
}

/** Call on the same SDK transaction as a catalog lifecycle decision. */
export async function helperHasUnsettled(tx: Tx, conversationId: ConversationId) {
  const doc = await tx.doc(HelpersDoc, conversationId);
  for (const item of doc.items) {
    const task = await tx.task(item.taskId as TaskId);
    if (!task || task.state.status !== "terminal") return true;
    if (!item.receipt && !["aborted", "failed", "faulted"].includes(task.state.outcome.status))
      return true;
  }
  return false;
}

/** Conservative projection: missing task records and outcomes stay unknown. */
export async function inspectHelpers(harness: Harness, conversation: Conversation) {
  const doc = await harness.snapshot(HelpersDoc, conversation.id, BACKGROUND_CONTEXT);
  const helpers = await Promise.all(
    (doc?.items ?? []).map(async (item) => {
      const task = await harness.getTask(item.taskId as TaskId, BACKGROUND_CONTEXT);
      let status: "pending" | "running" | "success" | "failure" | "cancelled" | "unknown" =
        "unknown";
      if (task?.state.status === "terminal") {
        if (item.receipt) status = item.receipt.status;
        else if (task.state.outcome.status === "aborted") status = "cancelled";
        else if (["failed", "faulted"].includes(task.state.outcome.status)) status = "failure";
      } else if (task) {
        status = task.state.status === "pending" ? "pending" : "running";
      }
      return {
        requestId: item.request.requestId,
        taskId: String(item.taskId),
        childId: item.childId === null ? null : String(item.childId),
        status,
        answerEntryId:
          status === "success" && item.receipt?.answerEntryId !== null
            ? String(item.receipt?.answerEntryId)
            : null,
        delivery: "notify-only" as const,
      };
    }),
  );
  return HelpersViewSchema.parse({
    helpers,
    hasUnsettled: helpers.some((item) => ["pending", "running", "unknown"].includes(item.status)),
  });
}
