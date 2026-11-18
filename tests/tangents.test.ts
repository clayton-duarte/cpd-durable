import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  Harness,
  InboxDoc,
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
    async assertMainReadable(tx, id) {
      const item = (await tx.doc(Catalog)).items.find((item) => item.id === id);
      if (!item || item.status === "deleted") throw new Error("Main unavailable");
    },
    async isMainReadOnly(tx, id) {
      return (await tx.doc(Catalog)).items.find((item) => item.id === id)?.status === "archived";
    },
    async register(tx, tangent) {
      (await tx.doc(Catalog)).items.push({ id: tangent.id, status: "tangent" });
    },
    resolveModel: async () => ({
      selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
      revision: 1,
      assignment: "tangent",
    }),
    assertResolvedModel: async () => {},
    assertCaller: async () => {},
    cwd: (source) => source ?? root,
  };
  const registry = createRegistry();
  registry.install(createTangentExtension(hooks));
  const open = async () =>
    Harness.open(await openNodeSqliteStorage(db), { models: provider.models, registry }, context);
  const harness = await open();
  const main = await harness.root(context, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: root },
  });
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
  it("pins policy selection and rejects a stale policy without re-resolving retries", async () => {
    const f = await fixture();
    try {
      const stale: TangentHooks = {
        ...f.hooks,
        assertResolvedModel: async () => {
          throw new Error("policy changed");
        },
      };
      await expect(prepareTangent(f.harness, f.request, stale)).rejects.toThrow("policy changed");
      const high: TangentHooks = {
        ...f.hooks,
        resolveModel: async () => ({
          selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "high" },
          revision: 2,
          assignment: "tangent",
        }),
      };
      const created = await prepareTangent(f.harness, f.request, high);
      const retry = await prepareTangent(f.harness, f.request, {
        ...f.hooks,
        resolveModel: async () => {
          throw new Error("must not resolve");
        },
      });
      expect(retry.model).toEqual(created.model);
      expect(
        (
          await (await f.harness.conversation(created.id as ConversationId, context))!.agent(
            context,
          )
        ).thinkingLevel,
      ).toBe("high");
    } finally {
      await f.harness.close(context);
    }
  });
  it("rejects changed prepared conversations before the first handoff admission", async () => {
    const f = await fixture();
    try {
      const request = { ...f.request, start: true };
      const prepared = await prepareTangent(f.harness, request, f.hooks);
      const child = (await f.harness.conversation(prepared.id as ConversationId, context))!;
      await child.configure({ thinkingLevel: "high" }, context);
      await expect(admitTangentStart(f.harness, request, f.hooks)).rejects.toThrow("changed");
      expect(f.provider.calls).toHaveLength(1);
      const secondRequest = { ...request, requestId: "changed-context" };
      const second = await prepareTangent(f.harness, secondRequest, f.hooks);
      const secondChild = (await f.harness.conversation(second.id as ConversationId, context))!;
      await secondChild.submit({ type: "write", entry: { kind: "test.changed" } }, context);
      await expect(admitTangentStart(f.harness, secondRequest, f.hooks)).rejects.toThrow("changed");
    } finally {
      await f.harness.close(context);
    }
  });
  it("handles explicit empty and inherited fork source boundaries", async () => {
    const f = await fixture();
    try {
      const empty = await f.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      await f.harness.commit(async (tx) => {
        (await tx.doc(Catalog)).items.push({ id: empty.id, status: "active" });
      }, context);
      const created = await prepareTangent(
        f.harness,
        {
          ...f.request,
          requestId: "empty",
          parentId: empty.id,
          sourceId: empty.id,
          sourceEntryId: null,
        },
        f.hooks,
      );
      expect(created.sourceEntryId).toBeNull();
      await expect(
        prepareTangent(
          f.harness,
          { ...f.request, requestId: "not-empty", sourceEntryId: null },
          f.hooks,
        ),
      ).rejects.toThrow("no longer empty");
      const fork = await f.main.fork(
        f.request.sourceEntryId,
        { ownership: { kind: "ownerless" } },
        context,
      );
      await f.harness.commit(async (tx) => {
        (await tx.doc(Catalog)).items.push({ id: fork.id, status: "active" });
      }, context);
      const inherited = await prepareTangent(
        f.harness,
        { ...f.request, requestId: "inherited", parentId: fork.id, sourceId: fork.id },
        f.hooks,
      );
      expect(inherited.sourceEntryId).toBe(f.request.sourceEntryId);
    } finally {
      await f.harness.close(context);
    }
  });
  it("registers and executes the public SDK model tool without waiting for the child", async () => {
    const f = await fixture();
    try {
      await f.main.submit({ type: "input", content: "Create an independent tangent" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      const { parentId: _parentId, sourceId: _sourceId, ...args } = f.request;
      f.provider.calls[1]!.tools([
        { id: "create-tangent", name: "create_tangent", arguments: args },
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
  it("binds the model's omitted boundary once across later tool calls", async () => {
    const f = await fixture();
    try {
      const { parentId: _parent, sourceId: _source, sourceEntryId: _entry, ...args } = f.request;
      await f.main.submit({ type: "input", content: "Create a tangent" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.tools([{ id: "first", name: "create_tangent", arguments: args }]);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
      const first = (await listTangents(f.harness, f.main.id, f.hooks))[0]!.tangent;
      expect(first.sourceEntryId).not.toBeNull();
      f.provider.calls[2]!.finish("created");
      await f.main.waitForIdle(context);
      await f.main.submit({ type: "input", content: "Retry the same request" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(4));
      f.provider.calls[3]!.tools([{ id: "retry", name: "create_tangent", arguments: args }]);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(5));
      const list = await listTangents(f.harness, f.main.id, f.hooks);
      expect(list).toHaveLength(1);
      expect(list[0]!.tangent.sourceEntryId).toBe(first.sourceEntryId);
      expect(JSON.stringify(f.provider.calls[4]!.context.messages)).toContain(String(first.id));
      f.provider.calls[4]!.finish("retried");
      await f.main.waitForIdle(context);
    } finally {
      await f.harness.close(context);
    }
  });
  for (const firstNull of [false, true])
    it(`preserves a failed ${firstNull ? "null" : "omitted"} model binding across reopen and rejects changed identity before concurrent retry`, async () => {
      const f = await fixture();
      let harness = f.harness;
      const resolveModel = f.hooks.resolveModel.bind(f.hooks);
      let boundary: number | undefined;
      try {
        f.hooks.resolveModel = async () => {
          boundary =
            (await harness.commit((tx) => tx.latestEntryId(f.main.id), context)) ?? undefined;
          throw new Error("synthetic policy unavailable");
        };
        const { parentId: _parent, sourceId: _source, sourceEntryId: _entry, ...args } = f.request;
        await f.main.submit({ type: "input", content: "Create a tangent" }, context);
        await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
        f.provider.calls[1]!.tools([
          {
            id: "failed",
            name: "create_tangent",
            arguments: firstNull ? { ...args, sourceEntryId: null } : args,
          },
        ]);
        await vi.waitFor(() => expect(f.provider.calls).toHaveLength(3));
        expect(boundary).toBeDefined();
        expect(await listTangents(harness, f.main.id, f.hooks)).toHaveLength(0);
        f.provider.calls[2]!.finish("not created");
        await f.main.waitForIdle(context);
        await harness.close(context);
        f.hooks.resolveModel = resolveModel;
        harness = await f.open();
        const main = (await harness.conversation(f.main.id, context))!;
        await main.submit({ type: "input", content: "Retry after reopening" }, context);
        await vi.waitFor(() => expect(f.provider.calls).toHaveLength(4));
        const latest = await harness.commit((tx) => tx.latestEntryId(main.id), context);
        expect(latest).not.toBe(boundary);
        if (latest === undefined || boundary === undefined)
          throw new Error("Missing synthetic boundary");
        await expect(
          prepareTangent(harness, { ...f.request, sourceEntryId: latest }, f.hooks),
        ).rejects.toThrow("conflicts");
        await expect(
          prepareTangent(harness, { ...f.request, sourceEntryId: null }, f.hooks),
        ).rejects.toThrow("conflicts");
        await expect(
          prepareTangent(harness, { ...f.request, sourceEntryId: boundary, start: true }, f.hooks),
        ).rejects.toThrow("conflicts");
        const other = await harness.createConversation(
          { ownership: { kind: "ownerless" } },
          context,
        );
        await harness.commit(async (tx) => {
          (await tx.doc(Catalog)).items.push({ id: other.id, status: "active" });
        }, context);
        await expect(
          prepareTangent(
            harness,
            { ...f.request, parentId: other.id, sourceId: other.id, sourceEntryId: null },
            f.hooks,
          ),
        ).rejects.toThrow("conflicts");
        f.provider.calls[3]!.tools([
          {
            id: "explicit-changed",
            name: "create_tangent",
            arguments: { ...args, sourceEntryId: latest },
          },
          {
            id: "handoff-changed",
            name: "create_tangent",
            arguments: { ...args, handoff: { ...args.handoff, goal: "Different" } },
          },
        ]);
        await vi.waitFor(() => expect(f.provider.calls).toHaveLength(5));
        expect(await listTangents(harness, main.id, f.hooks)).toHaveLength(0);
        const results = f.provider.calls[4]!.context.messages.filter(
          (m) => m.role === "toolResult",
        ).slice(-2);
        expect(results).toHaveLength(2);
        expect(results.every((result) => result.isError)).toBe(true);
        f.provider.calls[4]!.tools([
          { id: "retry-a", name: "create_tangent", arguments: args },
          { id: "retry-b", name: "create_tangent", arguments: { ...args, sourceEntryId: null } },
        ]);
        await vi.waitFor(() => expect(f.provider.calls).toHaveLength(6));
        const list = await listTangents(harness, main.id, f.hooks);
        expect(list).toHaveLength(1);
        expect(list[0]!.tangent.sourceEntryId).toBe(boundary);
        expect(
          f.provider.calls[5]!.context.messages.filter((m) => m.role === "toolResult")
            .slice(-2)
            .every((result) => !result.isError),
        ).toBe(true);
        f.provider.calls[5]!.finish("created once");
        await main.waitForIdle(context);
      } finally {
        await harness.close(context);
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
      expect(agent.model).toEqual({ provider: PROVIDER_ID, modelId: MODEL_ID });
      expect(agent.thinkingLevel).toBe("low");
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
      await expect(recordReturn(f.harness, f.main.id, f.main.id, draft, f.hooks)).rejects.toThrow(
        "Caller",
      );
      await expect(
        deliverReturn(
          f.harness,
          child.id as ConversationId,
          f.main.id,
          child.id as ConversationId,
          2,
          f.hooks,
        ),
      ).rejects.toThrow("Caller");
      await expect(
        acceptReturn(
          f.harness,
          child.id as ConversationId,
          f.main.id,
          child.id as ConversationId,
          2,
          f.hooks,
        ),
      ).rejects.toThrow("Caller");
      const result = await recordReturn(
        f.harness,
        child.id as ConversationId,
        f.main.id,
        draft,
        f.hooks,
      );
      expect(result.delivery).toBe("available");
      expect(
        (await recordReturn(f.harness, child.id as ConversationId, f.main.id, draft, f.hooks))
          .revision,
      ).toBe(2);
      await expect(
        recordReturn(
          f.harness,
          child.id as ConversationId,
          f.main.id,
          { ...draft, handoff },
          f.hooks,
        ),
      ).rejects.toThrow("conflicts");
      expect(f.provider.calls).toHaveLength(1);
      await expect(
        acceptReturn(f.harness, f.main.id, f.main.id, child.id as ConversationId, 2, f.hooks),
      ).rejects.toThrow();
      const admitted = await deliverReturn(
        f.harness,
        f.main.id,
        f.main.id,
        child.id as ConversationId,
        2,
        f.hooks,
      );
      expect(admitted.delivery).toBe("admitted");
      expect(admitted.accepted).toBe(false);
      expect(
        (
          await deliverReturn(
            f.harness,
            f.main.id,
            f.main.id,
            child.id as ConversationId,
            2,
            f.hooks,
          )
        ).submissionId,
      ).toBe(admitted.submissionId);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      expect(
        (
          await returnDeliveryStatus(
            f.harness,
            f.main.id,
            f.main.id,
            child.id as ConversationId,
            2,
            f.hooks,
          )
        ).placed,
      ).toBe(true);
      expect(
        (
          await acceptReturn(
            f.harness,
            f.main.id,
            f.main.id,
            child.id as ConversationId,
            2,
            f.hooks,
          )
        ).accepted,
      ).toBe(true);
      f.provider.calls[1]!.finish("reviewed");
      await f.main.waitForIdle(context);
    } finally {
      await f.harness.close(context);
    }
  });
  it("guards legacy return delivery against reset and requires an explicit current head", async () => {
    const f = await fixture();
    try {
      const child = await prepareTangent(f.harness, f.request, f.hooks);
      await recordReturn(
        f.harness,
        child.id as ConversationId,
        f.main.id,
        {
          requestId: "reset-return",
          tangentId: child.id,
          expectedRevision: 1,
          handoff,
        },
        f.hooks,
      );
      await f.main.reset("New context", context);
      await expect(
        deliverReturn(f.harness, f.main.id, f.main.id, child.id as ConversationId, 2, f.hooks),
      ).rejects.toThrow("Context head changed");
      const head = String((await f.main.context(context)).head!.id);
      const result = await deliverReturn(
        f.harness,
        f.main.id,
        f.main.id,
        child.id as ConversationId,
        2,
        f.hooks,
        context,
        { expectedHead: head, acknowledgeRetired: true },
      );
      expect(result.delivery).toBe("admitted");
      const status = await returnDeliveryStatus(
        f.harness,
        f.main.id,
        f.main.id,
        child.id as ConversationId,
        2,
        f.hooks,
      );
      expect(status.placed).toBe(true);
      await expect(
        deliverReturn(
          f.harness,
          f.main.id,
          f.main.id,
          child.id as ConversationId,
          2,
          f.hooks,
          context,
          { expectedHead: head, acknowledgeRetired: false },
        ),
      ).rejects.toThrow("identity conflicts");
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      f.provider.calls[1]!.finish("done");
      await f.main.waitForIdle(context);
    } finally {
      await f.harness.close(context);
    }
  });
  it("does not queue a legacy return while the parent is busy", async () => {
    const f = await fixture();
    try {
      const child = await prepareTangent(f.harness, f.request, f.hooks);
      await recordReturn(
        f.harness,
        child.id as ConversationId,
        f.main.id,
        {
          requestId: "busy-return",
          tangentId: child.id,
          expectedRevision: 1,
          handoff,
        },
        f.hooks,
      );
      await f.main.submit({ type: "input", content: "busy parent" }, context);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      await expect(
        deliverReturn(f.harness, f.main.id, f.main.id, child.id as ConversationId, 2, f.hooks),
      ).rejects.toThrow("idle destination");
      expect((await f.harness.snapshot(InboxDoc, f.main.id, context))?.items ?? []).toHaveLength(0);
      f.provider.calls[1]!.finish("done");
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
