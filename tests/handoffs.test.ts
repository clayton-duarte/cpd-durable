import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  Harness,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHandoffService, type HandoffGuards } from "../src/server/handoffs.ts";
import { HelpersDoc, HelpersExtension, launchHelper } from "../src/server/helpers.ts";
import { prepareTangent, TangentsDoc, type TangentHooks } from "../src/server/tangents/index.ts";
import { normalizeLegacyTangent, normalizeLegacyWorker } from "../src/shared/handoffs.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const ctx = BACKGROUND_CONTEXT;
const Catalog = defineDoc<{ items: { id: number; state: "active" | "archived" | "deleted" }[] }>({
  kind: "test.handoff-catalog",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});
const content = {
  version: 1,
  provenance: "native",
  goal: "Bounded outcome",
  context: null,
  decisions: [],
  constraints: ["Stay in scope"],
  exclusions: [],
  references: ["existing artifact"],
  suggestedSkills: ["review"],
  discretion: "Use judgment",
  deliverable: "Report",
  evidence: "Tests",
  limits: "Known limitations",
} as const;
const tangentHandoff = {
  goal: "Tangent",
  decisions: [],
  constraints: [],
  exclusions: [],
  references: [],
  suggestedSkills: [],
  discretion: "",
  deliverable: "",
  evidence: "",
  limits: "",
};

describe("notify-only durable handoffs", () => {
  let directory: string;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let parent: Awaited<ReturnType<typeof harness.root>>;
  let child: Awaited<ReturnType<typeof harness.root>>;
  let provider: ReturnType<typeof testModels>;
  let guards: HandoffGuards;
  let registry: ReturnType<typeof createRegistry>;
  async function reopen() {
    return Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      { models: provider.models, registry },
      ctx,
    );
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "handoff-test-"));
    provider = testModels();
    registry = createRegistry();
    registry.install(HelpersExtension);
    harness = await reopen();
    parent = await harness.root(ctx, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: directory },
    });
    await harness.commit(async (tx) => {
      (await tx.doc(Catalog)).items.push({ id: parent.id, state: "active" });
    }, ctx);
    const tangentHooks: TangentHooks = {
      assertMain: async () => {},
      assertMainReadable: async () => {},
      isMainReadOnly: async () => false,
      register: async (tx, tangent) => {
        (await tx.doc(Catalog)).items.push({ id: tangent.id, state: "active" });
      },
      resolveModel: async () => ({
        selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
        revision: 1,
        assignment: "tangent",
      }),
      assertResolvedModel: async () => {},
      assertCaller: async () => {},
      cwd: (cwd) => cwd ?? directory,
    };
    const tangent = await prepareTangent(
      harness,
      {
        requestId: "create",
        parentId: parent.id,
        sourceId: parent.id,
        sourceEntryId: null,
        title: "Tangent",
        start: false,
        handoff: tangentHandoff,
      },
      tangentHooks,
    );
    child = (await harness.conversation(tangent.id as ConversationId, ctx))!;
    guards = {
      assertAccess: async (tx, actor, action) => {
        const item = (await tx.doc(Catalog)).items.find((entry) => entry.id === actor);
        if (!item || item.state === "deleted" || (item.state === "archived" && action !== "read"))
          throw new Error("access unavailable");
      },
      assertRelationship: async (tx, parentId, childId) => {
        const tangent = (await tx.doc(TangentsDoc)).tangents.find(
          (item) => item.id === childId && item.parentId === parentId,
        );
        const owned = await tx.conversation(childId);
        const workers = await tx.doc(HelpersDoc, parentId);
        const worker = workers.items.find(
          (item) => item.childId === childId && item.taskId === owned?.owner?.taskId,
        );
        if (!tangent && !(worker && owned?.owner?.conversationId === parentId))
          throw new Error("relationship unavailable");
      },
    };
    harness.resume();
  });
  afterEach(async () => {
    await harness.close(ctx);
    await rm(directory, { recursive: true, force: true });
  });
  const base = () => ({ assignmentId: "assignment", parentId: parent.id, childId: child.id });
  const record = (
    kind: "delegate" | "update" | "escalate" | "return",
    expectedRevision: number,
    operationId: string,
  ) => ({
    ...base(),
    kind,
    expectedRevision,
    operationId,
    content,
    delivery: "notify-only",
  });

  it("records, explicitly collects and reviews without submitting model input", async () => {
    const parentService = createHandoffService(harness, parent, guards);
    const childService = createHandoffService(harness, child, guards);
    const initial = await parentService.record(record("delegate", 0, "one"));
    expect(initial).toMatchObject({ revision: 1, visibility: "available", review: "unreviewed" });
    expect(
      await Promise.all([
        parentService.record(record("delegate", 0, "one")),
        parentService.record(record("delegate", 0, "one")),
      ]),
    ).toEqual([initial, initial]);
    await expect(
      parentService.record({
        ...record("delegate", 0, "one"),
        content: { ...content, goal: "different" },
      }),
    ).rejects.toThrow("identity conflict");
    await expect(childService.record(record("update", 1, "spoof"))).rejects.toThrow("sender");
    await childService.record(record("escalate", 1, "two"));
    await expect(parentService.record(record("update", 1, "stale"))).rejects.toThrow("revision");
    await childService.record(record("return", 2, "three"));
    const action = { ...base(), revision: 3 };
    await expect(
      parentService.review({
        ...action,
        operationId: "review",
        decision: "accepted",
        confirmedVisible: true,
      }),
    ).rejects.toThrow("Collect");
    await expect(
      childService.review({
        ...action,
        operationId: "spoof-review",
        decision: "accepted",
        confirmedVisible: true,
      }),
    ).rejects.toThrow("Only the parent");
    expect((await parentService.list(parent.id, child.id, "assignment"))[2]?.visibility).toBe(
      "available",
    );
    await parentService.collect({ ...action, operationId: "collect" });
    expect(
      (
        await parentService.review({
          ...action,
          operationId: "review",
          decision: "accepted",
          confirmedVisible: true,
        })
      ).review,
    ).toBe("accepted");
    expect(await parentService.record(record("delegate", 0, "one"))).toEqual(initial);
    await expect(
      parentService.review({
        ...action,
        operationId: "second-review",
        decision: "rejected",
        confirmedVisible: true,
      }),
    ).rejects.toThrow("unreviewed");
    expect(provider.calls).toHaveLength(0);
    expect((await parent.context(ctx)).messages).toHaveLength(0);
  });

  it("persists records across reopen and enforces read-only lifecycle", async () => {
    await createHandoffService(harness, parent, guards).record(record("delegate", 0, "one"));
    const parentId = parent.id;
    const childId = child.id;
    await harness.close(ctx);
    harness = await reopen();
    parent = (await harness.conversation(parentId, ctx))!;
    child = (await harness.conversation(childId, ctx))!;
    await harness.commit(async (tx) => {
      (await tx.doc(Catalog)).items.find((item) => item.id === parentId)!.state = "archived";
    }, ctx);
    const service = createHandoffService(harness, parent, guards);
    expect(await service.list(parentId, childId, "assignment")).toHaveLength(1);
    await expect(service.record(record("update", 1, "two"))).rejects.toThrow("access unavailable");
    expect(provider.calls).toHaveLength(0);
  });

  it("serializes competing updates and isolates assignment identities", async () => {
    const service = createHandoffService(harness, parent, guards);
    await service.record(record("delegate", 0, "initial"));
    const outcomes = await Promise.allSettled([
      service.record(record("update", 1, "tab-one")),
      service.record(record("update", 1, "tab-two")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await service.record({ ...record("delegate", 0, "other"), assignmentId: "other-assignment" });
    expect(await service.list(parent.id, child.id, "assignment")).toHaveLength(2);
    expect(await service.list(parent.id, child.id, "other-assignment")).toHaveLength(1);
    await expect(
      service.record({ ...record("update", 2, "delivery"), delivery: "followUp" }),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });

  it("checks real task-owned worker relation and refuses unrelated peers", async () => {
    await launchHelper(
      parent,
      {
        requestId: "worker",
        mode: "background",
        delivery: "notify-only",
        assignment: "worker task",
        context: "",
      },
      {
        resolveModelForRole: async () => ({
          selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
          revision: 1,
          assignment: "worker",
        }),
        assertModelPolicy: async () => {},
        assertParentWritable: async () => {},
        assertInteractiveParent: async () => {},
      },
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const workerId = (await harness.snapshot(HelpersDoc, parent.id, ctx))!.items[0]!
      .childId! as ConversationId;
    await harness.commit(async (tx) => {
      (await tx.doc(Catalog)).items.push({ id: workerId, state: "active" });
    }, ctx);
    const worker = (await harness.conversation(workerId, ctx))!;
    const parentService = createHandoffService(harness, parent, guards);
    await parentService.record({
      ...record("delegate", 0, "worker-delegate"),
      childId: workerId,
      assignmentId: "worker-assignment",
    });
    await createHandoffService(harness, worker, guards).record({
      ...record("return", 1, "worker-return"),
      childId: workerId,
      assignmentId: "worker-assignment",
    });
    await expect(
      createHandoffService(harness, child, guards).list(parent.id, workerId, "worker-assignment"),
    ).rejects.toThrow("relationship unavailable");
    provider.calls[0]!.finish("done");
  });
});

it("normalizes legacy values without inventing omitted fields", () => {
  expect(normalizeLegacyTangent(tangentHandoff)).toMatchObject({
    provenance: "legacy-tangent",
    context: null,
    evidence: "",
  });
  expect(
    normalizeLegacyWorker({
      requestId: "old",
      mode: "foreground",
      delivery: "notify-only",
      assignment: "old assignment",
      context: "",
    }),
  ).toMatchObject({
    provenance: "legacy-worker",
    goal: "old assignment",
    context: "",
    constraints: null,
    references: null,
    evidence: null,
  });
});
