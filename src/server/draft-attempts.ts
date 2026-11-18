import { createHash } from "node:crypto";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { AttachmentIdSchema, IMAGE_MAX_COUNT } from "../shared/attachments.ts";

const PayloadSchema = z
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
const RecordSchema = z
  .strictObject({
    requestId: z.uuid(),
    draftRevision: z.number().int().nonnegative().safe(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string().max(32_000),
    images: z.array(AttachmentIdSchema).max(IMAGE_MAX_COUNT),
    mode: z.enum(["reject", "followUp", "steer"]),
  })
  .refine(
    (value) =>
      (!!value.text.trim() || value.images.length > 0) &&
      new Set(value.images).size === value.images.length,
  );

export type DraftAttempt = z.infer<typeof RecordSchema>;
export type DraftAttemptPayload = z.infer<typeof PayloadSchema>;

/** The request ID is the key; the hash identifies the literal semantic payload. */
export function draftAttemptFingerprint(payload: DraftAttemptPayload): string {
  const value = PayloadSchema.parse(payload);
  return createHash("sha256")
    .update(JSON.stringify([value.draftRevision, value.text, value.images, value.mode]))
    .digest("hex");
}

const DraftAttemptsDoc = defineDoc<{ attempts: DraftAttempt[] }>({
  kind: "cpd.draft-attempts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: [] }),
  checkpointWhen: () => true,
});

export class DraftAttemptConflict extends Error {
  readonly status = 409;
  constructor() {
    super("Request ID does not match its original draft attempt.");
  }
}

// These are bounded application request metadata, not a transcript or runtime.
// Callers must authorize the conversation, lifecycle, CAS revision and image ownership
// in the same transaction before recording, and authorize reads before projecting them.
export async function recordDraftAttempt(
  tx: Tx,
  conversationId: ConversationId,
  input: DraftAttempt,
): Promise<DraftAttempt> {
  const record = RecordSchema.parse(input);
  const { fingerprint, ...payload } = record;
  if (fingerprint !== draftAttemptFingerprint(payload)) throw new DraftAttemptConflict();
  const doc = await tx.doc(DraftAttemptsDoc, conversationId);
  const previous = doc.attempts.find((attempt) => attempt.requestId === record.requestId);
  if (previous) {
    if (
      previous.fingerprint !== fingerprint ||
      previous.draftRevision !== record.draftRevision ||
      previous.text !== record.text ||
      previous.mode !== record.mode ||
      JSON.stringify(previous.images) !== JSON.stringify(record.images)
    )
      throw new DraftAttemptConflict();
    return RecordSchema.parse(previous);
  }
  doc.attempts.push(record);
  return RecordSchema.parse(record);
}

/** A missing SDK submission is uncertain, never evidence that the input was unsent. */
export async function readDraftAttempt(tx: Tx, conversationId: ConversationId, requestId: string) {
  z.uuid().parse(requestId);
  const doc = await tx.doc(DraftAttemptsDoc, conversationId);
  const record = doc.attempts.find((attempt) => attempt.requestId === requestId);
  const submission = await tx.submissionByRequest(conversationId, requestId);
  if (!record) return undefined;
  return {
    record: RecordSchema.parse(record),
    admission: submission ? ("admitted" as const) : ("unknown" as const),
    ...(submission ? { submissionId: String(submission.id) } : {}),
  };
}
