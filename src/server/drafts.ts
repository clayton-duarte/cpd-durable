import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import {
  DraftAttemptRequestSchema,
  DraftUpdateSchema,
  DraftViewSchema,
  type DraftView,
} from "../shared/drafts.ts";
import { PendingImagesDoc } from "./attachment-catalog.ts";
import { CatalogDoc, ChatLifecycleError, type ChatScope } from "./chats.ts";
import {
  DraftAttemptConflict,
  draftAttemptFingerprint,
  readDraftAttempt,
  recordDraftAttempt,
} from "./draft-attempts.ts";

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

export async function readAttempt(scope: ChatScope, requestId: string) {
  return scope.conversation.commit(async (tx) => {
    await assertReadable(tx, scope);
    return readDraftAttempt(tx, scope.conversation.id, requestId);
  }, BACKGROUND_CONTEXT);
}

export async function saveAttempt(scope: ChatScope, input: unknown) {
  const request = DraftAttemptRequestSchema.parse(input);
  return scope.conversation.commit(async (tx) => {
    await scope.assertWritable(tx);
    const existing = await readDraftAttempt(tx, scope.conversation.id, request.requestId);
    const record = { ...request, fingerprint: draftAttemptFingerprint(request) };
    // Identical intent remains retryable after the user advances the draft.
    if (existing) return recordDraftAttempt(tx, scope.conversation.id, record);
    if (await tx.submissionByRequest(scope.conversation.id, request.requestId))
      throw new DraftAttemptConflict();
    const draft = await tx.doc(DraftDoc, scope.conversation.id);
    if (
      draft.revision !== request.draftRevision ||
      draft.content.text !== request.text ||
      JSON.stringify(draft.content.images.map((image) => image.id)) !==
        JSON.stringify(request.images)
    )
      throw new ChatLifecycleError("Draft changed in another session.", 409);
    const pending = await tx.doc(PendingImagesDoc, scope.conversation.id);
    if (request.images.some((id) => !pending.items.some((image) => image.id === id)))
      throw new ChatLifecycleError("Draft image is unavailable.", 409);
    return recordDraftAttempt(tx, scope.conversation.id, record);
  }, BACKGROUND_CONTEXT);
}
