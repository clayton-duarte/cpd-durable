import { z } from "zod";

export const TemplateItemSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(1024),
  path: z.string().min(1).max(4096),
  truncated: z.boolean(),
});
export const TemplateListSchema = z.strictObject({
  conversationId: z.string(),
  templates: z.array(TemplateItemSchema).max(1000),
  issues: z
    .array(z.strictObject({ path: z.string().max(4096), reason: z.string().max(4096) }))
    .max(1000),
  omitted: z.number().int().nonnegative(),
});
export const TemplateContentSchema = z.strictObject({
  conversationId: z.string(),
  template: TemplateItemSchema,
  text: z.string().max(32768),
});
export type TemplateItem = z.infer<typeof TemplateItemSchema>;
