import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import {
  HandoffActionSchema,
  HandoffRecordSchema,
  RecordHandoffSchema,
  ReviewHandoffSchema,
  type HandoffRecord,
} from "../shared/handoffs.ts";

type Operation = { actor: number; id: string; fingerprint: string; record: HandoffRecord };
type State = { records: HandoffRecord[]; operations: Operation[] };
export const HandoffRecordsDoc = defineDoc<JsonRepresentation<State>>({
  kind: "cpd.thread-handoffs",
  version: 1,
  scope: "session",
  initial: () => ({ records: [], operations: [] }),
  checkpointWhen: () => true,
});
export type HandoffAction = "read" | "record" | "collect" | "review";
/** Required host hooks validate catalog lifecycle and real tangent/worker ownership on the SDK line. */
export type HandoffGuards = {
  assertAccess(tx: Tx, actor: ConversationId, action: HandoffAction): Promise<void>;
  assertRelationship(tx: Tx, parent: ConversationId, child: ConversationId): Promise<void>;
};
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
    await guards.assertRelationship(tx, parent as ConversationId, child as ConversationId);
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
