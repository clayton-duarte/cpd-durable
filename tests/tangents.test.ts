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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";
import {
  acceptReturn,
  admitTangentStart,
  createTangentExtension,
  deliverReturn,
  inspectParentTangents,
  listTangents,
  prepareTangent,
  recordReturn,
  returnDeliveryStatus,
  type TangentHooks,
} from "../src/server/tangents/index.ts";

const context = BACKGROUND_CONTEXT;
const handoff = {
  goal: "Investigate synthetic issue",
  decisions: [],
  constraints: [],
  exclusions: [],
  references: ["synthetic reference"],
  suggestedSkills: [],
  discretion: "Use judgment",
  deliverable: "Report",
  evidence: "Tests",
  limits: "None",
};
const Catalog = defineDoc<{ items: { id: number; status: string }[] }>({
  kind: "test.tangent-catalog",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tangent-test-"));
  roots.push(root);
  const db = join(root, "session.sqlite");
  const provider = testModels();
  const hooks: TangentHooks = {
    async assertMain(tx, id) {
      const item = (await tx.doc(Catalog)).items.find((item) => item.id === id);
      if (!item || item.status !== "active") throw new Error("Main unavailable");
    },
    async register(tx, tangent) {
      (await tx.doc(Catalog)).items.push({ id: tangent.id, status: "tangent" });
    },
    model: () => ({ provider: PROVIDER_ID, modelId: MODEL_ID }),
    cwd: (source) => source ?? root,
  };
  const registry = createRegistry();
  registry.install(createTangentExtension(hooks));
  const open = async () =>
    Harness.open(await openNodeSqliteStorage(db), { models: provider.models, registry }, context);
  const harness = await open();
  const main = await harness.root(context, { agent: { model: hooks.model(), cwd: root } });
  await harness.commit(async (tx) => {
    (await tx.doc(Catalog)).items.push({ id: main.id, status: "active" });
  }, context);
  await main.submit({ type: "input", content: "private synthetic parent context" }, context);
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  provider.calls[0]!.finish("parent answer");
  await main.waitForIdle(context);
  const entries = await main.entries({ order: "ascending" }, 20, undefined, context);
  const at = entries.items.at(-1)!.id;
  const request = {
    requestId: "synthetic-create",
    parentId: main.id,
    sourceId: main.id,
    sourceEntryId: at,
    title: "Tangent",
    start: false,
    handoff,
  };
  return { root, provider, hooks, harness, main, request, open };
}

describe("interactive tangents", () => {
  it("registers and executes the public SDK model tool without waiting for the child", async () => {
    const f = await fixture();
    try {
      await f.main.submit({ type: "input", content: "Create an independent tangent" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.tools([
        { id: "create-tangent", name: "create_tangent", arguments: f.request },
      ]);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
      const list = await listTangents(f.harness, f.main.id, f.hooks);
      expect(list).toHaveLength(1);
      expect(list[0]?.activity).toBe("idle");
      expect(JSON.stringify(f.provider.calls[2]!.context.messages)).toContain("startSubmissionId");
      f.provider.calls[2]!.finish("created");
      await f.main.waitForIdle(context);
      expect(f.provider.calls).toHaveLength(3);
    } finally {
      await f.harness.close(context);
    }
  });
  it("creates ownerless fresh context once, without provider requests or hidden hierarchy", async () => {
    const f = await fixture();
    try {
      const [one, two] = await Promise.all([
        prepareTangent(f.harness, f.request, f.hooks),
        prepareTangent(f.harness, f.request, f.hooks),
      ]);
      expect(one.id).toBe(two.id);
      expect(f.provider.calls).toHaveLength(1);
      await expect(
        prepareTangent(f.harness, { ...f.request, title: "different" }, f.hooks),
      ).rejects.toThrow("conflicts");
      await expect(
        prepareTangent(f.harness, { ...f.request, requestId: "other", sourceId: one.id }, f.hooks),
      ).rejects.toThrow();
      const child = (await f.harness.conversation(one.id as ConversationId, context))!;
      expect((await child.context(context)).messages).toEqual([]);
      const agent = await child.agent(context);
      expect(agent.cwd).toBe(f.root);
      expect(agent.model).toEqual(f.hooks.model());
      const list = await listTangents(f.harness, f.main.id, f.hooks);
      expect(list[0]?.activity).toBe("idle");
      expect(list[0]?.tangent.lifecycle).toBe("open");
      expect(
        await f.harness.commit((tx) => inspectParentTangents(tx, f.main.id), context),
      ).toHaveLength(1);
    } finally {
      await f.harness.close(context);
    }
  });
  it("reattaches after prepare/reopen, admits once and Stop is conversation-scoped", async () => {
    const f = await fixture();
    let harness = f.harness;
    try {
      const request = { ...f.request, start: true };
      const prepared = await prepareTangent(harness, request, f.hooks);
      await harness.close(context);
      harness = await f.open();
      const [one, two] = await Promise.all([
        admitTangentStart(harness, request, f.hooks),
        admitTangentStart(harness, request, f.hooks),
      ]);
      expect(one.id).toBe(prepared.id);
      expect(one.startSubmissionId).toBe(two.startSubmissionId);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      const transcript = JSON.stringify(f.provider.calls[1]!.context.messages);
      expect(transcript).toContain("Investigate synthetic issue");
      expect(transcript).not.toContain("private synthetic parent context");
      const main = (await harness.conversation(f.main.id, context))!;
      const child = (await harness.conversation(one.id as ConversationId, context))!;
      await main.submit({ type: "input", content: "Main runs independently" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
      await main.abort(context);
      expect((await listTangents(harness, main.id, f.hooks))[0]?.activity).toBe("running");
      await main.submit({ type: "input", content: "Another main run" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(4));
      await child.abort(context);
      expect((await listTangents(harness, main.id, f.hooks))[0]?.tangent.lifecycle).toBe("open");
      f.provider.calls[3]!.finish("Main still running");
      await main.waitForIdle(context);
    } finally {
      await harness.close(context);
    }
  });
  it("retains return as notification until explicit admission and explicit acceptance", async () => {
    const f = await fixture();
    try {
      const child = await prepareTangent(f.harness, f.request, f.hooks);
      const draft = {
        requestId: "synthetic-return",
        tangentId: child.id,
        expectedRevision: 1,
        handoff: { ...handoff, goal: "Result" },
      };
      const result = await recordReturn(f.harness, draft, f.hooks);
      expect(result.delivery).toBe("available");
      expect((await recordReturn(f.harness, draft, f.hooks)).revision).toBe(2);
      await expect(recordReturn(f.harness, { ...draft, handoff }, f.hooks)).rejects.toThrow(
        "conflicts",
      );
      expect(f.provider.calls).toHaveLength(1);
      await expect(
        acceptReturn(f.harness, f.main.id, child.id as ConversationId, 2, f.hooks),
      ).rejects.toThrow();
      const admitted = await deliverReturn(
        f.harness,
        f.main.id,
        child.id as ConversationId,
        2,
        f.hooks,
      );
      expect(admitted.delivery).toBe("admitted");
      expect(admitted.accepted).toBe(false);
      expect(
        (await deliverReturn(f.harness, f.main.id, child.id as ConversationId, 2, f.hooks))
          .submissionId,
      ).toBe(admitted.submissionId);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      expect(
        (await returnDeliveryStatus(f.harness, f.main.id, child.id as ConversationId, 2, f.hooks))
          .placed,
      ).toBe(true);
      expect(
        (await acceptReturn(f.harness, f.main.id, child.id as ConversationId, 2, f.hooks)).accepted,
      ).toBe(true);
      f.provider.calls[1]!.finish("reviewed");
      await f.main.waitForIdle(context);
    } finally {
      await f.harness.close(context);
    }
  });
  it("rechecks parent and nested-main guards inside commits", async () => {
    const f = await fixture();
    try {
      const child = await prepareTangent(f.harness, f.request, f.hooks);
      await expect(
        prepareTangent(
          f.harness,
          { ...f.request, requestId: "nested", parentId: child.id, sourceId: child.id },
          { ...f.hooks, assertMain: async () => {} },
        ),
      ).rejects.toThrow("Nested");
      await f.harness.commit(async (tx) => {
        (await tx.doc(Catalog)).items.find((x) => x.id === f.main.id)!.status = "archived";
      }, context);
      await expect(
        prepareTangent(f.harness, { ...f.request, requestId: "new" }, f.hooks),
      ).rejects.toThrow("unavailable");
      await expect(admitTangentStart(f.harness, f.request, f.hooks)).rejects.toThrow("unavailable");
    } finally {
      await f.harness.close(context);
    }
  });
});
