import { z } from "zod";

export const FeedbackTargetSchema = z.strictObject({
  entryId: z.number().int().positive().safe(),
  modelIndex: z.number().int().nonnegative().safe(),
});
export const FeedbackValueSchema = z.strictObject({
  vote: z.enum(["helpful", "unhelpful"]),
  comment: z.string().max(4000).nullable(),
});
export const FeedbackChangeSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative().safe(),
  value: FeedbackValueSchema.nullable(),
});
export const FeedbackViewSchema = z.strictObject({
  conversationId: z.string(),
  target: FeedbackTargetSchema,
  revision: z.number().int().nonnegative().safe(),
  value: FeedbackValueSchema.nullable(),
  readOnly: z.boolean(),
});
export type FeedbackView = z.infer<typeof FeedbackViewSchema>;
