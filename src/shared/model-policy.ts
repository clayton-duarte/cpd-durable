import { z } from "zod";
import { SelectionSchema, ThinkingSchema } from "./configuration.ts";

export const ModelRoleSchema = z.enum(["main", "tangent", "worker"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const AssignmentsSchema = z.strictObject({
  main: SelectionSchema.nullable(),
  tangent: SelectionSchema.nullable(),
  worker: SelectionSchema.nullable(),
});
export const ModelPolicySchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  assignments: AssignmentsSchema,
});
export const ModelChoiceSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  modelId: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  thinkingLevels: z.array(ThinkingSchema).min(1).max(7),
});
export const ModelChoicesSchema = z.array(ModelChoiceSchema).max(5000);
export const ModelPolicyViewSchema = ModelPolicySchema.extend({ choices: ModelChoicesSchema });
export const ModelPolicyChangeSchema = z.strictObject({
  expected: ModelPolicySchema,
  assignments: AssignmentsSchema,
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;
export type Assignments = z.infer<typeof AssignmentsSchema>;
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export type ModelPolicyView = z.infer<typeof ModelPolicyViewSchema>;
