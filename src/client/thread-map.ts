import type { ThreadView } from "../shared/threads.ts";
import type { ConversationMapEntry } from "./components/assistant-ui/elements/conversation-map.tsx";

/** One indexed thread per tick; loaded transcript messages never participate. */
export function threadMapEntries(
  threads: readonly ThreadView[],
  parentId?: string,
): ConversationMapEntry[] {
  return threads
    .filter((thread) => parentId === undefined || thread.parentId === parentId)
    .map((thread) => ({
      id: thread.id,
      title: thread.title || `Thread ${thread.id}`,
      preview: thread.source.text.slice(0, 240),
      thread: {
        entryId: thread.sourceEntryId,
        replies: thread.replyCount,
        repliesCapped: thread.replyCountCapped,
        needsYou: thread.activity === "waiting",
        running: thread.activity === "running",
      },
    }));
}
