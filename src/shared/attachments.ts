import { z } from "zod";

// Transport bounds, not restrictions on native host tools.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 4;
// Bounds the pre-decode RGBA allocation as well as individual dimensions.
export const IMAGE_MAX_PIXELS = 32_000_000;
export const IMAGE_MAX_DIMENSION = 8192;
export const IMAGE_PREPARED_BASE64_MAX = 4_500_000;
export const ImageMimeSchema = z.enum(["image/png", "image/jpeg"]);
export const AttachmentIdSchema = z.uuid();
export const ImageReferenceSchema = z.strictObject({
  id: AttachmentIdSchema,
  mimeType: ImageMimeSchema,
  size: z.number().int().positive().max(IMAGE_MAX_BYTES),
  prepared: z.strictObject({
    mimeType: ImageMimeSchema,
    changed: z.boolean(),
    resized: z.boolean(),
    converted: z.boolean(),
  }),
});
export type ImageReference = z.infer<typeof ImageReferenceSchema>;
// Public projection contains coordinates only, never model bytes or provider payloads.
export const SavedImageReferenceSchema = z.strictObject({
  entryId: z.number().int().positive().safe(),
  modelIndex: z.number().int().nonnegative().max(10_000),
  partIndex: z.number().int().nonnegative().max(10_000),
});
export type SavedImageReference = z.infer<typeof SavedImageReferenceSchema>;
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
