import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
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
  helperHasUnsettled,
  inspectHelpers,
  launchHelper,
  stopHelper,
  stopHelpersIncludingBackground,
} from "../src/server/helpers.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const request = {
  requestId: "helper-one",
  mode: "foreground",
  delivery: "notify-only",
  assignment: "Investigate the bounded question",
  context: "Only this chosen context",
} as const;

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

  it("keeps a background anchor alive across normal Stop, then stops it explicitly", async () => {
    const id = await launchHelper(parent, { ...request, mode: "background" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const record = await harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT);
    expect(record?.background).toBe(true);
    expect(record?.owner).toBeUndefined();
    await parent.abort(BACKGROUND_CONTEXT);
    expect((await view()).helpers[0]?.status).toBe("running");
    expect((await view()).helpers[0]?.mode).toBe("background");
    expect(await stopHelper(harness, parent, "999999")).toBe("not-found");
    expect(await stopHelper(harness, parent, id)).toBe("marked");
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
  });

  it("crosses the background boundary only when explicitly requested", async () => {
    await launchHelper(parent, { ...request, mode: "background" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await stopHelpersIncludingBackground(parent);
    await vi.waitFor(async () => expect((await view()).helpers[0]?.status).toBe("cancelled"));
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

  it("reopens an in-flight helper without creating another child or submission", async () => {
    const taskId = await launchHelper(parent, request);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const id = (await helperChild()).id;
    await harness.close(BACKGROUND_CONTEXT);
    harness = await open();
    parent = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(2));
    expect(await launchHelper(parent, request)).toBe(taskId);
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
      doc.items.push({ request, taskId: 987654321, childId: null, receipt: null });
    }, BACKGROUND_CONTEXT);
    expect((await view()).helpers[0]?.status).toBe("unknown");
    expect(await parent.commit((tx) => helperHasUnsettled(tx, parent.id), BACKGROUND_CONTEXT)).toBe(
      true,
    );
  });
});
