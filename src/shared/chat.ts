import { z } from "zod";

export const PROVIDER_ID = "opencode-go";
export const MODEL_ID = "deepseek-v4.1-flash";

export const InputSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().trim().min(1).max(32_000),
});
export type ChatInput = z.infer<typeof InputSchema>;

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
});
export type ChatState = z.infer<typeof ChatStateSchema>;

export const SubmissionSchema = z.strictObject({ id: z.string() });
export const ApiErrorSchema = z.strictObject({ error: z.string() });
