import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  AgentDoc,
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { admissionDigest, checkAdmissionRequest } from "./attachment-catalog.ts";
import {
  RegenerationRequestSchema,
  type RegenerationReceipt,
  type RegenerationRequest,
} from "../shared/regeneration.ts";

type Operation = {
  requestId: string;
  sourceId: number;
  entryId: number;
  branchId: number;
  forkEntryId: number;
  agentDigest: string;
  headMarkerId: number | null;
  headId: number | null;
  submissionId?: number;
};

// Operation identities are not a transcript or a second execution queue.
export const RegenerationsDoc = defineDoc<{ operations: Operation[] }>({
  kind: "cpd.regenerations",
  version: 1,
  scope: "session",
  initial: () => ({ operations: [] }),
  checkpointWhen: () => true,
});

export class RegenerationError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

// Integration must use the same transaction to check catalog lifecycle and
// compose request identities with every existing branch-creation operation.
export type RegenerationCatalog = {
  requireActive(tx: Tx, id: ConversationId): Promise<void>;
  reserveBranchRequest(tx: Tx, request: RegenerationRequest): Promise<() => void>;
  register(
    tx: Tx,
    branch: {
      sourceId: ConversationId;
      entryId: EntryId;
      branchId: ConversationId;
      forkEntryId: EntryId;
    },
  ): Promise<void>;
};

function receipt(operation: Operation): RegenerationReceipt {
  return {
    type: "regenerate",
    sourceId: String(operation.sourceId),
    entryId: String(operation.entryId),
    branchId: String(operation.branchId),
    forkEntryId: String(operation.forkEntryId),
    status: operation.submissionId === undefined ? "prepared" : "admitted",
    ...(operation.submissionId === undefined
      ? {}
      : { submissionId: String(operation.submissionId) }),
  };
}

// First slice supports one completed, nonempty, text-only assistant message.
// Reasoning, tool calls, multimessage entries and other formats are unsupported.
// A later confirmation must warn that continued generation may repeat external
// tool effects; prior effects are not undone and exactly-once is not promised.
export function regenerableAnswer(entry: EntryRecord | undefined): boolean {
  const message = entry?.model?.[0];
  return (
    entry?.kind === "pi.assistant" &&
    entry.model?.length === 1 &&
    message?.role === "assistant" &&
    message.stopReason === "stop" &&
    message.content.length > 0 &&
    message.content.every((part) => part.type === "text") &&
    message.content.some((part) => part.type === "text" && part.text.trim().length > 0)
  );
}

export function createRegeneration(harness: Harness, catalog: RegenerationCatalog) {
  async function prepare(input: RegenerationRequest): Promise<RegenerationReceipt> {
    const request = RegenerationRequestSchema.parse(input);
    const sourceId = Number(request.sourceId) as ConversationId;
    const entryId = Number(request.entryId) as EntryId;
    const source = await harness.conversation(sourceId, BACKGROUND_CONTEXT);
    if (!source) throw new RegenerationError("Source unavailable.", 404);
    const page = await source.entries(
      { maxEntryId: entryId, order: "descending" },
      2,
      undefined,
      BACKGROUND_CONTEXT,
    );
    if (page.items[0]?.id !== entryId) throw new RegenerationError("Answer is not visible.", 404);
    if (!regenerableAnswer(page.items[0]))
      throw new RegenerationError("This answer format is not supported for regeneration.", 409);
    const at = page.items[1]?.id;
    if (at === undefined) throw new RegenerationError("Unanswered context unavailable.", 409);
    // Public SDK as-of view is exactly the context inherited by fork(at).
    const view = await source.context(BACKGROUND_CONTEXT, { at });
    const tail = view.messages.at(-1);
    if (tail?.role !== "user" && tail?.role !== "toolResult")
      throw new RegenerationError("Preceding context is not unanswered.", 409);
    return harness.commit(async (tx) => {
      await catalog.requireActive(tx, sourceId);
      const operations = await tx.doc(RegenerationsDoc);
      const existing = operations.operations.find((item) => item.requestId === request.requestId);
      if (existing) {
        if (existing.sourceId !== sourceId || existing.entryId !== entryId)
          throw new RegenerationError("Request identity does not match.", 409);
        await catalog.requireActive(tx, existing.branchId as ConversationId);
        return receipt(existing);
      }
      const visible = await tx.scanEntries(
        { conversationId: sourceId, maxEntryId: entryId, order: "descending" },
        2,
      );
      if (
        visible.items[0]?.id !== entryId ||
        visible.items[1]?.id !== at ||
        !regenerableAnswer(visible.items[0])
      )
        throw new RegenerationError("Answer boundary changed.", 409);
      const recordSource = await checkAdmissionRequest(
        tx,
        sourceId,
        request.requestId,
        admissionDigest(["regenerate", request.sourceId, request.entryId]),
      );
      const recordBranchRequest = await catalog.reserveBranchRequest(tx, request);
      const branch = await tx.forkConversation(sourceId, at, { ownership: { kind: "ownerless" } });
      const agentDigest = admissionDigest(await tx.doc(AgentDoc, branch.id));
      await catalog.register(tx, { sourceId, entryId, branchId: branch.id, forkEntryId: at });
      recordSource();
      recordBranchRequest();
      const operation: Operation = {
        requestId: request.requestId,
        sourceId,
        entryId,
        branchId: branch.id,
        forkEntryId: at,
        agentDigest,
        headMarkerId: view.head?.id ?? null,
        headId: view.head?.head ?? null,
      };
      operations.operations.push(operation);
      return receipt(operation);
    }, BACKGROUND_CONTEXT);
  }

  async function admit(input: RegenerationRequest): Promise<RegenerationReceipt> {
    const request = RegenerationRequestSchema.parse(input);
    const state = await harness.snapshot(RegenerationsDoc, BACKGROUND_CONTEXT);
    const initial = state?.operations.find((item) => item.requestId === request.requestId);
    if (
      !initial ||
      initial.sourceId !== Number(request.sourceId) ||
      initial.entryId !== Number(request.entryId)
    )
      throw new RegenerationError("Preparation unavailable.", 409);
    const branch = await harness.conversation(
      initial.branchId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (!branch) throw new RegenerationError("Branch unavailable.", 404);
    return harness.commit(async (tx) => {
      await catalog.requireActive(tx, initial.sourceId as ConversationId);
      const operation = (await tx.doc(RegenerationsDoc)).operations.find(
        (item) => item.requestId === request.requestId,
      );
      if (
        !operation ||
        operation.branchId !== branch.id ||
        operation.sourceId !== initial.sourceId ||
        operation.entryId !== initial.entryId
      )
        throw new RegenerationError("Preparation unavailable.", 409);
      await catalog.requireActive(tx, branch.id);
      if (operation.submissionId !== undefined) return receipt(operation);
      const latest = await tx.latestEntryId(branch.id);
      const live = await tx.doc(LiveDoc, branch.id);
      const inbox = await tx.doc(InboxDoc, branch.id);
      const head = await tx.latestHeadMarker(branch.id);
      const agentDigest = admissionDigest(await tx.doc(AgentDoc, branch.id));
      if (
        latest !== operation.forkEntryId ||
        live.run ||
        live.compactions?.length ||
        inbox.items.length ||
        (head?.id ?? null) !== operation.headMarkerId ||
        (head?.head ?? null) !== operation.headId ||
        agentDigest !== operation.agentDigest
      )
        throw new RegenerationError("Prepared branch changed before admission.", 409);
      const record = await checkAdmissionRequest(
        tx,
        branch.id,
        request.requestId,
        admissionDigest(["regenerate", request.sourceId, request.entryId]),
      );
      const submissionId = await branch.submit(tx, {
        type: "continue",
        requestId: request.requestId,
      });
      record();
      operation.submissionId = submissionId;
      return receipt(operation);
    }, BACKGROUND_CONTEXT);
  }

  async function recent(sourceId: ConversationId, entryId: EntryId) {
    return harness.commit(async (tx) => {
      await catalog.requireActive(tx, sourceId);
      const results = [];
      for (const item of [...(await tx.doc(RegenerationsDoc)).operations].reverse()) {
        if (item.sourceId !== sourceId || item.entryId !== entryId) continue;
        try {
          await catalog.requireActive(tx, item.branchId as ConversationId);
        } catch (error) {
          if (error instanceof RegenerationError) continue;
          throw error;
        }
        results.push({ ...receipt(item), requestId: item.requestId });
        if (results.length === 20) break;
      }
      return { operations: results };
    }, BACKGROUND_CONTEXT);
  }

  return { prepare, admit, recent };
}
