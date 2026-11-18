import { z } from "zod";
import {
  AttachmentIdSchema,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  ImageMimeSchema,
} from "./attachments.ts";

export const DraftAdmissionSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  text: z.string().max(32_000),
  images: z.array(AttachmentIdSchema).max(IMAGE_MAX_COUNT),
  attempt: z.literal(true).optional(),
});
export type DraftAdmission = z.infer<typeof DraftAdmissionSchema>;

export const DraftImageSchema = z.strictObject({
  id: AttachmentIdSchema,
  name: z.string().min(1).max(255),
  mimeType: ImageMimeSchema,
  size: z.number().int().positive().max(IMAGE_MAX_BYTES),
});
export const DraftContentSchema = z
  .strictObject({
    text: z.string().max(32_000),
    images: z.array(DraftImageSchema).max(IMAGE_MAX_COUNT),
  })
  .refine((value) => new Set(value.images.map((image) => image.id)).size === value.images.length);
export const DraftUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative().safe(),
  content: DraftContentSchema,
});
export const DraftViewSchema = z.strictObject({
  revision: z.number().int().nonnegative().safe(),
  content: DraftContentSchema,
});
export type DraftView = z.infer<typeof DraftViewSchema>;

export const DraftAttemptRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    draftRevision: z.number().int().nonnegative().safe(),
    text: z.string().max(32_000),
    images: z.array(AttachmentIdSchema).max(IMAGE_MAX_COUNT),
    mode: z.enum(["reject", "followUp", "steer"]),
  })
  .refine(
    (value) =>
      (!!value.text.trim() || value.images.length > 0) &&
      new Set(value.images).size === value.images.length,
  );
