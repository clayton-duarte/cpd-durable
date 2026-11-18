import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  FeedbackChangeSchema,
  FeedbackTargetSchema,
  FeedbackViewSchema,
  type FeedbackView,
} from "../shared/feedback.ts";
import { CatalogDoc } from "./chats.ts";

type Item = {
  entryId: number;
  modelIndex: number;
  revision: number;
  value: { vote: "helpful" | "unhelpful"; comment: string | null } | null;
};
export const FeedbackDoc = defineDoc<{
  items: Item[];
  operations: { requestId: string; fingerprint: string; result: Item }[];
}>({
  kind: "cpd.feedback",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [], operations: [] }),
  checkpointWhen: () => true,
});

export class FeedbackError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409) {
    super(status === 404 ? "Feedback target unavailable." : "Feedback changed or is read-only.");
    this.status = status;
  }
}
async function validateTarget(
  tx: Tx,
  conversationId: ConversationId,
  target: { entryId: number; modelIndex: number },
  write: boolean,
) {
  const catalog = await tx.doc(CatalogDoc);
  const item = catalog.items.find((entry) => entry.id === conversationId);
  if (!item || item.status === "deleted") throw new FeedbackError(404);
  const parent =
    item.kind === "tangent"
      ? catalog.items.find(
          (entry) => entry.id === item.tangentParentId && entry.status !== "deleted",
        )
      : undefined;
  if (item.kind === "tangent" && !parent) throw new FeedbackError(404);
  const readOnly =
    item.status === "archived" ||
    parent?.status === "archived" ||
    (item.kind === "tangent" && item.tangentLifecycle !== "open");
  if (write && readOnly) throw new FeedbackError(409);
  const id = target.entryId as EntryId;
  const entries = await tx.scanEntries({ conversationId, minEntryId: id, maxEntryId: id }, 1);
  const entry = entries.items.find((candidate) => candidate.id === id);
  const message = entry?.model?.[target.modelIndex];
  if (
    entry?.kind !== "pi.assistant" ||
    message?.role !== "assistant" ||
    !message.content.some((part) => part.type === "text" && part.text.length > 0)
  )
    throw new FeedbackError(404);
  return readOnly;
}
function project(conversationId: ConversationId, item: Item, readOnly: boolean): FeedbackView {
  return FeedbackViewSchema.parse({
    conversationId: String(conversationId),
    target: { entryId: item.entryId, modelIndex: item.modelIndex },
    revision: item.revision,
    value: item.value,
    readOnly,
  });
}
export async function readFeedback(conversation: Conversation, rawTarget: unknown) {
  const target = FeedbackTargetSchema.parse(rawTarget);
  return conversation.commit(async (tx) => {
    const readOnly = await validateTarget(tx, conversation.id, target, false);
    const doc = await tx.doc(FeedbackDoc, conversation.id);
    const item = doc.items.find(
      (entry) => entry.entryId === target.entryId && entry.modelIndex === target.modelIndex,
    );
    return project(conversation.id, item ?? { ...target, revision: 0, value: null }, readOnly);
  }, BACKGROUND_CONTEXT);
}
export async function changeFeedback(conversation: Conversation, rawTarget: unknown, raw: unknown) {
  const target = FeedbackTargetSchema.parse(rawTarget);
  const change = FeedbackChangeSchema.parse(raw);
  const fingerprint = JSON.stringify({ target, change });
  return conversation.commit(async (tx) => {
    await validateTarget(tx, conversation.id, target, true);
    const doc = await tx.doc(FeedbackDoc, conversation.id);
    const prior = doc.operations.find((entry) => entry.requestId === change.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new FeedbackError(409);
      return project(conversation.id, prior.result, false);
    }
    let item = doc.items.find(
      (entry) => entry.entryId === target.entryId && entry.modelIndex === target.modelIndex,
    );
    if ((item?.revision ?? 0) !== change.expectedRevision) throw new FeedbackError(409);
    if (!item) {
      item = { ...target, revision: 0, value: null };
      doc.items.push(item);
      item = doc.items[doc.items.length - 1]!;
    }
    item.revision++;
    item.value = change.value;
    const result = {
      entryId: item.entryId,
      modelIndex: item.modelIndex,
      revision: item.revision,
      value: item.value,
    };
    doc.operations.push({ requestId: change.requestId, fingerprint, result });
    return project(conversation.id, result, false);
  }, BACKGROUND_CONTEXT);
}
