import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  Harness,
  ProviderDoc,
  type Conversation,
  type ConversationId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  HelpersDoc,
  HelpersExtension,
  collectHelperResult,
  helperHasUnsettled,
  inspectHelpers,
  launchHelper as launchHelperWithPolicy,
  requestWorkerStop,
  stopThreadIncludingBackground,
  type WorkerDependencies,
} from "../src/server/helpers.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";
import { openChat } from "../src/server/chat.ts";

const request = {
  requestId: "helper-one",
  mode: "foreground",
  delivery: "notify-only",
  modelRole: "economical",
  brief: null,
  assignment: "Investigate the bounded question",
  context: "Only this chosen context",
} as const;
const GuardDoc = defineDoc<{ revision: number; writable: boolean; interactive: boolean }>({
  kind: "test.worker-guard",
  version: 1,
  scope: "session",
  initial: () => ({ revision: 1, writable: true, interactive: true }),
  checkpointWhen: () => true,
});

function launchHelper(conversation: Conversation, raw: unknown) {
  return launchHelperWithPolicy(conversation, raw, dependencies());
}
function dependencies(
  resolve: WorkerDependencies["resolveModelForRole"] = async () => ({
    selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
    revision: 1,
    assignment: "worker",
  }),
): WorkerDependencies {
  return {
    resolveModelForRole: resolve,
    assertModelPolicy: async () => {},
    assertParentWritable: async () => {},
    assertInteractiveParent: async () => {},
  };
}

describe("foreground helpers", () => {
  let directory: string;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let parent: Conversation;
  let provider: ReturnType<typeof testModels>;
  async function open() {
    const registry = createRegistry();
    registry.install(HelpersExtension);
    return Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      { models: provider.models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT,
    );
  }
  async function view() {
    return inspectHelpers(harness, parent);
  }
  async function helperChild() {
    const id = (await view()).helpers[0]?.childId;
    expect(id).toBeTruthy();
    const child = await harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
    expect(child).toBeDefined();
    return child!;
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-helper-"));
    provider = testModels();
    harness = await open();
    parent = await harness.root(BACKGROUND_CONTEXT);
    await parent.configure(
      { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, thinkingLevel: "low", cwd: directory },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects unsupported delivery modes", async () => {
    await expect(launchHelper(parent, { ...request, delivery: "follow-up" })).rejects.toThrow();
    expect((await view()).helpers).toEqual([]);
  });

  it("requires injected model policy and persists the selected model and delegation metadata", async () => {
    const selected = provider.models.getModels(PROVIDER_ID).find((model) => model.id !== MODEL_ID);
    expect(selected).toBeDefined();
    const seen: string[] = [];
    await launchHelperWithPolicy(
      parent,
      {
        ...request,
        modelRole: "mid",
        brief: {
          version: 1,
          kind: "delegate",
          deliverable: "Return evidence",
          evidence: ["Relevant reference"],
          suggestedSkills: ["review"],
          constraints: ["Do not modify unrelated work"],
        },
      },
      dependencies(async (_role, options) => {
        seen.push(options.workerTier);
        return {
          selection: { provider: selected!.provider, modelId: selected!.id, thinkingLevel: "low" },
          revision: 1,
          assignment: "tangent",
        };
      }),
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(seen).toEqual(["mid"]);
    expect((await view()).helpers[0]?.model).toEqual({
      provider: selected!.provider,
      modelId: selected!.id,
    });
    expect(JSON.stringify(provider.calls[0]!.context)).toContain("Return evidence");
    expect(JSON.stringify(provider.calls[0]!.context)).toContain("separate branch");
    provider.calls[0]!.finish("done");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
  });

  it("does not launch if the injected model policy cannot select a model", async () => {
    await expect(
      launchHelperWithPolicy(
        parent,
        request,
        dependencies(async () => {
          throw new Error("model unavailable");
        }),
      ),
    ).rejects.toThrow("model unavailable");
    expect((await view()).helpers).toEqual([]);
  });

  it("rechecks parent and model policy on the launch line after asynchronous resolution", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deps: WorkerDependencies = {
      resolveModelForRole: async () => {
        started();
        await gate;
        return {
          selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
          revision: 1,
          assignment: "worker",
        };
      },
      assertModelPolicy: async (tx, resolved) => {
        if ((await tx.doc(GuardDoc)).revision !== resolved.revision)
          throw new Error("stale policy");
      },
      assertParentWritable: async (tx) => {
        if (!(await tx.doc(GuardDoc)).writable) throw new Error("parent unavailable");
      },
      assertInteractiveParent: async (tx) => {
        if (!(await tx.doc(GuardDoc)).interactive) throw new Error("not interactive");
      },
    };
    const pending = launchHelperWithPolicy(parent, request, deps);
    await resolving;
    await harness.commit(async (tx) => {
      (await tx.doc(GuardDoc)).revision = 2;
    }, BACKGROUND_CONTEXT);
    release();
    await expect(pending).rejects.toThrow("stale policy");
    expect((await view()).helpers).toEqual([]);
    await harness.commit(async (tx) => {
      (await tx.doc(GuardDoc)).interactive = false;
    }, BACKGROUND_CONTEXT);
    await expect(launchHelperWithPolicy(parent, request, deps)).rejects.toThrow("not interactive");
  });

  it("reuses an admitted request without resolving an unavailable model again", async () => {
    const id = await launchHelper(parent, request);
    const deps = dependencies(async () => {
      throw new Error("model unavailable");
    });
    expect(await launchHelperWithPolicy(parent, request, deps)).toBe(id);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("done");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
  });

  it("refuses creation if the parent becomes unwritable while policy resolves", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deps = dependencies(async () => {
      started();
      await gate;
      return {
        selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
        revision: 1,
        assignment: "worker",
      };
    });
    deps.assertParentWritable = async (tx) => {
      if (!(await tx.doc(GuardDoc)).writable) throw new Error("parent unavailable");
    };
    const pending = launchHelperWithPolicy(parent, request, deps);
    await resolving;
    await harness.commit(async (tx) => {
      (await tx.doc(GuardDoc)).writable = false;
    }, BACKGROUND_CONTEXT);
    release();
    await expect(pending).rejects.toThrow("parent unavailable");
    expect((await view()).helpers).toEqual([]);
  });

  it("uses the real catalog transaction guard to block archive while a worker remains live", async () => {
    const chat = await openChat(join(directory, "catalog"), provider.models, directory);
    try {
      const scope = await chat.chats.resolve(String(chat.conversation.id));
      expect(scope).toBeDefined();
      const deps = dependencies();
      deps.assertParentWritable = async (tx, id) => {
        if (id !== scope!.conversation.id) throw new Error("wrong parent");
        await scope!.assertWritable(tx);
      };
      deps.assertInteractiveParent = async (tx, id) => {
        const parent = await tx.conversation(id);
        if (!parent || parent.owner) throw new Error("not interactive");
      };
      const taskId = await launchHelperWithPolicy(
        chat.conversation,
        { ...request, mode: "background" },
        deps,
      );
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      await expect(chat.chats.change(String(chat.conversation.id), "archive")).rejects.toThrow();
      const childId = (await chat.chats.resolve(String(chat.conversation.id)))!.conversation.id;
      expect(childId).toBe(chat.conversation.id);
      await chat.conversation.abort(BACKGROUND_CONTEXT, { background: true });
      await vi.waitFor(async () =>
        expect((await chat.chats.resolve(String(chat.conversation.id)))?.archived).toBe(false),
      );
      expect(taskId).toMatch(/^\d+$/);
      await chat.chats.change(String(chat.conversation.id), "archive");
      await expect(launchHelperWithPolicy(chat.conversation, request, deps)).rejects.toThrow();
    } finally {
      await chat.close();
    }
  });

  it("defaults the model role to economical", async () => {
    const { modelRole: _role, ...withoutRole } = request;
    const seen: string[] = [];
    await launchHelperWithPolicy(
      parent,
      withoutRole,
      dependencies(async (_role, options) => {
        seen.push(options.workerTier);
        return {
          selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
          revision: 1,
          assignment: "worker",
        };
      }),
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(seen).toEqual(["economical"]);
    provider.calls[0]!.finish("done");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
  });

  it("keeps a background anchor alive across normal Stop, then stops it explicitly", async () => {
    const id = await launchHelper(parent, { ...request, mode: "background" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const record = await harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
    expect(record?.background).toBe(true);
    expect(record?.owner).toBeUndefined();
    await parent.abort(BACKGROUND_CONTEXT);
    expect((await view()).helpers[0]?.status).toBe("running");
    expect((await view()).helpers[0]?.mode).toBe("background");
    await expect(
      requestWorkerStop(harness, parent, "999999", { requestId: "missing-stop" }, dependencies()),
    ).rejects.toThrow();
    expect(
      (await requestWorkerStop(harness, parent, id, { requestId: "stop" }, dependencies())).status,
    ).toBe("admitted");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
  });

  it("crosses the background boundary only when explicitly requested", async () => {
    await launchHelper(parent, { ...request, mode: "background" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await stopThreadIncludingBackground(parent);
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
  });

  it("keeps results attached to their assignment after reset and out-of-order completion", async () => {
    await launchHelper(parent, { ...request, mode: "background", requestId: "first" });
    await launchHelper(parent, {
      ...request,
      mode: "background",
      requestId: "second",
      assignment: "A second independent assignment",
    });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    await parent.reset("New parent context", BACKGROUND_CONTEXT);
    const second = provider.calls.find((call) =>
      JSON.stringify(call.context).includes("A second independent assignment"),
    );
    const first = provider.calls.find((call) =>
      JSON.stringify(call.context).includes(request.assignment),
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    second!.finish("second result");
    await vi.waitFor(async () => {
      const items = (await view()).helpers;
      expect(items.find((item) => item.requestId === "second")?.status).toBe("success");
      expect(items.find((item) => item.requestId === "first")?.status).toBe("running");
    });
    first!.finish("first result");
    await vi.waitFor(async () =>
      expect((await view()).helpers.every((item) => item.status === "success")).toBe(true),
    );
    const parentContext = JSON.stringify((await parent.context(BACKGROUND_CONTEXT)).messages);
    expect(parentContext).toContain("New parent context");
    expect(parentContext).not.toContain("first result");
    expect(parentContext).not.toContain("second result");
    expect(provider.calls).toHaveLength(2);
    const firstId = (await view()).helpers.find((item) => item.requestId === "first")!.taskId;
    expect(await collectHelperResult(harness, parent, firstId)).toMatchObject({
      text: "first result",
      review: "unreviewed",
    });
    expect((await parent.context(BACKGROUND_CONTEXT)).messages).toHaveLength(1);
  });

  it("isolates workers under independent parent conversations", async () => {
    const other = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      },
      BACKGROUND_CONTEXT,
    );
    const first = await launchHelper(parent, { ...request, mode: "background" });
    const second = await launchHelper(other, {
      ...request,
      mode: "background",
      assignment: "Other parent assignment",
    });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    await expect(
      requestWorkerStop(harness, parent, second, { requestId: "wrong-parent" }, dependencies()),
    ).rejects.toThrow();
    await requestWorkerStop(harness, parent, first, { requestId: "stop" }, dependencies());
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
    expect((await inspectHelpers(harness, other)).helpers[0]?.status).toBe("running");
    const call = provider.calls.find((item) =>
      JSON.stringify(item.context).includes("Other parent assignment"),
    );
    expect(call).toBeDefined();
    call!.finish("independent result");
    await vi.waitFor(async () =>
      expect((await inspectHelpers(harness, other)).helpers[0]?.status).toBe("success"),
    );
  });

  it("launches one owned child, deduplicates concurrent requests, and records a separate receipt", async () => {
    await parent.submit(
      {
        type: "write",
        entry: {
          kind: "test.private",
          model: [{ role: "user", content: "PARENT_HISTORY_NOT_SHARED", timestamp: 1 }],
        },
      },
      BACKGROUND_CONTEXT,
    );
    const ids = await Promise.all(Array.from({ length: 5 }, () => launchHelper(parent, request)));
    expect(new Set(ids).size).toBe(1);
    await expect(launchHelper(parent, { ...request, assignment: "different" })).rejects.toThrow();
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const child = await helperChild();
    const parentProvider = await harness.snapshot(ProviderDoc, parent.id, BACKGROUND_CONTEXT);
    const childProvider = await harness.snapshot(ProviderDoc, child.id, BACKGROUND_CONTEXT);
    expect(parentProvider?.sessionId).toBeTruthy();
    expect(childProvider?.sessionId).toBeTruthy();
    expect(childProvider?.sessionId).not.toBe(parentProvider?.sessionId);
    const agent = await child.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toEqual({ provider: PROVIDER_ID, modelId: MODEL_ID });
    expect(agent.thinkingLevel).toBe("low");
    expect(agent.cwd).toBe(directory);
    const sent = JSON.stringify(provider.calls[0]!.context);
    expect(sent).toContain(request.assignment);
    expect(sent).toContain(request.context);
    expect(sent).not.toContain("PARENT_HISTORY_NOT_SHARED");
    expect((await view()).hasUnsettled).toBe(true);
    expect(await parent.commit((tx) => helperHasUnsettled(tx, parent.id), BACKGROUND_CONTEXT)).toBe(
      true,
    );
    provider.calls[0]!.finish("Helper result", {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
    const receipt = (await view()).helpers[0]!;
    expect(receipt.answerEntryId).not.toBeNull();
    expect(receipt.delivery).toBe("notify-only");
    expect((await view()).hasUnsettled).toBe(false);
    expect(await parent.commit((tx) => helperHasUnsettled(tx, parent.id), BACKGROUND_CONTEXT)).toBe(
      false,
    );
    expect((await parent.context(BACKGROUND_CONTEXT)).messages).toHaveLength(1);
    expect(Object.values((await harness.usage(BACKGROUND_CONTEXT)).models)[0]?.totalTokens).toBe(
      15,
    );
    expect(await launchHelper(parent, request)).toBe(ids[0]);
    expect(provider.calls).toHaveLength(1);
  });

  it("cascades parent Stop to its helper without aborting an unrelated conversation", async () => {
    const other = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      },
      BACKGROUND_CONTEXT,
    );
    await launchHelper(parent, request);
    await other.submit({ type: "input", content: "unrelated work" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    await parent.abort(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
    const otherCall = provider.calls.find((call) =>
      JSON.stringify(call.context).includes("unrelated work"),
    );
    expect(otherCall).toBeDefined();
    otherCall!.finish("unrelated answer");
    await other.waitForIdle(BACKGROUND_CONTEXT);
    expect(
      (await other.context(BACKGROUND_CONTEXT)).messages.some((m) => m.role === "assistant"),
    ).toBe(true);
  });

  it("records failed child work separately from success", async () => {
    await launchHelper(parent, request);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.fail();
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("failure"));
    expect(JSON.stringify(await view())).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    expect((await view()).helpers[0]?.answerEntryId).toBeNull();
  });

  for (const mode of ["foreground", "background"] as const)
    it(`reopens an in-flight ${mode} helper without creating another child or submission`, async () => {
      const taskId = await launchHelper(parent, { ...request, mode });
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      const id = (await helperChild()).id;
      await harness.close(BACKGROUND_CONTEXT);
      harness = await open();
      parent = await harness.root(BACKGROUND_CONTEXT);
      harness.resume();
      await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(2));
      expect(await launchHelper(parent, { ...request, mode })).toBe(taskId);
      expect((await helperChild()).id).toBe(id);
      provider.calls.at(-1)!.finish("After reopen");
      await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
      const child = await helperChild();
      const entries = await child.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    });

  it("uses the launch-time saved model and cwd even if the parent changes before scheduling", async () => {
    await harness.close(BACKGROUND_CONTEXT);
    harness = await open();
    parent = await harness.root(BACKGROUND_CONTEXT);
    await launchHelper(parent, request);
    await parent.configure(
      {
        model: { provider: "later-provider", modelId: "later-model" },
        cwd: "/changed",
        thinkingLevel: "off",
      },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const child = await helperChild();
    const agent = await child.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toEqual({ provider: PROVIDER_ID, modelId: MODEL_ID });
    expect(agent.thinkingLevel).toBe("low");
    expect(agent.cwd).toBe(directory);
    provider.calls[0]!.finish("finished");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("success"));
  });

  it("treats a missing task record as unknown and blocks lifecycle changes", async () => {
    await parent.commit(async (tx) => {
      const doc = await tx.doc(HelpersDoc, parent.id);
      doc.items.push({ request, taskId: 987654321, childId: null, model: null, receipt: null });
    }, BACKGROUND_CONTEXT);
    expect((await view()).helpers[0]?.status).toBe("unknown");
    expect(await parent.commit((tx) => helperHasUnsettled(tx, parent.id), BACKGROUND_CONTEXT)).toBe(
      true,
    );
  });
});
