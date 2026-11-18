import { z } from "zod";
import { LegacyWorkerBriefSchema } from "./handoffs.ts";

export const HelperLaunchSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  mode: z.enum(["foreground", "background"]),
  delivery: z.literal("notify-only"),
  modelRole: z.enum(["economical", "mid"]).default("economical"),
  assignment: z.string().trim().min(1).max(16_000),
  context: z.string().max(32_000),
  brief: LegacyWorkerBriefSchema.nullable().default(null),
});
export type HelperLaunch = z.infer<typeof HelperLaunchSchema>;
export const WorkerStopSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
});

export const HelperViewSchema = z.strictObject({
  requestId: z.string(),
  taskId: z.string(),
  childId: z.string().nullable(),
  mode: z.enum(["foreground", "background"]),
  model: z.strictObject({ provider: z.string(), modelId: z.string() }).nullable(),
  modelName: z.string().nullable(),
  stop: z.enum(["none", "requested", "cancelled", "settled", "unknown"]),
  status: z.enum(["pending", "running", "success", "failure", "cancelled", "unknown"]),
  answerEntryId: z.string().nullable(),
  delivery: z.literal("notify-only"),
});
export const HelpersViewSchema = z.strictObject({
  helpers: z.array(HelperViewSchema),
  hasUnsettled: z.boolean(),
});
export type HelpersView = z.infer<typeof HelpersViewSchema>;

export const HelperResultSchema = z.strictObject({
  taskId: z.string(),
  childId: z.string(),
  answerEntryId: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  review: z.literal("unreviewed"),
});
