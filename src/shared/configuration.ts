import { z } from "zod";
export const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SelectionSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  modelId: z.string().min(1).max(500),
  thinkingLevel: ThinkingSchema,
});
export const ConfigurationChangeSchema = z.strictObject({
  expected: SelectionSchema,
  selection: SelectionSchema,
});
export const ConfigurationSchema = z.strictObject({
  conversationId: z.string(),
  selection: SelectionSchema,
  choices: z.array(
    z.strictObject({
      provider: z.string(),
      modelId: z.string(),
      name: z.string(),
      thinkingLevels: z.array(ThinkingSchema),
    }),
  ),
});
export type Selection = z.infer<typeof SelectionSchema>;
export type Configuration = z.infer<typeof ConfigurationSchema>;
