import { z } from "zod";
export const ThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SelectionSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  modelId: z.string().min(1).max(500),
  thinkingLevel: z.union([z.literal("default"), ThinkingSchema]).default("default"),
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

export function supportsThinking(levels: readonly string[], level: Selection["thinkingLevel"]) {
  return level === "default" || (level !== "max" && levels.includes(level));
}

export function thinkingLabel(level: Selection["thinkingLevel"]) {
  return level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1);
}
