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

export const ChatMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  interrupted: z.boolean(),
});

export const ChatStateSchema = z.strictObject({
  messages: z.array(ChatMessageSchema),
  partial: z.string(),
  busy: z.boolean(),
  hasEarlier: z.boolean(),
  failure: z.string().nullable(),
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
});
export type ChatState = z.infer<typeof ChatStateSchema>;

export const SubmissionSchema = z.strictObject({ id: z.string() });
export const ApiErrorSchema = z.strictObject({ error: z.string() });
