import type { ThreadMessage } from "@assistant-ui/react";
import type { SearchHit } from "./components/assistant-ui/elements/conversation-search.tsx";

type SearchableMessage = Pick<ThreadMessage, "id" | "content"> & {
  metadata?: { custom?: Readonly<Record<string, unknown>> };
};
export function searchHistory(messages: readonly SearchableMessage[], query: string) {
  const needle = query.slice(0, 256);
  const hits: (SearchHit & { messageId: string })[] = [];
  if (!needle) return hits;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const [index, message] of messages.entries()) {
    if (message.metadata?.custom?.["historyMarker"]) continue;
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    for (const match of text.matchAll(pattern)) {
      if (hits.length === 1000) break;
      const at = match.index;
      const length = match[0].length;
      hits.push({
        id: `${message.id}:${at}`,
        messageId: message.id,
        before: text.slice(Math.max(0, at - 32), at),
        match: text.slice(at, at + length),
        after: text.slice(at + length, at + length + 32),
        position: (index / Math.max(1, messages.length - 1)) * 100,
      });
    }
    if (hits.length === 1000) break;
  }
  return hits;
}
