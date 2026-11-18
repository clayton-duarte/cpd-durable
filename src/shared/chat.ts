import { z } from "zod";

export const PROVIDER_ID = "opencode-go";
export const MODEL_ID = "deepseek-v4.1-flash";

export const SendModeSchema = z.enum(["reject", "followUp", "steer"]);
export type SendMode = z.infer<typeof SendModeSchema>;
export const InputSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(32_000),
  mode: SendModeSchema.optional(),
});
export type ChatInput = z.infer<typeof InputSchema>;

export const ControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("continue"), requestId: z.uuid() }),
  z.strictObject({
    type: z.literal("reset"),
    requestId: z.uuid(),
    handoff: z.string().trim().max(32_000),
  }),
]);
export type ChatControl = z.infer<typeof ControlSchema>;
export const WithdrawSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((id) => Number.isSafeInteger(Number(id))),
});
export const WithdrawResultSchema = z.strictObject({
  status: z.enum(["aborted", "already_placed", "settled", "not_found"]),
});

const RecordIdSchema = z.number().int().positive().safe();
export const ChatPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string(), type: z.literal("text"), text: z.string() }),
  z.strictObject({
    id: z.string(),
    type: z.literal("omitted"),
    kind: z.enum(["reasoning", "tool", "image", "other"]),
  }),
]);
export const MessageOutcomeSchema = z.enum([
  "complete",
  "interrupted",
  "error",
  "length",
  "incomplete",
]);
export const ChatMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  interrupted: z.boolean(),
  parts: z.array(ChatPartSchema).optional(),
  outcome: MessageOutcomeSchema.optional(),
  source: z
    .strictObject({
      entryId: RecordIdSchema,
      // Only known SDK assistant entries receive generation-task attribution.
      taskId: RecordIdSchema.optional(),
    })
    .optional(),
});

export const ChatStateSchema = z
  .strictObject({
    messages: z.array(ChatMessageSchema),
    partial: z.string(),
    busy: z.boolean(),
    hasEarlier: z.boolean(),
    failure: z.string().nullable(),
    conversationId: RecordIdSchema.optional(),
    window: z
      .strictObject({
        entryIds: z.array(RecordIdSchema),
        beforeEntryId: RecordIdSchema.optional(),
      })
      .optional(),
    live: z
      .strictObject({
        id: z.string(),
        taskId: RecordIdSchema,
        afterEntryId: RecordIdSchema.nullable(),
        text: z.string(),
        parts: z.array(ChatPartSchema),
      })
      .nullable()
      .optional(),
    controls: z
      .strictObject({
        canContinue: z.boolean(),
        resetPending: z.boolean(),
        queue: z.array(
          z.strictObject({
            id: z.string(),
            mode: z.enum(["followUp", "steer"]),
            text: z.string(),
          }),
        ),
      })
      .optional(),
  })
  .superRefine((state, context) => {
    if (new Set(state.messages.map((message) => message.id)).size !== state.messages.length)
      context.addIssue({ code: "custom", message: "Duplicate message identity" });
    for (const message of state.messages) {
      if (
        message.parts &&
        new Set(message.parts.map((part) => part.id)).size !== message.parts.length
      )
        context.addIssue({ code: "custom", message: "Duplicate part identity" });
    }
    if (
      state.live &&
      new Set(state.live.parts.map((part) => part.id)).size !== state.live.parts.length
    )
      context.addIssue({ code: "custom", message: "Duplicate live part identity" });
  });
export type ChatState = z.infer<typeof ChatStateSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatPart = z.infer<typeof ChatPartSchema>;

export const SubmissionSchema = z.strictObject({ id: z.string() });
export const ApiErrorSchema = z.strictObject({ error: z.string() });
