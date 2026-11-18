import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import { defineDoc, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { AttachmentIdSchema, ImageMimeSchema } from "../shared/attachments.ts";
import type { AttachmentAuthorization } from "./attachments.ts";

type PendingImage = { id: string; mimeType: "image/png" | "image/jpeg"; size: number };
// Forks intentionally start empty; saved images are read from the inherited SDK entries instead.
export const PendingImagesDoc = defineDoc<{ items: PendingImage[] }>({
  kind: "cpd.pending-images",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

// Fingerprints are idempotency metadata, not a second transcript or request payload store.
const ImageRequestsDoc = defineDoc<{ requests: { id: string; digest: string }[] }>({
  kind: "cpd.image-requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: [] }),
  checkpointWhen: () => true,
});
export function imageRequestDigest(input: {
  text: string;
  images: readonly string[];
  mode: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.text, input.images, input.mode]))
    .digest("hex");
}
/** Call inside the host admission transaction BEFORE submit; invoke returned function only AFTER
 * submit succeeds. Never read Session state inside this callback. Existing non-image request IDs
 * need the host's unified request-ID collision policy as well. */
export async function checkImageRequest(
  tx: Tx,
  conversationId: ConversationId,
  id: string,
  digest: string,
): Promise<() => void> {
  const doc = await tx.doc(ImageRequestsDoc, conversationId);
  const previous = doc.requests.find((request) => request.id === id);
  if (previous && previous.digest !== digest)
    throw new Error("Request ID does not match its original image draft.");
  return () => {
    if (!previous) doc.requests.push({ id, digest });
  };
}

/** assertWritable must check the actual chat lifecycle catalog on this same SDK transaction.
 * Revocation only revokes pending access: retained bytes and saved SDK history are not deleted.
 * Do not revoke a reference while an admission might still be retried. */
export function createPendingImageCatalog(
  harness: Harness,
  conversationId: ConversationId,
  assertWritable: (tx: Tx) => Promise<void>,
) {
  const get = async (id: string) => {
    AttachmentIdSchema.parse(id);
    const doc = await harness.snapshot(PendingImagesDoc, conversationId, BACKGROUND_CONTEXT);
    return doc?.items.find((item) => item.id === id);
  };
  const authorization: AttachmentAuthorization = {
    bindPending: async (id, mimeType, size) => {
      AttachmentIdSchema.parse(id);
      ImageMimeSchema.parse(mimeType);
      await harness.commit(async (tx) => {
        await assertWritable(tx);
        const doc = await tx.doc(PendingImagesDoc, conversationId);
        if (doc.items.some((item) => item.id === id)) throw new Error("Duplicate image identity.");
        doc.items.push({ id, mimeType, size });
      }, BACKGROUND_CONTEXT);
    },
    canReadPending: async (id) => !!(await get(id)),
  };
  return {
    authorization,
    get,
    async revoke(id: string) {
      AttachmentIdSchema.parse(id);
      await harness.commit(async (tx) => {
        await assertWritable(tx);
        const doc = await tx.doc(PendingImagesDoc, conversationId);
        const index = doc.items.findIndex((item) => item.id === id);
        if (index !== -1) doc.items.splice(index, 1);
      }, BACKGROUND_CONTEXT);
    },
  };
}
