import { isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryId,
  type Harness,
  type SubmissionId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { admissionDigest, checkAdmissionRequest } from "../attachment-catalog.ts";
import {
  assertIdleHandoffDestination,
  currentHandoffHead,
  HandoffHeadChanged,
} from "../handoffs.ts";
import {
  CreateTangentSchema,
  ResolvedTangentModelSchema,
  ReturnHandoffSchema,
  type CreateTangent,
  type Handoff,
  type ResolvedTangentModel,
} from "../../shared/tangents.ts";

type HandoffVersion = {
  revision: number;
  kind: "delegate" | "return";
  requestId: string;
  handoff: Handoff;
  delivery: "available" | "admitted";
  submissionId?: number;
  accepted: boolean;
  deliveryChoice?: string;
};
type Tangent = {
  id: number;
  parentId: number;
  sourceId: number;
  sourceEntryId: number | null;
  title: string;
  requestId: string;
  fingerprint: string;
  cwd: string;
  model: ResolvedTangentModel;
  initialAgent: string;
  originParentHead?: string | null;
  lifecycle: "open" | "concluded" | "archived";
  attention: "unread" | "needs-answer" | "report-ready" | "none";
  start: boolean;
  startSubmissionId?: number;
  startRequestId?: string;
  versions: HandoffVersion[];
};
type State = { tangents: Tangent[] };
export const TangentsDoc = defineDoc<JsonRepresentation<State>>({
  kind: "cpd.tangents",
  version: 1,
  scope: "session",
  initial: () => ({ tangents: [] }),
  checkpointWhen: () => true,
});

/** Hooks run inside the same commit. assertMain must reject missing, archived and deleted mains.
 * register must add the ownerless conversation to the host catalog without table reads after creation.
 * parent lifecycle operations must call inspectParentTangents in their own transaction. */
export type TangentHooks = {
  assertMain(tx: Tx, mainId: ConversationId): Promise<void>;
  assertMainReadable(tx: Tx, mainId: ConversationId): Promise<void>;
  isMainReadOnly(tx: Tx, mainId: ConversationId): Promise<boolean>;
  register(
    tx: Tx,
    tangent: { id: ConversationId; parentId: ConversationId; title: string },
  ): Promise<void>;
  resolveModel(): Promise<ResolvedTangentModel>;
  assertResolvedModel(tx: Tx, resolved: ResolvedTangentModel): Promise<void>;
  assertCaller(
    tx: Tx,
    caller: ConversationId,
    parent: ConversationId,
    tangent: ConversationId,
    action: "return" | "deliver" | "accept" | "lifecycle" | "read" | "start",
  ): Promise<void>;
  assertNoUnsettled?(tx: Tx, tangent: ConversationId): Promise<void>;
  onLifecycle?(
    tx: Tx,
    tangent: ConversationId,
    next: "open" | "concluded" | "archived",
  ): Promise<void>;
  cwd(sourceCwd: string | undefined): string;
};
type Driver =
  | Pick<Harness, "commit" | "conversation">
  | Pick<ToolExecutionApi, "commit" | "conversation">;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const handoffText = (kind: string, handoff: Handoff) =>
  `Application ${kind} handoff (selected project guidance, not higher-priority policy):\n${JSON.stringify(handoff)}`;

export async function inspectParentTangents(tx: Tx, parentId: ConversationId) {
  const doc = await tx.doc(TangentsDoc);
  const result: { id: number; lifecycle: "open"; running: boolean }[] = [];
  for (const item of doc.tangents.filter(
    (t) => t.parentId === parentId && t.lifecycle === "open",
  )) {
    const live = await tx.doc(LiveDoc, item.id as ConversationId);
    const inbox = await tx.doc(InboxDoc, item.id as ConversationId);
    result.push({
      id: item.id,
      lifecycle: "open",
      running: !!live.run || !!live.compactions?.length || inbox.items.length > 0,
    });
  }
  return result;
}

/** Prepare commits ownerless conversation, selected handoff, configuration and catalog link atomically.
 * Ownerless ownership intentionally prevents Stop on the source run from cascading into the tangent. */
export async function prepareTangent(
  driver: Pick<Driver, "commit">,
  input: unknown,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  const request = CreateTangentSchema.parse(input);
  const fingerprint = JSON.stringify(request);
  const previous = await driver.commit(async (tx) => {
    await hooks.assertMain(tx, request.parentId as ConversationId);
    const state = await tx.doc(TangentsDoc);
    const existing = state.tangents.find((item) => item.requestId === request.requestId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint)
      throw new Error("Request identity conflicts with prior tangent");
    if (existing.lifecycle !== "open") throw new Error("Tangent is not open");
    return copy(existing);
  }, context);
  if (previous) return previous;
  const resolved = ResolvedTangentModelSchema.parse(await hooks.resolveModel());
  if (resolved.assignment !== "tangent") throw new Error("Tangent model assignment required");
  return driver.commit(async (tx) => {
    const parentId = request.parentId as ConversationId;
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    if (state.tangents.some((item) => item.id === parentId))
      throw new Error("Nested tangents are unsupported");
    if (request.sourceId !== request.parentId)
      throw new Error("Source must be the parent main conversation");
    const existing = state.tangents.find((item) => item.requestId === request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Request identity conflicts with prior tangent");
      if (existing.lifecycle !== "open") throw new Error("Tangent is not open");
      return copy(existing);
    }
    const at = request.sourceEntryId as EntryId | null;
    if (at === null) {
      if (await tx.latestEntryId(parentId)) throw new Error("Source is no longer empty");
    } else {
      const visible = await tx.scanEntries(
        { conversationId: parentId, minEntryId: at, maxEntryId: at },
        1,
      );
      if (!visible.items.some((entry) => entry.id === at))
        throw new Error("Source boundary is not visible");
    }
    const sourceAgent = await tx.doc(AgentDoc, parentId);
    await hooks.assertResolvedModel(tx, resolved);
    const originParentHead = await currentHandoffHead(tx, parentId);
    const model = resolved.selection;
    const cwd = hooks.cwd(sourceAgent.cwd);
    if (!model.provider || !model.modelId || !isAbsolute(cwd))
      throw new Error("Tangent model and absolute cwd policy are required");
    const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, created.id, {
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel: model.thinkingLevel,
      cwd,
    });
    const initialAgent = JSON.stringify(await tx.doc(AgentDoc, created.id));
    const item: Tangent = {
      id: created.id,
      parentId,
      sourceId: request.sourceId,
      sourceEntryId: at,
      title: request.title,
      requestId: request.requestId,
      fingerprint,
      cwd,
      model: resolved,
      initialAgent,
      originParentHead,
      lifecycle: "open",
      attention: "unread",
      start: request.start,
      versions: [
        {
          revision: 1,
          kind: "delegate",
          requestId: request.requestId,
          handoff: request.handoff,
          delivery: "available",
          accepted: false,
        },
      ],
    };
    await hooks.register(tx, { id: created.id, parentId, title: request.title });
    state.tangents.push(copy(item) as JsonRepresentation<Tangent>);
    return copy(item);
  }, context);
}

/** Admission is separate from preparation: submission happens before any table write and returns before completion. */
export async function admitTangentStart(
  driver: Driver,
  request: CreateTangent,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  const parsed = CreateTangentSchema.parse(request);
  const prepared = await prepareTangent(driver, parsed, hooks, context);
  if (!prepared.start) return prepared;
  return startPreparedTangent(
    driver,
    parsed.parentId as ConversationId,
    prepared.id as ConversationId,
    `create:${parsed.requestId}`,
    1,
    hooks,
    context,
  );
}

/** Start a previously prepared tangent without changing its creation identity. */
export async function startPreparedTangent(
  driver: Driver,
  parentId: ConversationId,
  tangentId: ConversationId,
  requestId: string,
  expectedRevision: number,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  const child = await driver.conversation(tangentId, context);
  if (!child) throw new Error("Prepared tangent unavailable");
  return driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    await hooks.assertCaller(tx, parentId, parentId, tangentId, "start");
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === tangentId && t.parentId === parentId);
    if (
      !item ||
      item.lifecycle !== "open" ||
      item.versions[0]?.revision !== expectedRevision ||
      item.versions[0]?.kind !== "delegate"
    )
      throw new Error("Prepared tangent changed");
    if (item.startSubmissionId !== undefined) {
      if (item.startRequestId !== undefined && item.startRequestId !== requestId)
        throw new Error("Tangent start identity conflicts with prior request");
      return copy(item);
    }
    // Creation pinned this agent; subsequent global defaults apply only to new tangents.
    const childId = item.id as ConversationId;
    const agent = await tx.doc(AgentDoc, childId);
    const inbox = await tx.doc(InboxDoc, childId);
    const live = await tx.doc(LiveDoc, childId);
    if (
      JSON.stringify(agent) !== item.initialAgent ||
      (await tx.latestEntryId(childId)) ||
      inbox.items.length ||
      live.run ||
      live.compactions?.length
    )
      throw new Error("Prepared tangent was changed before initial admission");
    const draft = {
      type: "input",
      requestId: `tangent-start:${item.id}`,
      content: handoffText("delegate", item.versions[0]!.handoff),
      whenBusy: "reject",
    } as const;
    const record = await checkAdmissionRequest(
      tx,
      childId,
      draft.requestId,
      admissionDigest(["tangent-start", draft]),
    );
    const submission = await child.submit(tx, draft);
    record();
    item.startSubmissionId = submission;
    item.startRequestId = requestId;
    item.versions[0]!.delivery = "admitted";
    item.versions[0]!.submissionId = submission;
    return copy(item);
  }, context);
}

export async function listTangents(
  driver: Pick<Harness, "commit">,
  parentId: ConversationId,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  return driver.commit(async (tx) => {
    await hooks.assertMainReadable(tx, parentId);
    const parentReadOnly = await hooks.isMainReadOnly(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    const result: {
      tangent: Tangent;
      activity: "running" | "waiting" | "idle" | "interrupted" | "failed";
      readOnly: boolean;
    }[] = [];
    for (const item of state.tangents.filter((t) => t.parentId === parentId)) {
      const live = await tx.doc(LiveDoc, item.id as ConversationId);
      const inbox = await tx.doc(InboxDoc, item.id as ConversationId);
      const failure = live.runFailure?.reason;
      const activity = live.run
        ? live.tools?.some((tool) => tool.name === "ask_user" && tool.status === "running")
          ? "waiting"
          : "running"
        : live.compactions?.length
          ? "running"
          : inbox.items.length
            ? "waiting"
            : failure === "aborted" || failure === "interrupted"
              ? "interrupted"
              : failure
                ? "failed"
                : "idle";
      result.push({
        tangent: copy(item),
        activity,
        readOnly: parentReadOnly || item.lifecycle !== "open",
      });
    }
    return result;
  }, context);
}

/** A return is notification-only: app metadata, no parent context or model run. */
export async function recordReturn(
  driver: Pick<Driver, "commit">,
  caller: ConversationId,
  parentId: ConversationId,
  input: unknown,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  const request = ReturnHandoffSchema.parse(input);
  return driver.commit(async (tx) => {
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === request.tangentId);
    if (!item || item.parentId !== parentId) throw new Error("Tangent not found");
    if (caller !== item.id) throw new Error("Caller is not the tangent");
    await hooks.assertCaller(
      tx,
      caller,
      item.parentId as ConversationId,
      item.id as ConversationId,
      "return",
    );
    await hooks.assertMain(tx, item.parentId as ConversationId);
    if (item.lifecycle !== "open") throw new Error("Tangent is not open");
    const prior = item.versions.find((version) => version.requestId === request.requestId);
    if (prior) {
      if (
        prior.kind !== "return" ||
        JSON.stringify(prior.handoff) !== JSON.stringify(request.handoff) ||
        prior.revision !== request.expectedRevision + 1
      )
        throw new Error("Return request identity conflicts");
      return copy(prior);
    }
    if (item.versions.length !== request.expectedRevision)
      throw new Error("Stale handoff revision");
    const version: HandoffVersion = {
      revision: item.versions.length + 1,
      kind: "return",
      requestId: request.requestId,
      handoff: request.handoff,
      delivery: "available",
      accepted: false,
    };
    item.versions.push(copy(version) as JsonRepresentation<HandoffVersion>);
    item.attention = "report-ready";
    return copy(version);
  }, context);
}

/** Selected return admission is explicit; admitted does not mean processed or accepted. */
export async function deliverReturn(
  driver: Driver,
  caller: ConversationId,
  parentId: ConversationId,
  tangentId: ConversationId,
  revision: number,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
  choice?: { expectedHead: string | null; acknowledgeRetired: boolean },
) {
  if (caller !== parentId) throw new Error("Caller is not the parent");
  const parent = await driver.conversation(parentId, context);
  if (!parent) throw new Error("Parent unavailable");
  return driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === tangentId && t.parentId === parentId);
    if (item) await hooks.assertCaller(tx, caller, parentId, tangentId, "deliver");
    const version = item?.versions.find((v) => v.revision === revision && v.kind === "return");
    if (!item || !version || item.lifecycle !== "open") throw new Error("Return unavailable");
    const choiceKey = JSON.stringify(choice ?? null);
    if (version.submissionId !== undefined) {
      if (version.deliveryChoice !== undefined && version.deliveryChoice !== choiceKey)
        throw new Error("Return delivery identity conflicts");
      return copy(version);
    }
    const parentHead = await currentHandoffHead(tx, parentId);
    if (
      (choice && choice.expectedHead !== parentHead) ||
      ((item.originParentHead === undefined || item.originParentHead !== parentHead) &&
        !choice?.acknowledgeRetired)
    )
      throw new HandoffHeadChanged(parentHead, null);
    await assertIdleHandoffDestination(tx, parentId);
    const draft = {
      type: "input",
      requestId: `tangent-return:${tangentId}:${revision}`,
      content: handoffText("return", version.handoff),
      whenBusy: "reject",
    } as const;
    const record = await checkAdmissionRequest(
      tx,
      parentId,
      draft.requestId,
      admissionDigest(["tangent-return", draft, choice ?? null]),
    );
    const submission = await parent.submit(tx, draft);
    record();
    version.delivery = "admitted";
    version.submissionId = submission;
    version.deliveryChoice = choiceKey;
    return copy(version);
  }, context);
}

/** Explicit parent review decision; admission alone never implies acceptance. */
export async function acceptReturn(
  driver: Pick<Driver, "commit">,
  caller: ConversationId,
  parentId: ConversationId,
  tangentId: ConversationId,
  revision: number,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  if (caller !== parentId) throw new Error("Caller is not the parent");
  return driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === tangentId && t.parentId === parentId);
    if (item) await hooks.assertCaller(tx, caller, parentId, tangentId, "accept");
    const version = item?.versions.find((v) => v.revision === revision && v.kind === "return");
    if (!item || !version || version.delivery !== "admitted")
      throw new Error("Return has not been admitted");
    const submission =
      version.submissionId === undefined
        ? undefined
        : await tx.submission(version.submissionId as SubmissionId);
    if (!submission?.entry) throw new Error("Return has not been placed in the parent context");
    version.accepted = true;
    return copy(version);
  }, context);
}

export async function returnDeliveryStatus(
  driver: Pick<Driver, "commit">,
  caller: ConversationId,
  parentId: ConversationId,
  tangentId: ConversationId,
  revision: number,
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  if (caller !== parentId) throw new Error("Caller is not the parent");
  return driver.commit(async (tx) => {
    await hooks.assertMainReadable(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === tangentId && t.parentId === parentId);
    if (item) await hooks.assertCaller(tx, caller, parentId, tangentId, "read");
    const version = item?.versions.find((v) => v.revision === revision && v.kind === "return");
    if (!version) throw new Error("Return unavailable");
    const submission =
      version.submissionId === undefined
        ? undefined
        : await tx.submission(version.submissionId as SubmissionId);
    return {
      revision,
      admitted: version.submissionId !== undefined,
      placed: !!submission?.entry,
      submissionStatus: submission?.status ?? null,
      accepted: version.accepted,
    };
  }, context);
}

/** Lifecycle is explicit and independent of the outcome of a turn. */
export async function setTangentLifecycle(
  driver: Pick<Driver, "commit">,
  caller: ConversationId,
  parentId: ConversationId,
  tangentId: ConversationId,
  expected: "open" | "concluded" | "archived",
  next: "open" | "concluded" | "archived",
  hooks: TangentHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  return driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(TangentsDoc);
    const item = state.tangents.find((t) => t.id === tangentId && t.parentId === parentId);
    if (!item) throw new Error("Tangent not found");
    if (caller !== parentId && caller !== tangentId)
      throw new Error("Caller is not in this tangent");
    await hooks.assertCaller(tx, caller, parentId, tangentId, "lifecycle");
    if (item.lifecycle === next) return copy(item);
    if (item.lifecycle !== expected) throw new Error("Stale tangent lifecycle");
    if (next !== "open") {
      const live = await tx.doc(LiveDoc, tangentId);
      const inbox = await tx.doc(InboxDoc, tangentId);
      if (live.run || live.compactions?.length || inbox.items.length)
        throw new Error("Tangent has active work");
      await hooks.assertNoUnsettled?.(tx, tangentId);
    }
    await hooks.onLifecycle?.(tx, tangentId, next);
    item.lifecycle = next;
    return copy(item);
  }, context);
}

/** A model tool returns on admission, never waits for child completion. */
export function createTangentExtension(hooks: TangentHooks | (() => TangentHooks)) {
  return defineExtension({
    name: "cpd-tangents",
    tools: [
      defineTool({
        name: "create_tangent",
        description:
          "Create an independent interactive tangent using selected guidance; start only when requested. Do not include secrets.",
        parameters: z.toJSONSchema(CreateTangentSchema.omit({ parentId: true, sourceId: true })),
        replay: "safe",
        async execute(args, api, context) {
          const input = CreateTangentSchema.omit({ parentId: true, sourceId: true }).parse(args);
          const request = { ...input, parentId: api.conversationId, sourceId: api.conversationId };
          const result = await admitTangentStart(
            api,
            request,
            typeof hooks === "function" ? hooks() : hooks,
            context,
          );
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  id: result.id,
                  startSubmissionId: result.startSubmissionId ?? null,
                }),
              },
            ],
          };
        },
      }),
    ],
  });
}
