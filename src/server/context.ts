import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { ContextSchema } from "../shared/context.ts";

export async function inspectContext(harness: Harness, conversation: Conversation) {
  const [view, live] = await Promise.all([
    conversation.context(BACKGROUND_CONTEXT),
    harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
  ]);
  const roles = new Map<string, number>();
  for (const message of view.messages) roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
  return ContextSchema.parse({
    conversationId: String(conversation.id),
    observedAt: Date.now(),
    headId: view.head ? String(view.head.id) : null,
    entryCount: view.entries.length,
    messageCount: view.messages.length,
    roles: [...roles].map(([role, count]) => ({ role, count })),
    entries: view.entries.slice(-200).map((entry, index) => ({
      id: String(entry.id),
      kind: entry.kind,
      messages:
        view.contributions[view.entries.length - Math.min(200, view.entries.length) + index]
          ?.length ?? 0,
    })),
    truncated: view.entries.length > 200,
    compactions: (live?.compactions ?? []).map((status) => ({
      taskId: String(status.taskId),
      trigger: status.trigger,
      blocking: status.blocking,
      attempt: status.attempt,
      retryAt: status.retry?.at ?? null,
    })),
    failure: live?.compactionFailure
      ? {
          taskId: String(live.compactionFailure.taskId),
          trigger: live.compactionFailure.trigger,
        }
      : null,
  });
}
