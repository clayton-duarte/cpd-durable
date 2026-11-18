import type { AttachmentAdapter } from "@assistant-ui/react";
import { IMAGE_MAX_BYTES, ImageReferenceSchema } from "../shared/attachments.ts";

/** Upload is conversation-scoped and must return an immutable server reference.
 * File selection and paste both enter through add(). No separate draft state is owned here.
 * Integration must restore detached composer attachments on failed/uncertain admission,
 * and clear only the unchanged submitted snapshot on confirmed admission. */
export function createImageAttachmentAdapter(options: {
  upload(file: File): Promise<unknown>;
  previewUrl(id: string): string;
}): AttachmentAdapter {
  return {
    accept: "image/png,image/jpeg",
    async add({ file }) {
      if (
        !["image/png", "image/jpeg"].includes(file.type) ||
        file.size === 0 ||
        file.size > IMAGE_MAX_BYTES
      )
        throw new Error("Choose a PNG or JPEG image within the upload limit.");
      const ref = ImageReferenceSchema.parse(await options.upload(file));
      return {
        id: ref.id,
        type: "image",
        name: file.name,
        contentType: ref.mimeType,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async remove() {
      // Draft removal is not permission to delete bytes that may have been admitted.
    },
    async send(attachment, sendOptions) {
      if (sendOptions?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const id = ImageReferenceSchema.shape.id.parse(attachment.id);
      const url = options.previewUrl(id);
      if (!/^\/api\/chats\/[1-9]\d*\/attachments\/[0-9a-f-]{36}$/.test(url))
        throw new Error("Invalid image preview URL.");
      return {
        ...attachment,
        status: { type: "complete" },
        content: [{ type: "image", image: url }],
      };
    },
  };
}
