import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  LiveDoc,
  InboxDoc,
  defineDoc,
  type AgentState,
  type ConversationId,
  type EntryId,
  type Harness,
  type Tx,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  EditBranchRequestSchema,
  type EditBranchReceipt,
  type EditBranchRequest,
} from "../shared/branch-operations.ts";
import { admissionDigest, checkAdmissionRequest } from "./attachment-catalog.ts";

type Operation = {
  requestId: string;
  sourceId: number;
  entryId: number;
  payloadHash: string;
  branchId: number;
  forkEntryId: number | null;
  submissionId?: number;
};

// Only operation identities and a digest are stored here, not a second transcript.
export const BranchOperationsDoc = defineDoc<{ edits: Operation[] }>({
  kind: "cpd.branch-operations",
  version: 1,
  scope: "session",
  initial: () => ({ edits: [] }),
  checkpointWhen: () => true,
});

export class BranchOperationError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

// The integrating catalog owner must check lifecycle in the given transaction;
// register must atomically add the new branch to that same transaction.
export type BranchCatalogHooks = {
  requireActive(tx: Tx, id: ConversationId): Promise<void>;
  reserveBranchRequest(tx: Tx, request: EditBranchRequest): Promise<() => void>;
  registerEdit(
    tx: Tx,
    branch: {
      sourceId: ConversationId;
      branchId: ConversationId;
      entryId: EntryId;
      forkEntryId: EntryId | null;
    },
  ): Promise<void>;
};

function digest(request: EditBranchRequest) {
  return createHash("sha256")
    .update(JSON.stringify([request.sourceId, request.entryId, request.text]))
    .digest("hex");
}
function same(operation: Operation, request: EditBranchRequest) {
  return (
    operation.sourceId === Number(request.sourceId) &&
    operation.entryId === Number(request.entryId) &&
    operation.payloadHash === digest(request)
  );
}
function receipt(operation: Operation): EditBranchReceipt {
  return {
    type: "edit",
    sourceId: String(operation.sourceId),
    entryId: String(operation.entryId),
    branchId: String(operation.branchId),
    forkEntryId: operation.forkEntryId === null ? null : String(operation.forkEntryId),
    configuration: operation.forkEntryId === null ? "source-current-at-creation" : "fork-boundary",
    status: operation.submissionId === undefined ? "prepared" : "admitted",
    ...(operation.submissionId === undefined
      ? {}
      : { submissionId: String(operation.submissionId) }),
  };
}

export function editableUserEntry(entry: EntryRecord | undefined): boolean {
  const message = entry?.model?.[0];
  return (
    entry?.kind === "pi.user" &&
    entry.model?.length === 1 &&
    message?.role === "user" &&
    (typeof message.content === "string" ||
      (message.content.length > 0 && message.content.every((part) => part.type === "text")))
  );
}

export function createBranchOperations(harness: Harness, catalog: BranchCatalogHooks) {
  async function recent(sourceId: ConversationId, entryId: EntryId) {
    return harness.commit(async (tx) => {
      await catalog.requireActive(tx, sourceId);
      const operations = await tx.doc(BranchOperationsDoc);
      const results = [];
      for (const operation of [...operations.edits].reverse()) {
        if (operation.sourceId !== sourceId || operation.entryId !== entryId) continue;
        try {
          await catalog.requireActive(tx, operation.branchId as ConversationId);
        } catch (error) {
          if (error instanceof BranchOperationError) continue;
          throw error;
        }
        results.push({ ...receipt(operation), requestId: operation.requestId });
        if (results.length === 20) break;
      }
      return { operations: results };
    }, BACKGROUND_CONTEXT);
  }
  // This two-phase protocol is client-retry-resumable, not an autonomous SDK task.
  // No input is submitted during preparation or as a side effect of reads/reopen.
  async function prepareEdit(input: EditBranchRequest): Promise<EditBranchReceipt> {
    const request = EditBranchRequestSchema.parse(input);
    return harness.commit(async (tx) => {
      const sourceId = Number(request.sourceId) as ConversationId;
      const entryId = Number(request.entryId) as EntryId;
      await catalog.requireActive(tx, sourceId);
      const operations = await tx.doc(BranchOperationsDoc);
      const previous = operations.edits.find((item) => item.requestId === request.requestId);
      if (previous) {
        if (!same(previous, request))
          throw new BranchOperationError("Request identity does not match.", 409);
        await catalog.requireActive(tx, previous.branchId as ConversationId);
        return receipt(previous);
      }
      const target = await tx.scanEntries(
        { conversationId: sourceId, minEntryId: entryId, maxEntryId: entryId },
        1,
      );
      const entry = target.items[0];
      if (!entry) throw new BranchOperationError("Saved entry is not visible.", 404);
      // A whole pi.user entry with exactly one plain-text user message only.
      // Never silently remove siblings, image parts or custom entry semantics.
      if (!editableUserEntry(entry))
        throw new BranchOperationError("This entry cannot be edited safely.", 409);
      // Query two visible entries: the first is the target, the second its actual predecessor.
      const preceding = await tx.scanEntries(
        { conversationId: sourceId, maxEntryId: entryId, order: "descending" },
        2,
      );
      if (preceding.items[0]?.id !== entryId)
        throw new BranchOperationError("Saved entry is not visible.", 404);
      const at = preceding.items[1]?.id ?? null;
      const recordSource = await checkAdmissionRequest(
        tx,
        sourceId,
        request.requestId,
        admissionDigest(["branch-edit", request.sourceId, request.entryId, request.text]),
      );
      const recordBranch = await catalog.reserveBranchRequest(tx, request);
      // A first-entry edit has no as-of-before-first-entry API. Explicitly copy
      // the current saved state, captured in the same commit as branch creation.
      const current =
        at === null
          ? (JSON.parse(JSON.stringify(await tx.doc(AgentDoc, sourceId))) as AgentState)
          : undefined;
      const branch =
        at === null
          ? await tx.createConversation({ ownership: { kind: "ownerless" } })
          : await tx.forkConversation(sourceId, at, { ownership: { kind: "ownerless" } });
      if (current) Object.assign(await tx.doc(AgentDoc, branch.id), current);
      await catalog.registerEdit(tx, { sourceId, branchId: branch.id, entryId, forkEntryId: at });
      recordSource();
      recordBranch();
      const operation: Operation = {
        requestId: request.requestId,
        sourceId,
        entryId,
        payloadHash: digest(request),
        branchId: branch.id,
        forkEntryId: at,
      };
      operations.edits.push(operation);
      return receipt(operation);
    }, BACKGROUND_CONTEXT);
  }

  async function admitEdit(input: EditBranchRequest): Promise<EditBranchReceipt> {
    const request = EditBranchRequestSchema.parse(input);
    // Resolve the branch outside the transaction. All lifecycle/identity checks
    // and the submission + receipt write are repeated atomically inside it.
    const state = await harness.snapshot(BranchOperationsDoc, BACKGROUND_CONTEXT);
    const initial = state?.edits.find((item) => item.requestId === request.requestId);
    if (!initial || !same(initial, request))
      throw new BranchOperationError("Edit preparation unavailable.", 409);
    const conversation = await harness.conversation(
      initial.branchId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new BranchOperationError("Edit branch unavailable.", 404);
    return harness.commit(async (tx) => {
      await catalog.requireActive(tx, Number(request.sourceId) as ConversationId);
      const operations = await tx.doc(BranchOperationsDoc);
      const operation = operations.edits.find((item) => item.requestId === request.requestId);
      if (!operation || !same(operation, request) || operation.branchId !== conversation.id)
        throw new BranchOperationError("Edit preparation unavailable.", 409);
      await catalog.requireActive(tx, conversation.id);
      if (operation.submissionId !== undefined) return receipt(operation);
      // The prepared branch is visible to the catalog. Refuse to put the edit
      // after an intervening message, run, compaction, or queued input.
      const latest = await tx.latestEntryId(conversation.id);
      const live = await tx.doc(LiveDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      if (
        latest !== (operation.forkEntryId ?? undefined) ||
        live.run !== undefined ||
        !!live.compactions?.length ||
        inbox.items.length > 0
      )
        throw new BranchOperationError("Prepared edit branch changed before admission.", 409);
      const record = await checkAdmissionRequest(
        tx,
        conversation.id,
        request.requestId,
        admissionDigest(["branch-edit", request.sourceId, request.entryId, request.text]),
      );
      const id = await conversation.submit(tx, {
        type: "input",
        requestId: request.requestId,
        content: request.text,
        whenBusy: "reject",
      });
      record();
      operation.submissionId = id;
      return receipt(operation);
    }, BACKGROUND_CONTEXT);
  }
  async function edit(input: EditBranchRequest): Promise<EditBranchReceipt> {
    await prepareEdit(input);
    return admitEdit(input);
  }
  return { prepareEdit, admitEdit, edit, recent };
}
