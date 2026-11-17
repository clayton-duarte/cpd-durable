import type { ConversationView } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ChatState } from "../shared/chat.ts";

// Read only presentation fields. Never forward raw SDK state/provider errors to clients.
const MessageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([
    z.string(),
    z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  ]),
  stopReason: z.string().optional(),
});
const LiveSchema = z.looseObject({
  run: z.unknown().optional(),
  generation: z
    .looseObject({ message: MessageSchema.optional(), retry: z.unknown().optional() })
    .optional(),
  runFailure: z.looseObject({ reason: z.string() }).optional(),
});
const InboxSchema = z.looseObject({
  items: z
    .array(
      z.discriminatedUnion("mode", [
        z.looseObject({
          id: z.number(),
          mode: z.enum(["steer", "followUp"]),
          content: z.union([
            z.string(),
            z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
          ]),
        }),
        z.looseObject({
          id: z.number(),
          mode: z.literal("write"),
          entry: z.looseObject({ kind: z.string() }),
        }),
      ]),
    )
    .default([]),
});

function textOf(message: z.infer<typeof MessageSchema>): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

export function present(view: ConversationView, canContinue = false): ChatState {
  const live = LiveSchema.parse(view.docs["pi.live"] ?? {});
  const inbox = InboxSchema.parse(view.docs["pi.inbox"] ?? {});
  return {
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
                text:
                  typeof item.content === "string"
                    ? item.content
                    : item.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text ?? "")
                        .join(""),
              },
            ],
      ),
    },
    messages: view.entries.flatMap((entry) =>
      (entry.model ?? []).flatMap((raw, index) => {
        const result = MessageSchema.safeParse(raw);
        if (!result.success) return [];
        const message = result.data;
        const text = textOf(message);
        if (!text) return [];
        return [
          {
            id: `${entry.id}:${index}`,
            role: message.role,
            text,
            interrupted: message.stopReason === "aborted" || message.stopReason === "error",
          },
        ];
      }),
    ),
    partial: live.generation?.message ? textOf(live.generation.message) : "",
    busy: live.run !== undefined,
    hasEarlier: view.before !== undefined,
    failure: live.runFailure
      ? live.runFailure.reason === "aborted"
        ? "Response stopped."
        : `Response did not complete (${live.runFailure.reason}). You can send another message.`
      : live.generation?.retry !== undefined
        ? "The provider request failed. Retrying…"
        : null,
  };
}
