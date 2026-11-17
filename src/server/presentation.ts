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

function textOf(message: z.infer<typeof MessageSchema>): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

export function present(view: ConversationView): ChatState {
  const live = LiveSchema.parse(view.docs["pi.live"] ?? {});
  return {
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
