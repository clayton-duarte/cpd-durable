import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";

type Input = { requestId: string; command: string; includeInContext: boolean };
type Result = {
  status: "complete" | "failed" | "cancelled" | "interrupted";
  output: string;
  truncated: boolean;
  exitCode?: number;
};
type State = { phase: "execute" };
type Stored = { requestId: string; digest: string; taskId: number };

export const DirectShellEntry = defineEntry<{
  command: string;
  includeInContext: boolean;
  result: Result;
}>("cpd.direct-shell");
export const DirectShellDoc = defineDoc<{ requests: Stored[]; active: number | null }>({
  kind: "cpd.direct-shell.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [], active: null }),
  checkpointWhen: () => true,
});

export async function directShellHasUnsettled(tx: Tx, id: ConversationId): Promise<boolean> {
  const state = await tx.doc(DirectShellDoc, id);
  if (state.active === null) return false;
  const task = await tx.task(state.active as TaskId);
  return task !== undefined && task.state.status !== "terminal";
}

export async function directShellRequestExists(
  tx: Tx,
  id: ConversationId,
  requestId: string,
): Promise<boolean> {
  return (await tx.doc(DirectShellDoc, id)).requests.some((item) => item.requestId === requestId);
}

const LIMIT = 64 * 1024;
export const DirectShellTask = defineTask<Input, State, Result>({
  name: "cpd.direct-shell",
  version: 1,
  initial: () => ({ phase: "execute" }),
  phases: {
    execute: async (task, runtime, context) => {
      let output = "";
      let truncated = false;
      let result: Result;
      try {
        const env = await runtime.env(context);
        if (!env) throw new Error("Execution environment unavailable.");
        const run = await env.exec(
          task.input.command,
          {
            onOutput: (chunk) => {
              output += chunk;
              if (Buffer.byteLength(output) > LIMIT) {
                const bytes = Buffer.from(output);
                output = bytes.subarray(bytes.length - LIMIT).toString("utf8");
                truncated = true;
              }
            },
          },
          context,
        );
        if (runtime.signal.aborted) return;
        result = run.ok
          ? {
              status: run.value.exitCode === 0 ? "complete" : "failed",
              output,
              truncated,
              exitCode: run.value.exitCode,
            }
          : { status: "failed", output, truncated };
      } catch {
        if (runtime.signal.aborted) return;
        result = { status: "failed", output, truncated };
      }
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(DirectShellDoc, runtime.conversationId);
        doc.active = null;
        await tx.appendEntry(DirectShellEntry, runtime.conversationId, {
          data: {
            command: task.input.command,
            includeInContext: task.input.includeInContext,
            result,
          },
          ...(task.input.includeInContext
            ? {
                model: [
                  {
                    role: "user" as const,
                    content: `Shell command: ${task.input.command}\n${truncated ? "[Earlier output truncated]\n" : ""}${result.output}\nStatus: ${result.status}${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}`,
                    timestamp: Date.now(),
                  },
                ],
              }
            : {}),
        });
        return { status: "terminal", outcome: { status: "completed", result } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    const result: Result = {
      status: task.abortReason === "restart" ? "interrupted" : "cancelled",
      output: "",
      truncated: false,
    };
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(DirectShellDoc, runtime.conversationId);
      doc.active = null;
      await tx.appendEntry(DirectShellEntry, runtime.conversationId, {
        data: {
          command: task.input.command,
          includeInContext: task.input.includeInContext,
          result,
        },
        ...(task.input.includeInContext
          ? {
              model: [
                {
                  role: "user" as const,
                  content: `Shell command: ${task.input.command}\nStatus: ${result.status}; effects may be uncertain.`,
                  timestamp: Date.now(),
                },
              ],
            }
          : {}),
      });
      return { status: "terminal", outcome: { status: "aborted", result } };
    }, context);
  },
});

export const DirectShellExtension = defineExtension({
  name: "cpd-direct-shell",
  tasks: [DirectShellTask],
});

/** The caller supplies catalog authorization in the same transaction. */
export async function admitDirectShell(
  conversation: Conversation,
  input: Input,
  authorize: (tx: Tx) => Promise<void>,
  context: Context = BACKGROUND_CONTEXT,
): Promise<TaskId<Result>> {
  if (!input.requestId || !input.command.trim()) throw new Error("Invalid shell request.");
  const digest = createHash("sha256")
    .update(JSON.stringify([input.command, input.includeInContext]))
    .digest("hex");
  return conversation.commit(async (tx) => {
    await authorize(tx);
    const doc = await tx.doc(DirectShellDoc, conversation.id);
    const prior = doc.requests.find((item) => item.requestId === input.requestId);
    if (prior) {
      if (prior.digest !== digest) throw new Error("Shell request identity mismatch.");
      return prior.taskId as TaskId<Result>;
    }
    if (await tx.submissionByRequest(conversation.id, input.requestId))
      throw new Error("Request identity already used.");
    const live = await tx.doc(LiveDoc, conversation.id);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    if (
      live.run ||
      live.compactions?.length ||
      inbox.items.length ||
      (await directShellHasUnsettled(tx, conversation.id))
    )
      throw new Error("Conversation busy.");
    const id = await tx.createTask(DirectShellTask, input, {
      ownership: { kind: "conversation" },
      abandonOnRestart: true,
    });
    doc.requests.push({ requestId: input.requestId, digest, taskId: id });
    doc.active = id;
    return id;
  }, context);
}
