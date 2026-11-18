import { z } from "zod";

const text = z.string().max(32_000).nullable();
const lines = z.array(z.string().max(4_000)).max(20).nullable();
const legacyLines = z.array(z.string().trim().min(1).max(1000)).max(20);
const legacyText = z.string().trim().max(8000);
export const LegacyTangentHandoffSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  decisions: legacyLines,
  constraints: legacyLines,
  exclusions: legacyLines,
  references: legacyLines,
  suggestedSkills: legacyLines,
  discretion: legacyText,
  deliverable: legacyText,
  evidence: legacyText,
  limits: legacyText,
});
export const LegacyWorkerBriefSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("delegate"),
  deliverable: z.string().trim().min(1).max(8_000),
  evidence: z.array(z.string().max(4_000)).max(20),
  suggestedSkills: z.array(z.string().max(256)).max(20),
  constraints: z.array(z.string().max(4_000)).max(20),
});
const LegacyWorkerInputSchema = z.object({
  assignment: z.string().trim().min(1).max(16_000),
  context: z.string().max(32_000),
  brief: LegacyWorkerBriefSchema.nullable().optional(),
});

/** Null means not supplied; an empty string or array is an explicitly supplied value. */
export const HandoffContentSchema = z.strictObject({
  version: z.literal(1),
  provenance: z.enum(["native", "legacy-tangent", "legacy-worker"]),
  goal: text,
  context: text,
  decisions: lines,
  constraints: lines,
  exclusions: lines,
  references: lines,
  suggestedSkills: lines,
  discretion: text,
  deliverable: text,
  evidence: z.union([z.string().max(32_000), z.array(z.string().max(4_000)).max(20)]).nullable(),
  limits: text,
});
export type HandoffContent = z.infer<typeof HandoffContentSchema>;

/** Adapt on read; never rewrite legacy records or invent fields they did not contain. */
export function normalizeLegacyTangent(raw: unknown): HandoffContent {
  const value = LegacyTangentHandoffSchema.parse(raw);
  return HandoffContentSchema.parse({
    version: 1,
    provenance: "legacy-tangent",
    ...value,
    context: null,
  });
}

export function normalizeLegacyWorker(raw: unknown): HandoffContent {
  const value = LegacyWorkerInputSchema.parse(raw);
  return HandoffContentSchema.parse({
    version: 1,
    provenance: "legacy-worker",
    goal: value.assignment,
    context: value.context,
    decisions: null,
    constraints: value.brief?.constraints ?? null,
    exclusions: null,
    references: null,
    suggestedSkills: value.brief?.suggestedSkills ?? null,
    discretion: null,
    deliverable: value.brief?.deliverable ?? null,
    evidence: value.brief?.evidence ?? null,
    limits: null,
  });
}

const id = z.number().int().positive().safe();
const operation = z.string().min(1).max(128);
const assignment = z.string().min(1).max(128);
export const RecordHandoffSchema = z.strictObject({
  operationId: operation,
  assignmentId: assignment,
  parentId: id,
  childId: id,
  expectedRevision: z.number().int().nonnegative().safe(),
  kind: z.enum(["delegate", "update", "escalate", "return"]),
  content: HandoffContentSchema,
  delivery: z.literal("notify-only"),
});
export const HandoffActionSchema = z.strictObject({
  operationId: operation,
  assignmentId: assignment,
  parentId: id,
  childId: id,
  revision: z.number().int().positive().safe(),
});
export const ReviewHandoffSchema = HandoffActionSchema.extend({
  decision: z.enum(["accepted", "rejected"]),
  confirmedVisible: z.literal(true),
});
export const HandoffRecordSchema = z.strictObject({
  assignmentId: assignment,
  parentId: id,
  childId: id,
  revision: z.number().int().positive().safe(),
  kind: z.enum(["delegate", "update", "escalate", "return"]),
  content: HandoffContentSchema,
  delivery: z.literal("notify-only"),
  visibility: z.enum(["available", "collected"]),
  review: z.enum(["unreviewed", "accepted", "rejected"]),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
