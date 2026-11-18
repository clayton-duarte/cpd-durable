import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const label = z.string().trim().min(1).max(256);
const option = z.strictObject({ id, label });
const common = { id, label, required: z.boolean().optional() };
const text = z.strictObject({
  ...common,
  kind: z.literal("text"),
  default: z.string().max(4096).optional(),
});
const choice = z.strictObject({
  ...common,
  kind: z.literal("choice"),
  options: z.array(option).min(1).max(20),
  default: id.optional(),
});
const multi = z.strictObject({
  ...common,
  kind: z.literal("multi"),
  options: z.array(option).min(1).max(20),
  default: z.array(id).max(20).optional(),
});
export const QuestionSpecSchema = z
  .strictObject({
    message: z.string().trim().min(1).max(2048),
    fields: z
      .array(z.discriminatedUnion("kind", [text, choice, multi]))
      .min(1)
      .max(12),
  })
  .superRefine((spec, ctx) => {
    if (new Set(spec.fields.map((f) => f.id)).size !== spec.fields.length)
      ctx.addIssue({ code: "custom", message: "Duplicate field IDs" });
    for (const field of spec.fields) {
      if (field.kind === "text") {
        if (field.required && field.default !== undefined && !field.default.trim())
          ctx.addIssue({ code: "custom", message: "Required default is empty" });
        continue;
      }
      const ids = field.options.map((o) => o.id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "Duplicate option IDs" });
      const defaults =
        field.default === undefined
          ? []
          : Array.isArray(field.default)
            ? field.default
            : [field.default];
      if (
        new Set(defaults).size !== defaults.length ||
        defaults.some((v) => !ids.includes(v)) ||
        (field.kind === "multi" &&
          field.required &&
          field.default !== undefined &&
          defaults.length === 0)
      )
        ctx.addIssue({ code: "custom", message: "Invalid default" });
    }
  });
export type QuestionSpec = z.infer<typeof QuestionSpecSchema>;
export type AnswerValues = Record<string, string | string[]>;
export const ResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decline") }),
  z.strictObject({
    kind: z.literal("answer"),
    values: z.record(id, z.union([z.string().max(4096), z.array(id).max(20)])),
  }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

/** Reject unknown fields and invalid values; defaults apply only to omitted keys. */
export function normalizeResolution(spec: QuestionSpec, input: unknown): Resolution {
  const resolution = ResolutionSchema.parse(input);
  if (resolution.kind === "decline") return resolution;
  const valid = new Set(spec.fields.map((field) => field.id));
  if (Object.keys(resolution.values).some((key) => !valid.has(key)))
    throw new Error("Unknown answer field");
  const values: AnswerValues = Object.create(null) as AnswerValues;
  for (const field of spec.fields) {
    const value = Object.hasOwn(resolution.values, field.id)
      ? resolution.values[field.id]
      : field.default;
    if (value === undefined) {
      if (field.required) throw new Error(`Missing required field: ${field.id}`);
      continue;
    }
    if (field.kind === "text") {
      if (typeof value !== "string" || value.length > 4096 || (field.required && !value.trim()))
        throw new Error(`Invalid text: ${field.id}`);
      values[field.id] = value;
    } else if (field.kind === "choice") {
      if (typeof value !== "string" || !field.options.some((o) => o.id === value))
        throw new Error(`Invalid choice: ${field.id}`);
      values[field.id] = value;
    } else {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((v) => !field.options.some((o) => o.id === v)) ||
        (field.required && value.length === 0)
      )
        throw new Error(`Invalid choices: ${field.id}`);
      values[field.id] = field.options.filter((o) => value.includes(o.id)).map((o) => o.id);
    }
  }
  return { kind: "answer", values };
}

/** Validated browser projection; identities are server-supplied, never browser-generated. */
export const QuestionViewSchema = z
  .strictObject({
    questionId: z.string().regex(/^q-[1-9][0-9]*$/),
    taskId: z.number().int().positive().safe(),
    revision: z.number().int().positive().safe(),
    spec: QuestionSpecSchema,
    status: z.enum(["pending", "answered", "declined"]),
    resolution: ResolutionSchema.optional(),
    actionable: z.boolean(),
    cancelled: z.boolean(),
  })
  .superRefine((view, ctx) => {
    if (
      view.questionId !== `q-${view.taskId}` ||
      (view.actionable && (view.status !== "pending" || view.cancelled)) ||
      (view.cancelled && view.status !== "pending") ||
      (view.status === "pending" && view.resolution !== undefined) ||
      (view.status === "answered" && view.resolution?.kind !== "answer") ||
      (view.status === "declined" && view.resolution?.kind !== "decline")
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent question projection" });
  });
export type QuestionView = z.infer<typeof QuestionViewSchema>;
export const QuestionProjectionSchema = z.strictObject({
  conversationId: z.string().regex(/^[1-9][0-9]*$/),
  questions: z.array(QuestionViewSchema),
});
export const QuestionAnswerSchema = z.strictObject({
  questionId: z.string().regex(/^q-[1-9][0-9]*$/),
  taskId: z.number().int().positive().safe(),
  revision: z.number().int().positive().safe(),
  resolution: ResolutionSchema,
});
