import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { DraftUpdateSchema, DraftViewSchema, type DraftView } from "../shared/drafts.ts";
import { PendingImagesDoc } from "./attachment-catalog.ts";
import { CatalogDoc, ChatLifecycleError, type ChatScope } from "./chats.ts";

export const DraftDoc = defineDoc<DraftView>({
  kind: "cpd.composer-draft",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ revision: 0, content: { text: "", images: [] } }),
  checkpointWhen: () => true,
});

async function assertReadable(tx: Tx, scope: ChatScope) {
  const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === scope.conversation.id);
  if (!item || item.status === "deleted") throw new ChatLifecycleError("Chat not found.", 404);
}

export async function readDraft(scope: ChatScope) {
  return scope.conversation.commit(async (tx) => {
    await assertReadable(tx, scope);
    return DraftViewSchema.parse(await tx.doc(DraftDoc, scope.conversation.id));
  }, BACKGROUND_CONTEXT);
}

export async function saveDraft(scope: ChatScope, input: unknown) {
  const request = DraftUpdateSchema.parse(input);
  return scope.conversation.commit(async (tx) => {
    await scope.assertWritable(tx);
    const draft = await tx.doc(DraftDoc, scope.conversation.id);
    if (draft.revision !== request.expectedRevision)
      throw new ChatLifecycleError("Draft changed in another session.", 409);
    if (draft.revision >= Number.MAX_SAFE_INTEGER)
      throw new ChatLifecycleError("Draft revision exhausted.", 409);
    const pending = await tx.doc(PendingImagesDoc, scope.conversation.id);
    for (const image of request.content.images) {
      if (
        !pending.items.some(
          (item) =>
            item.id === image.id && item.mimeType === image.mimeType && item.size === image.size,
        )
      )
        throw new ChatLifecycleError("Draft image is unavailable.", 409);
    }
    draft.content = request.content;
    draft.revision++;
    return DraftViewSchema.parse(draft);
  }, BACKGROUND_CONTEXT);
}
