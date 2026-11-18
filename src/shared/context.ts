import { z } from "zod";

export const CompactSchema = z.strictObject({
  instructions: z.string().trim().max(32_000),
});
export const CompactResultSchema = z.strictObject({ taskId: z.string().regex(/^[1-9]\d*$/) });
export const ContextSchema = z.strictObject({
  conversationId: z.string(),
  observedAt: z.number().finite(),
  headId: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  roles: z.array(z.strictObject({ role: z.string(), count: z.number().int().nonnegative() })),
  entries: z.array(
    z.strictObject({ id: z.string(), kind: z.string(), messages: z.number().int().nonnegative() }),
  ),
  truncated: z.boolean(),
  compactions: z.array(
    z.strictObject({
      taskId: z.string(),
      trigger: z.enum(["manual", "threshold", "overflow"]),
      blocking: z.boolean(),
      attempt: z.number().int().nonnegative(),
      retryAt: z.number().finite().nullable(),
    }),
  ),
  failure: z
    .strictObject({
      taskId: z.string(),
      trigger: z.enum(["manual", "threshold", "overflow"]),
    })
    .nullable(),
});
export type ChatContext = z.infer<typeof ContextSchema>;
