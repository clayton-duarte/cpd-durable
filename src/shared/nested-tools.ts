import { z } from "zod";

// No arguments, raw errors, output, private spill paths, usage or SDK docs.
export const NestedToolSchema = z.strictObject({
  callId: z.string().min(1),
  parentCallId: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["pending", "running", "complete", "error", "cancelled", "unavailable"]),
});
export type NestedTool = z.infer<typeof NestedToolSchema>;

export const NestedToolDisplaySchema = z.strictObject({
  state: z.enum(["live", "available", "unavailable"]),
  calls: z.array(NestedToolSchema),
  outputSpilled: z.boolean().optional(),
});

export const CodeModeReceiptSchema = z.strictObject({
  parentCallId: z.string().min(1),
  calls: z.array(NestedToolSchema),
  outputSpilled: z.boolean(),
});
export type CodeModeReceipt = z.infer<typeof CodeModeReceiptSchema>;
