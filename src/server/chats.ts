import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  LiveDoc,
  InboxDoc,
  type Tx,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Harness,
  type SubmissionDraft,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ChatCatalog, ChatSummary } from "../shared/chats.ts";
import { accounting } from "./accounting.ts";
import { inspectContext } from "./context.ts";

type CatalogItem = {
  id: number;
  title: string;
  named: boolean;
  requestId: string | null;
  status?: "archived" | "deleted";
};
export const CatalogDoc = defineDoc<{
  items: CatalogItem[];
  requests?: { requestId: string; id: number }[];
}>({
  kind: "cpd.chats",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export class ChatLifecycleError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}
async function idle(tx: Tx, id: number) {
  const live = await tx.doc(LiveDoc, id as ConversationId);
  const inbox = await tx.doc(InboxDoc, id as ConversationId);
  return live.run === undefined && !live.compactions?.length && inbox.items.length === 0;
}
async function empty(tx: Tx, item: CatalogItem) {
  return (
    !item.named &&
    (await idle(tx, item.id)) &&
    (await tx.latestEntryId(item.id as ConversationId)) === undefined
  );
}

export async function openChats(harness: Harness, root: Conversation, defaults: AgentChange) {
  await harness.commit(async (tx) => {
    const catalog = await tx.doc(CatalogDoc);
    if (!catalog.items.some((item) => item.id === root.id))
      catalog.items.unshift({ id: root.id, title: "Original chat", named: true, requestId: null });
    let retainedEmpty = false;
    for (const item of catalog.items) {
      if (item.status === "deleted") continue;
      await configure(tx, item.id as ConversationId, defaults);
      if (!item.status && (await empty(tx, item))) {
        if (retainedEmpty) item.status = "archived";
        retainedEmpty = true;
      }
    }
  }, BACKGROUND_CONTEXT);

  async function resolve(id: string) {
    const catalog = await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT);
    const item = catalog?.items.find((item) => String(item.id) === id && item.status !== "deleted");
    if (!item) return undefined;
    const conversation =
      Number(id) === root.id
        ? root
        : await harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) return undefined;
    return {
      conversation,
      accounting: () => accounting(harness, conversation.id),
      context: () => inspectContext(harness, conversation),
      archived: item.status === "archived",
      withdraw: (submissionId: SubmissionId) =>
        harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversation.id),
      admit: (draft: SubmissionDraft) =>
        harness.commit(async (tx) => {
          const metadata = await tx.doc(CatalogDoc);
          const item = metadata.items.find((entry) => entry.id === conversation.id);
          if (!item || item.status)
            throw new ChatLifecycleError("Chat is archived or deleted.", 409);
          const submission = await conversation.submit(tx, draft);
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
        (catalog?.items ?? [])
          .filter((item) => item.status !== "deleted")
          .map(async (item): Promise<ChatSummary> => {
            const live = await harness.snapshot(
              LiveDoc,
              item.id as ConversationId,
              BACKGROUND_CONTEXT,
            );
            return {
              id: String(item.id),
              title: item.title,
              running: live?.run !== undefined,
              status: item.status === "archived" ? "archived" : "regular",
            };
          }),
      );
      return { rootId: String(root.id), chats };
    },
    async change(id: string, action: "archive" | "unarchive" | "delete") {
      await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const item = catalog.items.find((item) => String(item.id) === id);
        if (!item || (item.status === "deleted" && action !== "delete"))
          throw new ChatLifecycleError("Chat not found.", 404);
        if (item.status === "deleted") return;
        if (!(await idle(tx, item.id)))
          throw new ChatLifecycleError(
            "Stop this chat and resolve queued work before archiving or deleting it.",
            409,
          );
        if (action === "unarchive") {
          if (await empty(tx, item)) {
            for (const other of catalog.items)
              if (other.id !== item.id && !other.status && (await empty(tx, other)))
                throw new ChatLifecycleError(
                  "An empty chat is already open. Use that chat instead.",
                  409,
                );
          }
          delete item.status;
        } else item.status = action === "archive" ? "archived" : "deleted";
      }, BACKGROUND_CONTEXT);
    },
    async create(requestId: string): Promise<ChatSummary> {
      const item = await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const previous = catalog.requests?.find((entry) => entry.requestId === requestId);
        const existing = catalog.items.find(
          (entry) => entry.id === previous?.id || entry.requestId === requestId,
        );
        if (existing) {
          if (existing.status)
            throw new ChatLifecycleError(
              "The chat from this creation request was archived or deleted.",
              409,
            );
          return { id: existing.id, title: existing.title };
        }
        for (const item of catalog.items) {
          if (!item.status && (await empty(tx, item))) {
            catalog.requests ??= [];
            catalog.requests.push({ requestId, id: item.id });
            return { id: item.id, title: item.title };
          }
        }
        const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, record.id, defaults);
        const created: CatalogItem = { id: record.id, title: "New chat", named: false, requestId };
        catalog.items.push(created);
        return { id: created.id, title: created.title };
      }, BACKGROUND_CONTEXT);
      const live = await harness.snapshot(LiveDoc, item.id as ConversationId, BACKGROUND_CONTEXT);
      return {
        id: String(item.id),
        title: item.title,
        running: live?.run !== undefined,
        status: "regular",
      };
    },
  };
}

export type ChatScope = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof openChats>>["resolve"]>>
>;
