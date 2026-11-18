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
  model: { provider: string; modelId: string } | null;
  receipt: { status: "success" | "failure" | "cancelled"; answerEntryId: number | null } | null;
};
export type WorkerAgentSelection = {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: NonNullable<Awaited<ReturnType<Conversation["agent"]>>["thinkingLevel"]> | null;
  cwd: string | null;
};
/** Host-provided, synchronous policy: no implicit provider/model fallback. */
export type WorkerModelResolver = (
  role: HelperLaunch["modelRole"],
  savedParent: Readonly<WorkerAgentSelection>,
) => {
  model: { provider: string; modelId: string };
  thinkingLevel: WorkerAgentSelection["thinkingLevel"];
};
type Input = { request: HelperLaunch; agent: WorkerAgentSelection };

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
          content: [
            `Assignment:\n${task.input.request.assignment}`,
            `Explicit context:\n${task.input.request.context}`,
            ...(task.input.request.brief
              ? [`Delegation metadata (version 1):\n${JSON.stringify(task.input.request.brief)}`]
              : []),
            "For code changes, work on a separate branch in a separate worktree; leave the primary checkout untouched. Do not discard or clean up others' work.",
          ].join("\n\n"),
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

/** The task is a conversation-owned background anchor; its child remains task-owned. */
export const BackgroundHelperTask = defineTask({
  ...ForegroundHelperTask.definition,
  name: "cpd.helper.background",
});

/** Install this extension into the host registry before opening/reopening the Harness. */
export const HelpersExtension = defineExtension({
  name: "cpd.helpers",
  tasks: [ForegroundHelperTask, BackgroundHelperTask],
});

/** Admission is atomic with the request identity and saved parent agent snapshot. */
export async function launchHelper(
  conversation: Conversation,
  raw: unknown,
  resolveWorkerModel: WorkerModelResolver,
) {
  const request = HelperLaunchSchema.parse(raw);
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(HelpersDoc, conversation.id);
    const prior = doc.items.find((item) => item.request.requestId === request.requestId);
    if (prior) {
      if (JSON.stringify(HelperLaunchSchema.parse(prior.request)) !== JSON.stringify(request))
        throw new Error("Helper request identity already used with different input");
      return String(prior.taskId);
    }
    const agent = await tx.doc(AgentDoc, conversation.id);
    const saved: WorkerAgentSelection = {
      model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
      thinkingLevel: agent.thinkingLevel ?? null,
      cwd: agent.cwd ?? null,
    };
    const chosen = resolveWorkerModel(request.modelRole, saved);
    if (!chosen.model.provider.trim() || !chosen.model.modelId.trim())
      throw new Error("Worker model policy did not select a model");
    const worker = { ...saved, model: chosen.model, thinkingLevel: chosen.thinkingLevel };
    const taskId = await tx.createTask(
      request.mode === "background" ? BackgroundHelperTask : ForegroundHelperTask,
      { request, agent: worker },
      { ownership: { kind: "conversation" }, background: request.mode === "background" },
    );
    doc.items.push({ request, taskId, childId: null, model: chosen.model, receipt: null });
    return String(taskId);
  }, BACKGROUND_CONTEXT);
}

/** Scope the explicit Stop to a recorded worker belonging to this conversation. */
export async function stopHelper(harness: Harness, conversation: Conversation, taskId: string) {
  const doc = await harness.snapshot(HelpersDoc, conversation.id, BACKGROUND_CONTEXT);
  const item = doc?.items.find((candidate) => String(candidate.taskId) === taskId);
  if (!item) return "not-found" as const;
  return harness.abortTask(item.taskId as TaskId, BACKGROUND_CONTEXT);
}

/** Explicitly cross background boundaries, unlike the ordinary parent Stop. */
export async function stopHelpersIncludingBackground(conversation: Conversation) {
  await conversation.abort(BACKGROUND_CONTEXT, { background: true });
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
        mode: item.request.mode,
        model: item.model ?? null,
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
