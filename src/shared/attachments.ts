import { z } from "zod";

// Transport bounds, not restrictions on native host tools.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 4;
export const AttachmentIdSchema = z.uuid();
export const ImageReferenceSchema = z.strictObject({
  id: AttachmentIdSchema,
  mimeType: z.literal("image/png"),
  size: z.number().int().positive().max(IMAGE_MAX_BYTES),
});
export type ImageReference = z.infer<typeof ImageReferenceSchema>;
export const ImageInputSchema = z
  .strictObject({
    text: z.string().trim().max(32_000),
    images: z.array(AttachmentIdSchema).max(IMAGE_MAX_COUNT),
  })
  .refine(
    (input) =>
      (input.text.length > 0 || input.images.length > 0) &&
      new Set(input.images).size === input.images.length,
  );
