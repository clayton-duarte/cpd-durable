import type { ConversationView } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ChatMessage, ChatPart, ChatState } from "../shared/chat.ts";

// Allowlist presentation fields; unknown payloads and provider diagnostics never cross the wire.
const RecordIdSchema = z.number().int().positive().safe();
const MessageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.unknown())]),
  stopReason: z.string().optional(),
});
const PartSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
const LiveSchema = z.looseObject({
  run: z.looseObject({ taskId: RecordIdSchema.optional() }).optional(),
  generation: z
    .looseObject({
      attempt: z.number().int().positive().optional(),
      message: MessageSchema.optional(),
      retry: z.unknown().optional(),
    })
    .optional(),
  runFailure: z.looseObject({ reason: z.string() }).optional(),
});
const InboxSchema = z.looseObject({
  items: z
    .array(
      z.discriminatedUnion("mode", [
        z.looseObject({
          id: RecordIdSchema,
          mode: z.enum(["steer", "followUp"]),
          content: z.union([z.string(), z.array(z.unknown())]),
        }),
        z.looseObject({
          id: RecordIdSchema,
          mode: z.literal("write"),
          entry: z.looseObject({ kind: z.string() }),
        }),
      ]),
    )
    .default([]),
});

function partsOf(content: z.infer<typeof MessageSchema>["content"], prefix: string): ChatPart[] {
  if (typeof content === "string")
    return content ? [{ id: `${prefix}:0`, type: "text", text: content }] : [];
  return content.flatMap((raw, index): ChatPart[] => {
    const part = PartSchema.safeParse(raw);
    const id = `${prefix}:${index}`;
    if (part.success && part.data.type === "text" && part.data.text !== undefined)
      return part.data.text ? [{ id, type: "text", text: part.data.text }] : [];
    // Preserve the position of omitted content without exposing its arguments,
    // private reasoning, URLs, arbitrary type names or unvalidated custom data.
    const kind = !part.success
      ? "other"
      : part.data.type === "thinking"
        ? "reasoning"
        : part.data.type === "toolCall" || part.data.type === "toolResult"
          ? "tool"
          : part.data.type === "image"
            ? "image"
            : "other";
    return [{ id, type: "omitted", kind }];
  });
}

const textOf = (parts: readonly ChatPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

function outcomeOf(reason: string | undefined): ChatMessage["outcome"] {
  switch (reason) {
    case "aborted":
      return "interrupted";
    case "error":
      return "error";
    case "length":
      return "length";
    case "stop":
    case "toolUse":
      return "complete";
    case undefined:
    default:
      return "incomplete";
  }
}

const failureReasons = new Set([
  "model_error",
  "no_model",
  "aborted",
  "reset",
  "faulted",
  "orphaned",
  "interrupted",
  "restart_limit",
  "nothing_to_answer",
  "turn_limit",
]);

export function present(view: ConversationView, canContinue = false): ChatState {
  const live = LiveSchema.parse(view.docs["pi.live"] ?? {});
  const inbox = InboxSchema.parse(view.docs["pi.inbox"] ?? {});
  const taskId = live.run?.taskId;
  const generation = live.generation;
  const liveId =
    taskId !== undefined && generation?.attempt !== undefined
      ? `generation:${view.conversation.id}:${taskId}:${generation.attempt}`
      : null;
  const liveParts = generation?.message
    ? partsOf(generation.message.content, liveId ?? "partial")
    : [];
  const messages = view.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((raw, index): ChatMessage[] => {
      const result = MessageSchema.safeParse(raw);
      if (!result.success) return [];
      const message = result.data;
      const id = `${entry.id}:${index}`;
      const parts = partsOf(message.content, id);
      if (parts.length === 0) return [];
      const outcome = message.role === "assistant" ? outcomeOf(message.stopReason) : undefined;
      return [
        {
          id,
          role: message.role,
          text: textOf(parts),
          parts,
          interrupted: outcome === "interrupted",
          ...(outcome ? { outcome } : {}),
          source: {
            entryId: entry.id,
            ...(entry.kind === "pi.assistant" &&
            entry.model?.length === 1 &&
            index === 0 &&
            message.role === "assistant" &&
            entry.byTaskId !== undefined
              ? { taskId: entry.byTaskId }
              : {}),
          },
        },
      ];
    }),
  );
  return {
    conversationId: view.conversation.id,
    window: {
      entryIds: view.entries.map((entry) => entry.id),
      ...(view.before !== undefined ? { beforeEntryId: view.before } : {}),
    },
    controls: {
      canContinue: live.run === undefined && canContinue,
      resetPending: inbox.items.some(
        (item) => item.mode === "write" && item.entry.kind === "pi.reset",
      ),
      queue: inbox.items.flatMap((item) =>
        item.mode === "write"
          ? []
          : [
              {
                id: String(item.id),
                mode: item.mode,
                text: textOf(partsOf(item.content, "queue")),
              },
            ],
      ),
    },
    messages,
    partial: textOf(liveParts),
    live:
      liveId && taskId !== undefined && liveParts.length > 0
        ? {
            id: liveId,
            taskId,
            afterEntryId: view.entries.at(-1)?.id ?? view.before ?? null,
            text: textOf(liveParts),
            parts: liveParts,
          }
        : null,
    busy: live.run !== undefined,
    hasEarlier: view.before !== undefined,
    failure: live.runFailure
      ? live.runFailure.reason === "aborted"
        ? "Response stopped."
        : `Response did not complete (${failureReasons.has(live.runFailure.reason) ? live.runFailure.reason : "unknown"}). You can send another message.`
      : generation?.retry !== undefined
        ? "The provider request failed. Retrying…"
        : null,
  };
}
