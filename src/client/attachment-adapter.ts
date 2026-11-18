import type { AttachmentAdapter, CompleteAttachment, CreateAttachment } from "@assistant-ui/react";
import { IMAGE_MAX_BYTES, ImageReferenceSchema } from "../shared/attachments.ts";

/** The pinned native composer inserts CreateAttachment synchronously before resolving its
 * promise. Never yield between inserts, and recheck the draft after every notification
 * and after the promises settle; a later user edit must not restore submitted text. */
export async function restoreDetachedImages(
  composer: {
    getState(): { text: string; attachments: readonly { id: string }[] };
    addAttachment(attachment: CreateAttachment): Promise<void>;
    setText(text: string): void;
  },
  attachments: readonly CompleteAttachment[],
  text: string,
  expectedRevision: number,
  revision: () => number,
): Promise<void> {
  const operations: Promise<void>[] = [];
  const restored: string[] = [];
  for (const attachment of attachments) {
    const state = composer.getState();
    if (
      revision() !== expectedRevision ||
      state.text !== "" ||
      JSON.stringify(state.attachments.map((item) => item.id)) !== JSON.stringify(restored)
    )
      break;
    operations.push(
      composer.addAttachment({
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        content: attachment.content,
      }),
    );
    restored.push(attachment.id);
    expectedRevision++;
  }
  await Promise.all(operations);
  const state = composer.getState();
  if (
    revision() === expectedRevision &&
    state.text === "" &&
    restored.length === attachments.length &&
    JSON.stringify(state.attachments.map((item) => item.id)) === JSON.stringify(restored)
  )
    composer.setText(text);
}

/** Upload is conversation-scoped and must return an immutable server reference.
 * File selection and paste both enter through add(). No separate draft state is owned here.
 * Integration must restore detached composer attachments on failed/uncertain admission,
 * and clear only the unchanged submitted snapshot on confirmed admission. */
export function createImageAttachmentAdapter(options: {
  upload(file: File): Promise<unknown>;
  previewUrl(id: string): string;
  onAddStart?(): void;
}): AttachmentAdapter {
  return {
    accept: "image/png,image/jpeg",
    async add({ file }) {
      options.onAddStart?.();
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
