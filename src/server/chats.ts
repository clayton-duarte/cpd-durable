import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  AgentDoc,
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
  type EntryId,
} from "@earendil-works/pi-durable";
import type { ChatCatalog, ChatSummary } from "../shared/chats.ts";
import { accounting } from "./accounting.ts";
import { inspectContext } from "./context.ts";
import type { Models } from "@earendil-works/pi-ai/models";
import { modelChoices, sameSelection, selection } from "./configuration.ts";
import type { Selection } from "../shared/configuration.ts";
import { admissionDigest, checkAdmissionRequest } from "./attachment-catalog.ts";
import { AttachmentAccessError } from "./attachment-routes.ts";
import { DraftDoc } from "./drafts.ts";
import type { DraftAdmission } from "../shared/drafts.ts";

export const modelKey = (value: { provider: string; modelId: string }) =>
  JSON.stringify([value.provider, value.modelId]);

type CatalogItem = {
  id: number;
  title: string;
  named: boolean;
  requestId: string | null;
  status?: "archived" | "deleted";
  parentId?: number;
  forkEntryId?: number;
  branchRootId?: number;
};
export const CatalogDoc = defineDoc<{
  items: CatalogItem[];
  requests?: { requestId: string; id: number }[];
  forks?: { requestId: string; parentId: number; at: number; id: number }[];
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

export async function openChats(
  harness: Harness,
  root: Conversation,
  defaults: AgentChange,
  models: Models,
) {
  await harness.commit(async (tx) => {
    const catalog = await tx.doc(CatalogDoc);
    if (!catalog.items.some((item) => item.id === root.id))
      catalog.items.unshift({ id: root.id, title: "Original chat", named: true, requestId: null });
    let retainedEmpty = false;
    for (const item of catalog.items) {
      if (item.status === "deleted") continue;
      const agent = await tx.doc(AgentDoc, item.id as ConversationId);
      await configure(tx, item.id as ConversationId, {
        ...defaults,
        ...(agent.model ? { model: agent.model } : {}),
      });
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
    const assertWritable = async (tx: Tx) => {
      const metadata = await tx.doc(CatalogDoc);
      const current = metadata.items.find((entry) => entry.id === conversation.id);
      if (!current || current.status === "deleted") throw new AttachmentAccessError(404);
      if (current.status === "archived") throw new AttachmentAccessError(409);
    };
    return {
      conversation,
      assertWritable,
      accounting: () => accounting(harness, conversation.id),
      context: () => inspectContext(harness, conversation, models),
      configuration: async () => ({
        conversationId: String(conversation.id),
        selection: selection(await harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT)),
        choices: await modelChoices(models),
      }),
      configure: async (expected: Selection, next: Selection) => {
        const choices = await modelChoices(models);
        const choice = choices.find(
          (choice) => choice.provider === next.provider && choice.modelId === next.modelId,
        );
        if (!choice || !choice.thinkingLevels.includes(next.thinkingLevel))
          throw new ChatLifecycleError("Model or thinking level is unavailable.", 409);
        await harness.commit(async (tx) => {
          const catalog = await tx.doc(CatalogDoc);
          const item = catalog.items.find((item) => item.id === conversation.id);
          if (!item || item.status)
            throw new ChatLifecycleError("Restore this chat before changing configuration.", 409);
          const agent = await tx.doc(AgentDoc, conversation.id);
          const current = selection(agent);
          if (sameSelection(current, next)) return;
          if (!sameSelection(current, expected))
            throw new ChatLifecycleError(
              "Configuration changed. Refresh before choosing again.",
              409,
            );
          await configure(tx, conversation.id, {
            model: { provider: next.provider, modelId: next.modelId },
            thinkingLevel: next.thinkingLevel,
          });
        }, BACKGROUND_CONTEXT);
      },
      archived: item.status === "archived",
      withdraw: (submissionId: SubmissionId) =>
        harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversation.id),
      admit: (
        draft: SubmissionDraft,
        options?: {
          digest?: string;
          expectedModelKey?: string | null;
          title?: string;
          draft?: DraftAdmission;
        },
      ) =>
        harness.commit(async (tx) => {
          const metadata = await tx.doc(CatalogDoc);
          const item = metadata.items.find((entry) => entry.id === conversation.id);
          await assertWritable(tx);
          if (options?.expectedModelKey !== undefined) {
            const current = selection(await tx.doc(AgentDoc, conversation.id));
            if (modelKey(current) !== options.expectedModelKey)
              throw new ChatLifecycleError("Model changed. Refresh and try again.", 409);
          }
          const prior = draft.requestId
            ? await tx.submissionByRequest(conversation.id, draft.requestId)
            : undefined;
          const savedDraft =
            options?.draft && !prior && draft.type === "input"
              ? await tx.doc(DraftDoc, conversation.id)
              : undefined;
          const record = draft.requestId
            ? await checkAdmissionRequest(
                tx,
                conversation.id,
                draft.requestId,
                options?.digest ?? admissionDigest(draft),
              )
            : undefined;
          const submission = await conversation.submit(tx, draft);
          record?.();
          if (
            savedDraft &&
            options?.draft &&
            savedDraft.revision === options.draft.revision &&
            savedDraft.revision < Number.MAX_SAFE_INTEGER &&
            savedDraft.content.text === options.draft.text &&
            JSON.stringify(savedDraft.content.images.map((image) => image.id)) ===
              JSON.stringify(options.draft.images)
          ) {
            savedDraft.content = { text: "", images: [] };
            savedDraft.revision++;
          }
          const title =
            options?.title ??
            (draft.type === "input" && typeof draft.content === "string" ? draft.content : "");
          if (item && !item.named && draft.type === "input" && title) {
            item.title = title.trim().replace(/\s+/g, " ").slice(0, 80);
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
              ...(item.parentId === undefined
                ? {}
                : {
                    parentId: String(item.parentId),
                    forkEntryId: String(item.forkEntryId),
                    branchRootId: String(item.branchRootId),
                  }),
            };
          }),
      );
      return { rootId: String(root.id), chats };
    },
    async rename(id: string, title: string, expected: string) {
      await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const item = catalog.items.find(
          (item) => String(item.id) === id && item.status !== "deleted",
        );
        if (!item) throw new ChatLifecycleError("Chat not found.", 404);
        if (item.status) throw new ChatLifecycleError("Restore this chat before renaming.", 409);
        if (item.title === title) return;
        if (item.title !== expected)
          throw new ChatLifecycleError("Title changed. Refresh before renaming.", 409);
        item.title = title;
        item.named = true;
      }, BACKGROUND_CONTEXT);
    },
    async fork(id: string, requestId: string, at: string): Promise<ChatSummary> {
      const created = await harness.commit(async (tx) => {
        const catalog = await tx.doc(CatalogDoc);
        const parent = catalog.items.find(
          (item) => String(item.id) === id && item.status !== "deleted",
        );
        if (!parent) throw new ChatLifecycleError("Source chat not found.", 404);
        if (parent.status)
          throw new ChatLifecycleError("Restore the source chat before forking.", 409);
        const previous = catalog.forks?.find((request) => request.requestId === requestId);
        if (previous) {
          if (String(previous.parentId) !== id || String(previous.at) !== at)
            throw new ChatLifecycleError("Fork request identity does not match its boundary.", 409);
          const item = catalog.items.find((item) => item.id === previous.id && !item.status);
          if (!item) throw new ChatLifecycleError("The fork was archived or deleted.", 409);
          return { ...item };
        }
        const entryId = Number(at) as EntryId;
        const visible = await tx.scanEntries(
          { conversationId: parent.id as ConversationId, minEntryId: entryId, maxEntryId: entryId },
          1,
        );
        if (!visible.items.length)
          throw new ChatLifecycleError("Saved entry is not visible in this chat.", 404);
        const record = await tx.forkConversation(parent.id as ConversationId, entryId, {
          ownership: { kind: "ownerless" },
        });
        const item: CatalogItem = {
          id: record.id,
          title: `Fork of ${parent.title}`.slice(0, 80),
          named: true,
          requestId: null,
          parentId: parent.id,
          forkEntryId: entryId,
          branchRootId: parent.branchRootId ?? parent.id,
        };
        catalog.items.push(item);
        catalog.forks ??= [];
        catalog.forks.push({ requestId, parentId: parent.id, at: entryId, id: record.id });
        return item;
      }, BACKGROUND_CONTEXT);
      const live = await harness.snapshot(
        LiveDoc,
        created.id as ConversationId,
        BACKGROUND_CONTEXT,
      );
      return {
        id: String(created.id),
        title: created.title,
        running: live?.run !== undefined,
        status: "regular",
        parentId: String(created.parentId),
        forkEntryId: String(created.forkEntryId),
        branchRootId: String(created.branchRootId),
      };
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
