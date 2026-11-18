import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
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
import {
  admissionDigest,
  checkAdmissionRequest,
  imageRequestDigest,
} from "./attachment-catalog.ts";
import { AttachmentAccessError } from "./attachment-routes.ts";
import { assertMainModelDecisionTx, type createModelPolicy } from "./model-policy.ts";
import { DraftDoc } from "./drafts.ts";
import type { DraftAdmission } from "../shared/drafts.ts";
import { DraftAttemptConflict, readDraftAttempt } from "./draft-attempts.ts";
import { assertBranchIdentityAvailable, reserveBranchIdentity } from "./branch-identity.ts";
import { createRegeneration, regenerableAnswer, RegenerationError } from "./regeneration.ts";
import {
  compactIntentUnsettled,
  DirectShellDoc,
  directShellHasUnsettled,
  directShellRequestExists,
} from "./direct-shell.ts";
import {
  DirectShellRequestSchema,
  DirectShellResultSchema,
  DirectShellStatusSchema,
  modelInputText,
} from "../shared/direct-shell.ts";
import {
  createBranchOperations,
  BranchOperationError,
  editableUserEntry,
} from "./branch-operations.ts";

export const modelKey = (value: { provider: string; modelId: string }) =>
  JSON.stringify([value.provider, value.modelId]);
const COMPACT_HOST = randomUUID();

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
  return (
    live.run === undefined &&
    !live.compactions?.length &&
    inbox.items.length === 0 &&
    !(await directShellHasUnsettled(tx, id as ConversationId)) &&
    !(await compactIntentUnsettled(tx, id as ConversationId))
  );
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
  modelPolicy?: ReturnType<typeof createModelPolicy>,
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

  const regeneration = createRegeneration(harness, {
    async requireActive(tx, id) {
      const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === id);
      if (!item || item.status) throw new RegenerationError("Chat unavailable.", item ? 409 : 404);
    },
    async reserveBranchRequest(tx, request) {
      return reserveBranchIdentity(tx, request.requestId, "regenerate");
    },
    async register(tx, { sourceId, branchId, forkEntryId }) {
      const catalog = await tx.doc(CatalogDoc);
      const source = catalog.items.find((item) => item.id === sourceId && !item.status);
      if (!source) throw new RegenerationError("Chat unavailable.", 409);
      catalog.items.push({
        id: branchId,
        title: `Regeneration of ${source.title}`.slice(0, 80),
        named: true,
        requestId: null,
        parentId: sourceId,
        forkEntryId,
        branchRootId: source.branchRootId ?? sourceId,
      });
    },
  });

  const branchOperations = createBranchOperations(harness, {
    async requireActive(tx, id) {
      const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === id);
      if (!item || item.status)
        throw new BranchOperationError("Chat is archived or unavailable.", item ? 409 : 404);
    },
    async reserveBranchRequest(tx, request) {
      return reserveBranchIdentity(tx, request.requestId, "edit");
    },
    async registerEdit(tx, { sourceId, branchId, forkEntryId }) {
      const catalog = await tx.doc(CatalogDoc);
      const source = catalog.items.find((item) => item.id === sourceId);
      if (!source || source.status) throw new BranchOperationError("Source chat unavailable.", 409);
      catalog.items.push({
        id: branchId,
        title: `Edit of ${source.title}`.slice(0, 80),
        named: true,
        requestId: null,
        ...(forkEntryId === null
          ? {}
          : {
              parentId: sourceId,
              forkEntryId,
              branchRootId: source.branchRootId ?? sourceId,
            }),
      });
    },
  });

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
          if (await directShellHasUnsettled(tx, conversation.id))
            throw new ChatLifecycleError("A direct shell command is running.", 409);
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
      shellStatus: async (requestId?: string) => {
        if (!(await harness.snapshot(DirectShellDoc, conversation.id, BACKGROUND_CONTEXT)))
          return undefined;
        return harness.commit(async (tx) => {
          const catalog = await tx.doc(CatalogDoc);
          if (
            !catalog.items.some((item) => item.id === conversation.id && item.status !== "deleted")
          )
            return undefined;
          const state = await tx.doc(DirectShellDoc, conversation.id);
          const record = state.requests.find((request) =>
            requestId === undefined
              ? request.taskId === state.active
              : request.requestId === requestId,
          );
          if (!record) return undefined;
          const task = await tx.task(record.taskId as import("@earendil-works/pi-durable").TaskId);
          if (!task || task.conversationId !== conversation.id || task.kind !== "cpd.direct-shell")
            return undefined;
          const input = DirectShellRequestSchema.safeParse(task.input);
          if (!input.success || input.data.requestId !== record.requestId) return undefined;
          const settled =
            task.state.status === "terminal"
              ? DirectShellResultSchema.safeParse(task.state.outcome.result)
              : undefined;
          const progress = state?.progress?.taskId === task.id ? state.progress : undefined;
          const result = settled?.success
            ? settled.data
            : {
                status:
                  task.state.status === "terminal"
                    ? ("unavailable" as const)
                    : ("running" as const),
                output: progress?.output ?? "",
                truncated: progress?.truncated ?? false,
              };
          return DirectShellStatusSchema.parse({
            conversationId: String(conversation.id),
            taskId: String(task.id),
            ...input.data,
            ...result,
          });
        }, BACKGROUND_CONTEXT);
      },
      stopShell: async (requestId: string) => {
        const id = await conversation.commit(async (tx) => {
          await assertWritable(tx);
          const record = (await tx.doc(DirectShellDoc, conversation.id)).requests.find(
            (request) => request.requestId === requestId,
          );
          if (!record) throw new ChatLifecycleError("Shell request not found.", 404);
          const task = await tx.task(record.taskId as import("@earendil-works/pi-durable").TaskId);
          if (!task || task.conversationId !== conversation.id || task.kind !== "cpd.direct-shell")
            throw new ChatLifecycleError("Shell task unavailable.", 409);
          return task.id;
        }, BACKGROUND_CONTEXT);
        return harness.abortTask(id, BACKGROUND_CONTEXT);
      },
      compact: async (instructions?: string) => {
        const reservation = randomUUID();
        await conversation.commit(async (tx) => {
          await assertWritable(tx);
          if (
            (await directShellHasUnsettled(tx, conversation.id)) ||
            (await compactIntentUnsettled(tx, conversation.id))
          )
            throw new ChatLifecycleError("Shell or compaction admission is pending.", 409);
          (await tx.doc(DirectShellDoc, conversation.id)).compactIntent = {
            id: reservation,
            owner: COMPACT_HOST,
            inputDigest: createHash("sha256")
              .update(JSON.stringify(instructions ?? null))
              .digest("hex"),
          };
        }, BACKGROUND_CONTEXT);
        const taskId = await conversation.compact(instructions, BACKGROUND_CONTEXT);
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(DirectShellDoc, conversation.id);
          if (doc.compactIntent?.id !== reservation)
            throw new Error("Compaction reservation changed.");
          doc.compactIntent.taskId = taskId;
        }, BACKGROUND_CONTEXT);
        return taskId;
      },
      compactReservation: async () => {
        const doc = await harness.snapshot(DirectShellDoc, conversation.id, BACKGROUND_CONTEXT);
        if (!doc?.compactIntent) return null;
        const intent = doc.compactIntent;
        const task =
          intent.taskId === undefined
            ? undefined
            : await harness.getTask(
                intent.taskId as import("@earendil-works/pi-durable").TaskId,
                BACKGROUND_CONTEXT,
              );
        return {
          id: intent.id,
          pending:
            intent.taskId === undefined ||
            !task ||
            task.conversationId !== conversation.id ||
            task.kind !== "pi.compaction" ||
            task.state.status !== "terminal",
          recoveryRequiresRestart: !intent.owner || intent.owner === COMPACT_HOST,
          taskKnown: intent.taskId !== undefined,
        };
      },
      releaseCompactReservation: async (id: string) =>
        conversation.commit(async (tx) => {
          await assertWritable(tx);
          const doc = await tx.doc(DirectShellDoc, conversation.id);
          const intent = doc.compactIntent;
          if (!intent || intent.id !== id)
            throw new ChatLifecycleError("Compaction reservation changed.", 409);
          if (!intent.owner || intent.owner === COMPACT_HOST)
            throw new ChatLifecycleError(
              "Restart the host before resolving this reservation.",
              409,
            );
          const live = await tx.doc(LiveDoc, conversation.id);
          if (live.compactions?.length)
            throw new ChatLifecycleError("Compaction is still active.", 409);
          if (intent.taskId !== undefined) {
            const task = await tx.task(
              intent.taskId as import("@earendil-works/pi-durable").TaskId,
            );
            if (
              !task ||
              task.conversationId !== conversation.id ||
              task.kind !== "pi.compaction" ||
              task.state.status !== "terminal"
            )
              throw new ChatLifecycleError("Compaction outcome is unavailable or active.", 409);
          }
          delete doc.compactIntent;
        }, BACKGROUND_CONTEXT),
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
          if (
            draft.requestId &&
            (await directShellRequestExists(tx, conversation.id, draft.requestId))
          )
            throw new ChatLifecycleError("Request identity already used.", 409);
          if (await directShellHasUnsettled(tx, conversation.id))
            throw new ChatLifecycleError("A direct shell command is running.", 409);
          const attempt =
            draft.requestId && z.uuid().safeParse(draft.requestId).success
              ? await readDraftAttempt(tx, conversation.id, draft.requestId)
              : undefined;
          if (options?.draft?.attempt && !attempt) throw new DraftAttemptConflict();
          if (attempt) {
            const original = attempt.record;
            const submittedText =
              draft.type !== "input"
                ? undefined
                : typeof draft.content === "string"
                  ? draft.content
                  : draft.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("");
            if (
              draft.type !== "input" ||
              submittedText !== modelInputText(original.text) ||
              (draft.whenBusy ?? "reject") !== original.mode ||
              (original.mode === "steer" && draft.whenIdle !== "reject") ||
              !options?.draft ||
              options.draft.revision !== original.draftRevision ||
              options.draft.text !== original.text ||
              JSON.stringify(options.draft.images) !== JSON.stringify(original.images) ||
              options.digest !==
                imageRequestDigest({
                  text: modelInputText(original.text),
                  images: original.images,
                  mode: original.mode,
                })
            )
              throw new DraftAttemptConflict();
          }
          if (options?.expectedModelKey !== undefined) {
            const current = selection(await tx.doc(AgentDoc, conversation.id));
            if (modelKey(current) !== options.expectedModelKey)
              throw new ChatLifecycleError("Model changed. Refresh and try again.", 409);
          }
          const prior = draft.requestId
            ? await tx.submissionByRequest(conversation.id, draft.requestId)
            : undefined;
          const savedDraft =
            attempt && options?.draft && !prior && draft.type === "input"
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
          let clearedDraftRevision: number | undefined;
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
            clearedDraftRevision = savedDraft.revision;
          }
          const title =
            options?.title ??
            (draft.type === "input" && typeof draft.content === "string" ? draft.content : "");
          if (item && !item.named && draft.type === "input" && title) {
            item.title = title.trim().replace(/\s+/g, " ").slice(0, 80);
            item.named = true;
          }
          return {
            id: submission,
            ...(clearedDraftRevision === undefined ? {} : { clearedDraftRevision }),
          };
        }, BACKGROUND_CONTEXT),
    };
  }

  return {
    editBranch: branchOperations.edit,
    recentEditOperations(id: string, at: string) {
      return branchOperations.recent(Number(id) as ConversationId, Number(at) as EntryId);
    },
    async canEdit(id: string, at: string) {
      const scoped = await resolve(id);
      if (!scoped || scoped.archived) return false;
      const entryId = Number(at) as EntryId;
      const page = await scoped.conversation.entries(
        { minEntryId: entryId, maxEntryId: entryId },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      );
      return page.items[0]?.id === entryId && editableUserEntry(page.items[0]);
    },
    resolve,
    async canRegenerate(id: string, at: string) {
      const scoped = await resolve(id);
      if (!scoped || scoped.archived) return false;
      const entryId = Number(at) as EntryId;
      const page = await scoped.conversation.entries(
        { maxEntryId: entryId, order: "descending" },
        2,
        undefined,
        BACKGROUND_CONTEXT,
      );
      if (page.items[0]?.id !== entryId || !regenerableAnswer(page.items[0]) || !page.items[1])
        return false;
      const view = await scoped.conversation.context(BACKGROUND_CONTEXT, { at: page.items[1].id });
      const tail = view.messages.at(-1);
      return tail?.role === "user" || tail?.role === "toolResult";
    },
    regenerate: async (request: Parameters<typeof regeneration.prepare>[0]) => {
      await regeneration.prepare(request);
      return regeneration.admit(request);
    },
    recentRegenerations: (id: string, at: string) =>
      regeneration.recent(Number(id) as ConversationId, Number(at) as EntryId),
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
        await assertBranchIdentityAvailable(tx, requestId);
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
      // Preparation can fail even when an existing empty chat is reusable. Defer
      // that failure until the transaction establishes that creation is needed.
      const prepared = await modelPolicy?.prepareMainCreation().then(
        (decision) => ({ decision }),
        (error: unknown) => ({ error }),
      );
      const item = await harness.commit(async (tx) => {
        await assertBranchIdentityAvailable(tx, requestId);
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
        if (prepared && "error" in prepared) throw prepared.error;
        if (prepared && "decision" in prepared)
          await assertMainModelDecisionTx(tx, prepared.decision);
        const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const chosen = prepared && "decision" in prepared ? prepared.decision.selection : null;
        await configure(tx, record.id, {
          ...defaults,
          ...(chosen
            ? {
                model: { provider: chosen.provider, modelId: chosen.modelId },
                thinkingLevel: chosen.thinkingLevel,
              }
            : {}),
        });
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
