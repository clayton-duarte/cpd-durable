import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  LiveDoc,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Harness,
  type SubmissionDraft,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ChatCatalog, ChatSummary } from "../shared/chats.ts";

type CatalogItem = { id: number; title: string; named: boolean; requestId: string | null };
const CatalogDoc = defineDoc<{ items: CatalogItem[] }>({
  kind: "cpd.chats",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export async function openChats(harness: Harness, root: Conversation, defaults: AgentChange) {
  await harness.commit(async (tx) => {
    const catalog = await tx.doc(CatalogDoc);
    if (!catalog.items.some((item) => item.id === root.id))
      catalog.items.unshift({ id: root.id, title: "Original chat", named: true, requestId: null });
    for (const item of catalog.items) await configure(tx, item.id as ConversationId, defaults);
  }, BACKGROUND_CONTEXT);

  async function resolve(id: string) {
    const catalog = await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT);
    if (!catalog?.items.some((item) => String(item.id) === id)) return undefined;
    const conversation = await harness.conversation(
      Number(id) as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (!conversation) return undefined;
    return {
      conversation,
      withdraw: (submissionId: SubmissionId) =>
        harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversation.id),
      admit: (draft: SubmissionDraft) =>
        harness.commit(async (tx) => {
          const metadata = await tx.doc(CatalogDoc);
          const submission = await conversation.submit(tx, draft);
          const item = metadata.items.find((entry) => entry.id === conversation.id);
          if (item && !item.named && draft.type === "input" && typeof draft.content === "string") {
            item.title = draft.content.trim().replace(/\s+/g, " ").slice(0, 80);
            item.named = true;
          }
          return { id: submission };
        }, BACKGROUND_CONTEXT),
    };
  }

  return {
    resolve,
    async list(): Promise<ChatCatalog> {
      const catalog = await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT);
      const chats = await Promise.all(
        (catalog?.items ?? []).map(async (item): Promise<ChatSummary> => {
          const live = await harness.snapshot(
            LiveDoc,
            item.id as ConversationId,
            BACKGROUND_CONTEXT,
          );
          return { id: String(item.id), title: item.title, running: live?.run !== undefined };
        }),
      );
      return { rootId: String(root.id), chats };
    },
    async create(requestId: string): Promise<ChatSummary> {
      const item = await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const existing = catalog.items.find((entry) => entry.requestId === requestId);
        if (existing) return { id: existing.id, title: existing.title };
        const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, record.id, defaults);
        const created: CatalogItem = { id: record.id, title: "New chat", named: false, requestId };
        catalog.items.push(created);
        return { id: created.id, title: created.title };
      }, BACKGROUND_CONTEXT);
      const live = await harness.snapshot(LiveDoc, item.id as ConversationId, BACKGROUND_CONTEXT);
      return { id: String(item.id), title: item.title, running: live?.run !== undefined };
    },
  };
}

export type ChatScope = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof openChats>>["resolve"]>>
>;
