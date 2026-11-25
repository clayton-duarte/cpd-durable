import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  HelperLaunchSchema,
  HelperResultSchema,
  HelpersViewSchema,
  WorkerStopSchema,
  type HelperLaunch,
} from "../shared/helpers.ts";
import type { Selection } from "../shared/configuration.ts";
import type { Assignments } from "../shared/model-policy.ts";
import { modelChange } from "./configuration.ts";

type Item = {
  request: HelperLaunch;
  taskId: number;
  childId: number | null;
  model: { provider: string; modelId: string } | null;
  pendingSelection?: Selection;
  receipt: { status: "success" | "failure" | "cancelled"; answerEntryId: number | null } | null;
};
export type WorkerAgentSelection = {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: NonNullable<Awaited<ReturnType<Conversation["agent"]>>["thinkingLevel"]> | null;
  cwd: string | null;
};
export type ResolvedWorkerModel = {
  selection: Selection;
  revision: number;
  assignment: "main" | "tangent" | "worker";
};
export type WorkerDependencies = {
  resolveModelForRole(
    role: "worker",
    options: { workerTier: "economical" | "mid" },
  ): Promise<ResolvedWorkerModel>;
  assertModelPolicy(tx: Tx, resolved: ResolvedWorkerModel): Promise<void>;
  assertParentWritable(tx: Tx, id: ConversationId): Promise<void>;
  assertInteractiveParent(tx: Tx, id: ConversationId): Promise<void>;
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
export const WorkerStopIntentsDoc = defineDoc<{
  items: { requestId: string; taskId: number }[];
}>({
  kind: "cpd.worker-stop-intents",
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
        await configure(tx, child.id, {
          ...task.input.agent,
          ...(item.pendingSelection ? modelChange(item.pendingSelection) : {}),
        });
        delete item.pendingSelection;
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
  conversation: Pick<Conversation, "id" | "commit">,
  raw: unknown,
  dependencies: WorkerDependencies,
) {
  const request = HelperLaunchSchema.parse(raw);
  const priorTask = async (tx: Tx) => {
    await dependencies.assertParentWritable(tx, conversation.id);
    await dependencies.assertInteractiveParent(tx, conversation.id);
    const doc = await tx.doc(HelpersDoc, conversation.id);
    const prior = doc.items.find((item) => item.request.requestId === request.requestId);
    if (
      prior &&
      JSON.stringify(HelperLaunchSchema.parse(prior.request)) !== JSON.stringify(request)
    )
      throw new Error("Helper request identity already used with different input");
    return prior ? String(prior.taskId) : undefined;
  };
  const existing = await conversation.commit(priorTask, BACKGROUND_CONTEXT);
  if (existing !== undefined) return existing;
  const chosen = await dependencies.resolveModelForRole("worker", {
    workerTier: request.modelRole,
  });
  if (!chosen.selection.provider.trim() || !chosen.selection.modelId.trim())
    throw new Error("Select an available worker model in Settings before starting.");
  return conversation.commit(async (tx) => {
    const existing = await priorTask(tx);
    if (existing !== undefined) return existing;
    await dependencies.assertModelPolicy(tx, chosen);
    const doc = await tx.doc(HelpersDoc, conversation.id);
    const agent = await tx.doc(AgentDoc, conversation.id);
    const saved: WorkerAgentSelection = {
      model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
      thinkingLevel: agent.thinkingLevel ?? null,
      cwd: agent.cwd ?? null,
    };
    const change = modelChange(chosen.selection);
    const worker = { ...saved, ...change };
    const taskId = await tx.createTask(
      request.mode === "background" ? BackgroundHelperTask : ForegroundHelperTask,
      { request, agent: worker },
      { ownership: { kind: "conversation" }, background: request.mode === "background" },
    );
    doc.items.push({ request, taskId, childId: null, model: change.model, receipt: null });
    return String(taskId);
  }, BACKGROUND_CONTEXT);
}

/**
 * Admission and authority are transactional; abortTask is a separate public SDK
 * operation. If interrupted between them, the same identity must be retried.
 */
export async function requestWorkerStop(
  harness: Pick<Harness, "abortTask">,
  conversation: Pick<Conversation, "id" | "commit">,
  taskId: string,
  raw: unknown,
  dependencies: WorkerDependencies,
) {
  const { requestId } = WorkerStopSchema.parse(raw);
  if (!/^[1-9]\d{0,19}$/.test(taskId)) throw new Error("Invalid worker identity");
  const target = await conversation.commit(async (tx) => {
    await dependencies.assertParentWritable(tx, conversation.id);
    await dependencies.assertInteractiveParent(tx, conversation.id);
    const doc = await tx.doc(HelpersDoc, conversation.id);
    const intents = await tx.doc(WorkerStopIntentsDoc, conversation.id);
    const prior = intents.items.find((item) => item.requestId === requestId);
    if (prior && String(prior.taskId) !== taskId)
      throw new Error("Stop request identity already used for another worker");
    const item = doc.items.find((candidate) => String(candidate.taskId) === taskId);
    if (!item) throw Object.assign(new Error("Worker not found"), { status: 404 });
    const task = await tx.task(item.taskId as TaskId);
    if (
      !task ||
      task.conversationId !== conversation.id ||
      task.owner !== undefined ||
      ![ForegroundHelperTask.definition.name, BackgroundHelperTask.definition.name].includes(
        task.kind,
      )
    )
      throw Object.assign(new Error("Worker unavailable"), { status: 404 });
    if (!prior) intents.items.push({ requestId, taskId: item.taskId });
    return { taskId: item.taskId as TaskId, terminal: task.state.status === "terminal" };
  }, BACKGROUND_CONTEXT);
  if (target.terminal) return { status: "already-settled" as const, taskId };
  const effect = await harness.abortTask(target.taskId, BACKGROUND_CONTEXT);
  return {
    status:
      effect === "marked"
        ? ("admitted" as const)
        : effect === "terminal"
          ? ("already-settled" as const)
          : ("unknown" as const),
    taskId,
  };
}

/** Explicitly cross background boundaries, unlike the ordinary parent Stop. */
export async function stopThreadIncludingBackground(conversation: Conversation) {
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

export async function retierWorkers(tx: Tx, parentId: ConversationId, tiers: Assignments) {
  if (!tiers.worker && !tiers.tangent) return;
  const doc = await tx.doc(HelpersDoc, parentId);
  for (const item of doc.items) {
    const next = item.request.modelRole === "mid" ? tiers.tangent : tiers.worker;
    if (!next || item.receipt) continue;
    const task = await tx.task(item.taskId as TaskId);
    if (!task || task.state.status === "terminal") continue;
    if (item.childId === null) item.pendingSelection = next;
    else await configure(tx, item.childId as ConversationId, modelChange(next));
    item.model = { provider: next.provider, modelId: next.modelId };
  }
}

/** Conservative projection: missing task records and outcomes stay unknown. */
export function workerLabel(assignment: unknown): string | null {
  if (typeof assignment !== "string") return null;
  const first = (assignment.split(/[\r\n]/u)[0] ?? "")
    .replace(/(?:[A-Za-z]:\\|~\/|\/)\S+/gu, "[path]")
    .replace(/\p{Cc}/gu, " ")
    .trim();
  let result = "";
  const encoder = new TextEncoder();
  for (const char of first) {
    if (encoder.encode(result + char).length > 120) break;
    result += char;
  }
  return result.trim() || null;
}

export async function inspectHelpers(harness: Harness, conversation: Conversation) {
  const [doc, stopIntents] = await Promise.all([
    harness.snapshot(HelpersDoc, conversation.id, BACKGROUND_CONTEXT),
    harness.snapshot(WorkerStopIntentsDoc, conversation.id, BACKGROUND_CONTEXT),
  ]);
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
        label: workerLabel(item.request.assignment),
        mode: item.request.mode,
        model: item.model ?? null,
        modelName: null,
        stop: !stopIntents?.items.some((intent) => intent.taskId === item.taskId)
          ? "none"
          : !task
            ? "unknown"
            : task.state.status !== "terminal"
              ? "requested"
              : task.state.outcome.status === "aborted"
                ? "cancelled"
                : task.state.outcome.status === "completed" ||
                    task.state.outcome.status === "failed"
                  ? "settled"
                  : "unknown",
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

/** Explicit, read-only collection; never submits a parent request or marks review accepted. */
export async function collectHelperResult(
  harness: Harness,
  conversation: Conversation,
  taskId: string,
) {
  const helper = (await inspectHelpers(harness, conversation)).helpers.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (helper?.status !== "success" || !helper.childId || !helper.answerEntryId) return null;
  const owned = await conversation.commit(async (tx) => {
    const record = await tx.conversation(Number(helper.childId) as ConversationId);
    return (
      record?.owner?.conversationId === conversation.id &&
      String(record.owner.taskId) === helper.taskId
    );
  }, BACKGROUND_CONTEXT);
  if (!owned) return null;
  const child = await harness.conversation(
    Number(helper.childId) as ConversationId,
    BACKGROUND_CONTEXT,
  );
  if (!child) return null;
  const id = Number(helper.answerEntryId) as EntryId;
  const page = await child.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const entry = page.items.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const text = (entry.model ?? [])
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      message.content.filter((part) => part.type === "text").map((part) => part.text),
    )
    .join("\n");
  return HelperResultSchema.parse({
    taskId,
    childId: helper.childId,
    answerEntryId: helper.answerEntryId,
    text: text.slice(0, 32_000),
    truncated: text.length > 32_000,
    review: "unreviewed",
  });
}
