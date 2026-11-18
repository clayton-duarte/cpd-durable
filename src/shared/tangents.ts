import { z } from "zod";
import { SelectionSchema } from "./configuration.ts";

export const ResolvedTangentModelSchema = z.strictObject({
  selection: SelectionSchema,
  revision: z.number().int().nonnegative().safe(),
  assignment: z.enum(["main", "tangent", "worker"]),
});
export type ResolvedTangentModel = z.infer<typeof ResolvedTangentModelSchema>;

const text = z.string().trim().max(8000);
const lines = z.array(z.string().trim().min(1).max(1000)).max(20);
export const HandoffSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  decisions: lines,
  constraints: lines,
  exclusions: lines,
  references: lines,
  suggestedSkills: lines,
  discretion: text,
  deliverable: text,
  evidence: text,
  limits: text,
});
export const CreateTangentSchema = z.strictObject({
  requestId: z.string().min(1).max(120),
  parentId: z.number().int().positive().safe(),
  sourceId: z.number().int().positive().safe(),
  sourceEntryId: z.number().int().positive().safe().nullable(),
  title: z.string().trim().min(1).max(80),
  start: z.boolean(),
  handoff: HandoffSchema,
});
export const ReturnHandoffSchema = z.strictObject({
  requestId: z.string().min(1).max(120),
  tangentId: z.number().int().positive().safe(),
  expectedRevision: z.number().int().positive().safe(),
  handoff: HandoffSchema,
});
export type Handoff = z.infer<typeof HandoffSchema>;
export type CreateTangent = z.infer<typeof CreateTangentSchema>;
export type ReturnHandoff = z.infer<typeof ReturnHandoffSchema>;

export const TangentViewSchema = z.strictObject({
  id: z.number().int().positive().safe(),
  parentId: z.number().int().positive().safe(),
  sourceId: z.number().int().positive().safe(),
  sourceEntryId: z.number().int().positive().safe().nullable(),
  title: z.string().max(80),
  model: SelectionSchema.extend({ name: z.string().min(1).max(500).nullable() }),
  lifecycle: z.enum(["open", "concluded", "archived"]),
  readOnly: z.boolean(),
  activity: z.enum(["running", "waiting", "idle", "interrupted", "failed", "unknown"]),
  attention: z.enum(["unread", "needs-answer", "report-ready", "none"]),
  handoffRevision: z.number().int().positive().safe(),
  startState: z.enum(["create-only", "prepared", "admitted"]),
  latestHandoff: z.strictObject({
    revision: z.number().int().positive().safe(),
    kind: z.enum(["delegate", "return"]),
    handoff: HandoffSchema,
    delivery: z.enum(["available", "admitted"]),
    submissionId: z.number().int().positive().safe().nullable(),
    accepted: z.boolean(),
  }),
});
export type TangentView = z.infer<typeof TangentViewSchema>;
