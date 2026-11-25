import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Tx } from "@earendil-works/pi-durable";
import { DraftAttemptRequestSchema, DraftAttemptRecoveryPageSchema } from "../shared/drafts.ts";
import { PendingImagesDoc } from "./attachment-catalog.ts";
import { CatalogDoc, ChatLifecycleError, type ChatScope } from "./chats.ts";
import { directShellRequestExists } from "./direct-shell.ts";
import { draftInputText } from "../shared/draft-intent.ts";
import {
  DraftAttemptConflict,
  draftAttemptFingerprint,
  listDraftAttempts,
  readDraftAttempt,
  recordDraftAttempt,
} from "./draft-attempts.ts";

async function assertReadable(tx: Tx, scope: ChatScope) {
  const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === scope.conversation.id);
  if (!item || item.status === "deleted") throw new ChatLifecycleError("Chat not found.", 404);
}

export async function readAttempt(scope: ChatScope, requestId: string) {
  return scope.conversation.commit(async (tx) => {
    await assertReadable(tx, scope);
    return readDraftAttempt(tx, scope.conversation.id, requestId);
  }, BACKGROUND_CONTEXT);
}

export async function readAttempts(scope: ChatScope, cursor?: string) {
  return scope.conversation.commit(async (tx) => {
    await assertReadable(tx, scope);
    const page = await listDraftAttempts(tx, scope.conversation.id, cursor);
    return page && DraftAttemptRecoveryPageSchema.parse(page);
  }, BACKGROUND_CONTEXT);
}

export async function saveAttempt(scope: ChatScope, input: unknown) {
  const request = DraftAttemptRequestSchema.parse(input);
  return scope.conversation.commit(async (tx) => {
    await scope.assertWritable(tx);
    if (request.intent?.kind === "tangent-handoff-request") {
      const item = (await tx.doc(CatalogDoc)).items.find(
        (entry) => entry.id === scope.conversation.id,
      );
      if (
        !item ||
        item.kind === "tangent" ||
        request.mode !== "reject" ||
        draftInputText(request.text, request.intent) === undefined
      )
        throw new DraftAttemptConflict();
    }
    if (request.intent && draftInputText(request.text, request.intent) === undefined)
      throw new DraftAttemptConflict();
    const existing = await readDraftAttempt(tx, scope.conversation.id, request.requestId);
    const record = { ...request, fingerprint: draftAttemptFingerprint(request) };
    // Only a deliberate send is recorded. The revision is an opaque client
    // value bound to the attempt, not a revision of any server-owned draft.
    if (existing) return recordDraftAttempt(tx, scope.conversation.id, record);
    if (await directShellRequestExists(tx, scope.conversation.id, request.requestId))
      throw new DraftAttemptConflict();
    if (await tx.submissionByRequest(scope.conversation.id, request.requestId))
      throw new DraftAttemptConflict();
    const pending = await tx.doc(PendingImagesDoc, scope.conversation.id);
    if (request.images.some((id) => !pending.items.some((image) => image.id === id)))
      throw new ChatLifecycleError("Draft image is unavailable.", 409);
    return recordDraftAttempt(tx, scope.conversation.id, record);
  }, BACKGROUND_CONTEXT);
}
