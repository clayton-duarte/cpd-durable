import { z } from "zod";

export const SAVED_PROMPT_LIMIT = 1000;
// Receipts are never evicted: exhausting this bound fails explicitly rather than
// allowing an old request identity to mutate the library a second time.
export const SAVED_PROMPT_OPERATION_LIMIT = 10000;
export const SavedPromptSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1).max(120),
  text: z.string().refine((text) => new TextEncoder().encode(text).byteLength <= 32768),
  revision: z.number().int().positive().safe(),
});
const payload = {
  requestId: z.uuid(),
  id: z.uuid(),
  title: SavedPromptSchema.shape.title,
  text: SavedPromptSchema.shape.text,
};
export const CreateSavedPromptSchema = z.strictObject(payload);
export const UpdateSavedPromptSchema = z.strictObject({
  ...payload,
  expectedRevision: SavedPromptSchema.shape.revision,
});
export const RemoveSavedPromptSchema = z.strictObject({
  requestId: z.uuid(),
  id: z.uuid(),
  expectedRevision: SavedPromptSchema.shape.revision,
});
export const ListSavedPromptsSchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(20).default(20),
});
export type SavedPrompt = z.infer<typeof SavedPromptSchema>;
export type CreateSavedPrompt = z.infer<typeof CreateSavedPromptSchema>;
export type UpdateSavedPrompt = z.infer<typeof UpdateSavedPromptSchema>;
export type RemoveSavedPrompt = z.infer<typeof RemoveSavedPromptSchema>;
