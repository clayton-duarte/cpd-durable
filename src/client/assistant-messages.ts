import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatState } from "../shared/chat.ts";

// Browser-safe presentation only. Durable IDs, order and text remain server-owned.
export function assistantMessages(state: ChatState | null): ThreadMessageLike[] {
  if (!state) return [];
  const messages: ThreadMessageLike[] = state.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
    metadata: { custom: { interrupted: message.interrupted } },
    ...(message.role === "assistant"
      ? {
          status: message.interrupted
            ? { type: "incomplete" as const, reason: "other" as const }
            : { type: "complete" as const, reason: "stop" as const },
        }
      : {}),
  }));
  if (state.partial)
    messages.push({
      id: "live:partial",
      role: "assistant",
      content: [{ type: "text", text: state.partial }],
      status: { type: "running" },
    });
  return messages;
}
