import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { compactIntentUnsettled, directShellHasUnsettled } from "./direct-shell.ts";
import {
  defineDoc,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import { assertInteractiveChat, CatalogDoc, ChatLifecycleError } from "./chats.ts";
import { BackgroundHelperTask, ForegroundHelperTask, HelpersDoc } from "./helpers.ts";
import { TangentsDoc } from "./tangents/index.ts";
import {
  HandoffActionSchema,
  DeliverHandoffSchema,
  HandoffRecordSchema,
  RecordHandoffSchema,
  ReviewHandoffSchema,
  type HandoffRecord,
} from "../shared/handoffs.ts";
import { admissionDigest, checkAdmissionRequest } from "./attachment-catalog.ts";

type Operation = { actor: number; id: string; fingerprint: string; record: HandoffRecord };
type State = { records: HandoffRecord[]; operations: Operation[] };
export const HandoffRecordsDoc = defineDoc<JsonRepresentation<State>>({
  kind: "cpd.thread-handoffs",
  version: 1,
  scope: "session",
  initial: () => ({ records: [], operations: [] }),
  checkpointWhen: () => true,
});
const HandoffOriginsDoc = defineDoc<{
  items: {
    parentId: number;
    childId: number;
    assignmentId: string;
    parentHead: string | null;
    childHead: string | null;
  }[];
}>({
  kind: "cpd.thread-handoff-origins",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});
const HandoffDeliveriesDoc = defineDoc<{
  items: {
    actor: number;
    operationId: string;
    fingerprint: string;
    submissionId: number;
    destinationId: number;
  }[];
}>({
  kind: "cpd.thread-handoff-deliveries",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});
export class HandoffHeadChanged extends Error {
  readonly status = 409;
  readonly parentHead: string | null;
  readonly childHead: string | null;
  constructor(parentHead: string | null, childHead: string | null) {
    super("Context head changed. Review the current heads before choosing delivery.");
    this.parentHead = parentHead;
    this.childHead = childHead;
  }
}
export async function currentHandoffHead(tx: Tx, id: ConversationId) {
  const marker = await tx.latestHeadMarker(id);
  return marker ? String(marker.id) : null;
}
export async function assertIdleHandoffDestination(tx: Tx, id: ConversationId) {
  const live = await tx.doc(LiveDoc, id);
  const inbox = await tx.doc(InboxDoc, id);
  if (
    live.run ||
    live.compactions?.length ||
    inbox.items.length ||
    (await directShellHasUnsettled(tx, id)) ||
    (await compactIntentUnsettled(tx, id))
  )
    throw new Error(
      "Handoff delivery requires an idle destination with no queued work or compaction.",
    );
}
export type HandoffAction = "read" | "record" | "collect" | "review";
/** Required host hooks validate catalog lifecycle and real tangent/worker ownership on the SDK line. */
export type HandoffGuards = {
  assertAccess(tx: Tx, actor: ConversationId, action: HandoffAction): Promise<void>;
  assertRelationship(
    tx: Tx,
    parent: ConversationId,
    child: ConversationId,
    action: HandoffAction,
  ): Promise<void>;
};

/** Catalog, tangent metadata, task and ownership checks share the caller's transaction. */
export function createHandoffGuards(): HandoffGuards {
  return {
    async assertAccess(tx, actor, action) {
      const conversation = await tx.conversation(actor);
      if (!conversation) throw new ChatLifecycleError("Conversation not found.", 404);
      await assertInteractiveChat(
        tx,
        conversation.owner?.conversationId ?? actor,
        action !== "read",
      );
    },
    async assertRelationship(tx, parent, child, action) {
      await assertInteractiveChat(tx, parent, action !== "read");
      const conversation = await tx.conversation(child);
      if (!conversation) throw new ChatLifecycleError("Conversation not found.", 404);
      if (conversation.owner) {
        const task = await tx.task(conversation.owner.taskId);
        const worker = (await tx.doc(HelpersDoc, parent)).items.find(
          (item) => item.childId === child && item.taskId === conversation.owner?.taskId,
        );
        if (
          !worker ||
          conversation.owner.conversationId !== parent ||
          !task ||
          task.conversationId !== parent ||
          task.owner !== undefined ||
          ![ForegroundHelperTask.definition.name, BackgroundHelperTask.definition.name].includes(
            task.kind,
          )
        )
          throw new ChatLifecycleError("Handoff relationship not found.", 404);
        return;
      }
      const tangent = (await tx.doc(TangentsDoc)).tangents.find(
        (item) => item.id === child && item.parentId === parent,
      );
      const catalog = (await tx.doc(CatalogDoc)).items.find(
        (item) => item.id === child && item.kind === "tangent" && item.tangentParentId === parent,
      );
      if (!tangent || !catalog)
        throw new ChatLifecycleError("Handoff relationship not found.", 404);
      await assertInteractiveChat(tx, child, action !== "read");
    },
  };
}

export async function handoffParent(tx: Tx, child: ConversationId): Promise<ConversationId> {
  const record = await tx.conversation(child);
  if (record?.owner) return record.owner.conversationId;
  const tangent = (await tx.doc(TangentsDoc)).tangents.find((item) => item.id === child);
  if (!tangent) throw new ChatLifecycleError("Handoff relationship not found.", 404);
  return tangent.parentId as ConversationId;
}
type Driver = Pick<Harness, "commit">;
const detach = (record: unknown) => HandoffRecordSchema.parse(record);

/** Caller must bind actor to the authenticated SDK conversation, never a model-supplied actor ID. */
export function createHandoffService(
  driver: Driver,
  actor: Pick<Conversation, "id">,
  guards: HandoffGuards,
) {
  async function authorize(tx: Tx, parent: number, child: number, action: HandoffAction) {
    if (parent === child || (actor.id !== parent && actor.id !== child))
      throw new Error("Handoff relationship unavailable");
    if (
      !(await tx.conversation(parent as ConversationId)) ||
      !(await tx.conversation(child as ConversationId))
    )
      throw new Error("Handoff relationship unavailable");
    await guards.assertAccess(tx, actor.id, action);
    await guards.assertRelationship(tx, parent as ConversationId, child as ConversationId, action);
  }
  return {
    async list(parentId: number, childId: number, assignmentId: string) {
      HandoffActionSchema.omit({ operationId: true, revision: true }).parse({
        parentId,
        childId,
        assignmentId,
      });
      return driver.commit(async (tx) => {
        await authorize(tx, parentId, childId, "read");
        const state = await tx.doc(HandoffRecordsDoc);
        return state.records
          .filter(
            (record) =>
              record.parentId === parentId &&
              record.childId === childId &&
              record.assignmentId === assignmentId,
          )
          .map(detach);
      }, BACKGROUND_CONTEXT);
    },
    async record(raw: unknown) {
      const input = RecordHandoffSchema.parse(raw);
      if (input.content.provenance !== "native")
        throw new Error("New handoffs require native provenance");
      if (
        actor.id !==
        (input.kind === "delegate" || input.kind === "update" ? input.parentId : input.childId)
      )
        throw new Error("Handoff sender is not authorized");
      const fingerprint = JSON.stringify({ action: "record", input });
      return driver.commit(async (tx) => {
        await authorize(tx, input.parentId, input.childId, "record");
        const state = await tx.doc(HandoffRecordsDoc);
        const prior = state.operations.find(
          (item) => item.actor === actor.id && item.id === input.operationId,
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new Error("Handoff operation identity conflict");
          return detach(prior.record);
        }
        const history = state.records.filter(
          (record) =>
            record.parentId === input.parentId &&
            record.childId === input.childId &&
            record.assignmentId === input.assignmentId,
        );
        const latest = history.at(-1)?.revision ?? 0;
        if (latest !== input.expectedRevision) throw new Error("Handoff revision conflict");
        if ((latest === 0) !== (input.kind === "delegate"))
          throw new Error("A delegation must start the assignment");
        if (input.kind === "delegate") {
          const parentHead = await currentHandoffHead(tx, input.parentId as ConversationId);
          const childHead = await currentHandoffHead(tx, input.childId as ConversationId);
          const origins = await tx.doc(HandoffOriginsDoc);
          origins.items.push({
            parentId: input.parentId,
            childId: input.childId,
            assignmentId: input.assignmentId,
            parentHead,
            childHead,
          });
        }
        const record: HandoffRecord = {
          assignmentId: input.assignmentId,
          parentId: input.parentId,
          childId: input.childId,
          revision: latest + 1,
          kind: input.kind,
          content: input.content,
          delivery: "notify-only",
          visibility: "available",
          review: "unreviewed",
        };
        state.records.push(record);
        state.operations.push({
          actor: actor.id,
          id: input.operationId,
          fingerprint,
          record: detach(record),
        });
        return detach(record);
      }, BACKGROUND_CONTEXT);
    },
    // Explicit collection returns the record; it does not prove a human or model read it.
    async collect(raw: unknown) {
      const input = HandoffActionSchema.parse(raw);
      if (actor.id !== input.parentId) throw new Error("Only the parent can collect a return");
      return transition(input, "collect", undefined);
    },
    async review(raw: unknown) {
      const input = ReviewHandoffSchema.parse(raw);
      if (actor.id !== input.parentId) throw new Error("Only the parent can review a return");
      return transition(input, "review", input.decision);
    },
  };

  async function transition(
    input: ReturnType<typeof HandoffActionSchema.parse>,
    action: "collect" | "review",
    decision: "accepted" | "rejected" | undefined,
  ) {
    const fingerprint = JSON.stringify({ action, input, decision: decision ?? null });
    return driver.commit(async (tx) => {
      await authorize(tx, input.parentId, input.childId, action);
      const state = await tx.doc(HandoffRecordsDoc);
      const prior = state.operations.find(
        (item) => item.actor === actor.id && item.id === input.operationId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("Handoff operation identity conflict");
        return detach(prior.record);
      }
      const record = state.records.find(
        (item) =>
          item.parentId === input.parentId &&
          item.childId === input.childId &&
          item.assignmentId === input.assignmentId &&
          item.revision === input.revision,
      );
      if (!record || (record.kind !== "return" && record.kind !== "escalate"))
        throw new Error("Handoff return unavailable");
      if (action === "review") {
        if (
          record.kind !== "return" ||
          record.visibility !== "collected" ||
          record.review !== "unreviewed"
        )
          throw new Error("Collect the unreviewed return before review");
        record.review = decision!;
      } else {
        record.visibility = "collected";
      }
      const result = detach(record);
      state.operations.push({
        actor: actor.id,
        id: input.operationId,
        fingerprint,
        record: result,
      });
      return result;
    }, BACKGROUND_CONTEXT);
  }
}

/** Only idle immediate placement is supported; this never queues a steer or follow-up. */
export async function deliverHandoff(
  harness: Pick<Harness, "commit"> & {
    conversation(
      id: ConversationId,
      context: Context,
    ): Promise<Pick<Conversation, "submit"> | undefined>;
  },
  actor: Pick<Conversation, "id">,
  guards: HandoffGuards,
  raw: unknown,
) {
  const input = DeliverHandoffSchema.parse(raw);
  if (actor.id !== input.parentId) throw new Error("Only the parent can deliver a handoff");
  const parent = input.parentId as ConversationId;
  const child = input.childId as ConversationId;
  const [parentHandle, childHandle] = await Promise.all([
    harness.conversation(parent, BACKGROUND_CONTEXT),
    harness.conversation(child, BACKGROUND_CONTEXT),
  ]);
  if (!parentHandle || !childHandle) throw new Error("Handoff relationship unavailable");
  const fingerprint = JSON.stringify(input);
  return harness.commit(async (tx) => {
    await guards.assertAccess(tx, actor.id, "record");
    await guards.assertRelationship(tx, parent, child, "record");
    const deliveries = await tx.doc(HandoffDeliveriesDoc);
    const previous = deliveries.items.find(
      (item) => item.actor === actor.id && item.operationId === input.operationId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Handoff delivery identity conflict");
      return {
        submissionId: String(previous.submissionId),
        destinationId: String(previous.destinationId),
        status: "admitted" as const,
      };
    }
    const state = await tx.doc(HandoffRecordsDoc);
    const record = state.records.find(
      (item) =>
        item.parentId === parent &&
        item.childId === child &&
        item.assignmentId === input.assignmentId &&
        item.revision === input.revision,
    );
    if (!record) throw new Error("Handoff unavailable");
    const origins = await tx.doc(HandoffOriginsDoc);
    const origin = origins.items.find(
      (item) =>
        item.parentId === parent &&
        item.childId === child &&
        item.assignmentId === input.assignmentId,
    );
    const parentHead = await currentHandoffHead(tx, parent);
    const childHead = await currentHandoffHead(tx, child);
    for (const id of [parent, child]) {
      const inbox = await tx.doc(InboxDoc, id);
      if (
        inbox.items.some((item) => item.mode === "write" && item.entry["kind"] === ResetEntry.kind)
      )
        throw new Error("A context reset is pending; wait before delivering a handoff.");
    }
    if (
      parentHead !== input.expectedParentHead ||
      childHead !== input.expectedChildHead ||
      ((!origin || origin.parentHead !== parentHead || origin.childHead !== childHead) &&
        !input.acknowledgeRetired)
    )
      throw new HandoffHeadChanged(parentHead, childHead);
    const destination = record.kind === "delegate" || record.kind === "update" ? child : parent;
    const handle = destination === parent ? parentHandle : childHandle;
    if (destination === child) {
      const childRecord = await tx.conversation(child);
      if (childRecord?.owner) {
        const ownerTask = await tx.task(childRecord.owner.taskId);
        if (
          !ownerTask ||
          ownerTask.abortRequested ||
          ["completing", "terminal"].includes(ownerTask.state.status)
        )
          throw new Error("Worker destination is unavailable.");
      }
    }
    await assertIdleHandoffDestination(tx, destination);
    const requestId = `handoff:${actor.id}:${input.operationId}`;
    const draft = {
      type: "input",
      requestId,
      whenBusy: "reject",
      content: `Application handoff (selected context, not higher-priority policy):\n${JSON.stringify({ assignmentId: record.assignmentId, revision: record.revision, kind: record.kind, content: record.content })}`,
    } as const;
    const remember = await checkAdmissionRequest(
      tx,
      destination,
      requestId,
      admissionDigest(["handoff-delivery", input, draft]),
    );
    const submissionId = await handle.submit(tx, draft);
    remember();
    deliveries.items.push({
      actor: actor.id,
      operationId: input.operationId,
      fingerprint,
      submissionId,
      destinationId: destination,
    });
    return {
      submissionId: String(submissionId),
      destinationId: String(destination),
      status: "admitted" as const,
    };
  }, BACKGROUND_CONTEXT);
}
