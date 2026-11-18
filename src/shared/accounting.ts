import { z } from "zod";
const count = z.number().finite().nonnegative();
const line = z.strictObject({
  label: z.string(),
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  reasoning: count.optional(),
  totalTokens: count,
  cost: count,
  billed: z.boolean(),
});
const totals = z.strictObject({ lines: z.array(line), cost: count, totalTokens: count });
export const AccountingSchema = z.strictObject({
  conversationId: z.string(),
  observedAt: count,
  conversation: totals,
  session: totals,
  activity: z.strictObject({
    phase: z.enum([
      "idle",
      "generating",
      "tools",
      "retrying",
      "deferred",
      "after-run",
      "failed",
      "stopped",
      "unanswered",
    ]),
    attempt: count.nullable(),
    retryAt: count.nullable(),
    pollAt: count.nullable(),
    toolRounds: count.nullable(),
    failure: z
      .enum([
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
      ])
      .nullable(),
  }),
});
export type Accounting = z.infer<typeof AccountingSchema>;
