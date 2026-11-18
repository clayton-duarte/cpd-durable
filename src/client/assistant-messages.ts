import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, ChatPart, ChatState } from "../shared/chat.ts";

export interface AssistantProjection {
  snapshot: ChatState | null;
  aliases: ReadonlyMap<string, string>;
  liveKey: string | null;
  streaming: boolean;
  messages: ThreadMessageLike[];
}

function contentOf(parts: readonly ChatPart[]): Exclude<ThreadMessageLike["content"], string> {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : part.type === "tool-call"
        ? {
            type: "tool-call" as const,
            toolCallId: part.id,
            toolName: part.name,
            args: part.arguments,
            argsText: part.argumentsUnavailable
              ? "Arguments are outside the retained history."
              : JSON.stringify(part.arguments, null, 2),
            ...(part.output !== undefined ? { result: part.output } : {}),
            isPreliminary: part.state === "pending" || part.state === "running",
            isError:
              part.state === "error" || part.state === "cancelled" || part.state === "unavailable",
          }
        : { type: "data-omitted" as const, data: { kind: part.kind } },
  );
}

function committedMessage(message: ChatMessage, displayId: string): ThreadMessageLike {
  const outcome = message.outcome ?? (message.interrupted ? "interrupted" : "complete");
  const parts = message.parts ?? [
    { id: `${message.id}:0`, type: "text" as const, text: message.text },
  ];
  const toolsRunning = parts.some(
    (part) => part.type === "tool-call" && (part.state === "pending" || part.state === "running"),
  );
  return {
    id: displayId,
    role: message.role,
    content: [
      ...contentOf(parts),
      ...(outcome === "interrupted" ? [{ type: "data-interruption" as const, data: {} }] : []),
    ],
    metadata: {
      custom: {
        durableId: message.id,
        partIds: parts.map((part) => part.id),
        interrupted: outcome === "interrupted",
        toolStates: Object.fromEntries(
          parts.filter((part) => part.type === "tool-call").map((part) => [part.id, part.state]),
        ),
      },
    },
    ...(message.role === "assistant"
      ? {
          status: toolsRunning
            ? { type: "running" as const }
            : outcome === "complete"
              ? { type: "complete" as const, reason: "stop" as const }
              : outcome === "error"
                ? {
                    type: "incomplete" as const,
                    reason: "error" as const,
                    error: "Response failed.",
                  }
                : outcome === "length"
                  ? { type: "incomplete" as const, reason: "length" as const }
                  : { type: "incomplete" as const, reason: "other" as const },
        }
      : {}),
  };
}

// Pure, session-local rendering identity. Canonical entry IDs/order/content stay
// server-owned; no text matching, optimistic transcript or persistence layer.
export function projectAssistantMessages(
  snapshot: ChatState | null,
  previous?: AssistantProjection,
): AssistantProjection {
  const sameConversation =
    snapshot !== null &&
    previous?.snapshot !== null &&
    previous?.snapshot?.conversationId === snapshot.conversationId;
  const aliases = new Map<string, string>();
  for (const message of snapshot?.messages ?? []) {
    const alias = sameConversation ? previous?.aliases.get(message.id) : undefined;
    if (alias) aliases.set(message.id, alias);
  }
  const oldLive = sameConversation ? previous?.snapshot?.live : null;
  const anchorRetained =
    oldLive?.afterEntryId === null ||
    (oldLive !== null &&
      oldLive !== undefined &&
      (snapshot?.window?.entryIds.includes(oldLive.afterEntryId) ||
        snapshot?.window?.beforeEntryId === oldLive.afterEntryId));
  const oldIds = new Set(previous?.snapshot?.messages.map((message) => message.id));
  const candidates =
    oldLive && anchorRetained
      ? (snapshot?.messages ?? []).filter(
          (message) =>
            message.role === "assistant" &&
            message.source?.taskId === oldLive.taskId &&
            message.source.entryId > (oldLive.afterEntryId ?? 0) &&
            !oldIds.has(message.id),
        )
      : [];
  // The built-in assistant entry is identifiable by task + append boundary.
  // Missed/ambiguous commits or unattributed scheduler salvage never get guessed.
  const settled = candidates.length === 1 ? candidates[0] : undefined;
  if (settled && previous?.liveKey) aliases.set(settled.id, previous.liveKey);

  const live = snapshot?.live;
  const liveKey = live
    ? oldLive?.id === live.id && anchorRetained && candidates.length === 0 && previous?.liveKey
      ? previous.liveKey
      : `live:${live.id}:after:${live.afterEntryId ?? 0}`
    : null;
  const messages = (snapshot?.messages ?? []).map((message) =>
    committedMessage(message, aliases.get(message.id) ?? message.id),
  );
  if (live && liveKey)
    messages.push({
      id: liveKey,
      role: "assistant",
      content: contentOf(live.parts),
      metadata: { custom: { durableId: null, partIds: live.parts.map((part) => part.id) } },
      status: { type: "running" },
    });
  // Old snapshots/embedding fixtures remain readable, but carry no evidence for
  // live-to-entry identity transfer. Explicit live:null must suppress stale text.
  const legacyPartial =
    snapshot && snapshot.live === undefined && snapshot.busy && snapshot.partial;
  if (legacyPartial)
    messages.push({
      id: "live:partial",
      role: "assistant",
      content: [{ type: "text", text: legacyPartial }],
      status: { type: "running" },
    });
  return {
    snapshot,
    aliases,
    liveKey,
    messages,
    streaming:
      !!live || !!legacyPartial || messages.some((message) => message.status?.type === "running"),
  };
}

export const assistantMessages = (state: ChatState | null) =>
  projectAssistantMessages(state).messages;
