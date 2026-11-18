import { z } from "zod";

export const HelperLaunchSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  mode: z.enum(["foreground", "background"]),
  delivery: z.literal("notify-only"),
  assignment: z.string().trim().min(1).max(16_000),
  context: z.string().max(32_000),
});
export type HelperLaunch = z.infer<typeof HelperLaunchSchema>;

export const HelperViewSchema = z.strictObject({
  requestId: z.string(),
  taskId: z.string(),
  childId: z.string().nullable(),
  mode: z.enum(["foreground", "background"]),
  status: z.enum(["pending", "running", "success", "failure", "cancelled", "unknown"]),
  answerEntryId: z.string().nullable(),
  delivery: z.literal("notify-only"),
});
export const HelpersViewSchema = z.strictObject({
  helpers: z.array(HelperViewSchema),
  hasUnsettled: z.boolean(),
});
export type HelpersView = z.infer<typeof HelpersViewSchema>;
