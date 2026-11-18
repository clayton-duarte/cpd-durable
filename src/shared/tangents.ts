import { z } from "zod";

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
  sourceEntryId: z.number().int().positive().safe(),
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
