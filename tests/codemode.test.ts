import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createCodeMode } from "../src/server/codemode.ts";
import {
  presentCodeModeReceipt,
  presentLiveNested,
} from "../src/server/nested-tool-presentation.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

describe("durable pi code mode", () => {
  let directory: string;
  let cwd: string;
  let provider: ReturnType<typeof testModels>;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let conversation: Awaited<ReturnType<typeof harness.root>>;
  let codeMode: ReturnType<typeof createCodeMode>;
  let env: NodeExecutionEnv;
  let otherEnv: NodeExecutionEnv;
  let entered: number;
  let release: boolean;

  async function open() {
    codeMode = createCodeMode();
    env = new NodeExecutionEnv({ cwd });
    otherEnv = new NodeExecutionEnv({ cwd: join(directory, "other") });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(codeMode.extension);
    registry.install(
      defineExtension({
        name: "test-tools",
        tools: [
          defineTool({
            name: "record",
            description: "Append one test marker.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            replay: "unsafe",
            async execute() {
              await appendFile(join(directory, "effects.txt"), "once\n");
              return { output: [{ type: "text", text: "recorded" }] };
            },
          }),
          defineTool({
            name: "wait_for_test",
            description: "Wait for the test to release it.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            replay: "safe",
            async execute(_args, _api, context) {
              entered++;
              if (!release) {
                await new Promise<void>((resolve) => {
                  if (context.abortSignal?.aborted) resolve();
                  else
                    context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
                });
              }
              context.abortSignal?.throwIfAborted();
              return { output: [{ type: "text", text: "released" }] };
            },
          }),
          defineTool({
            name: "unsafe_wait",
            description: "Write a marker then wait for cancellation.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            replay: "unsafe",
            async execute(_args, _api, context) {
              await appendFile(join(directory, "inflight.txt"), "once\n");
              entered++;
              await new Promise<void>((resolve) => {
                if (context.abortSignal?.aborted) resolve();
                else
                  context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
              context.abortSignal?.throwIfAborted();
              return {};
            },
          }),
        ],
      }),
    );
    const storage = await openNodeSqliteStorage(join(directory, "test.sqlite"));
    harness = await Harness.open(
      storage,
      {
        models: provider.models,
        registry,
        env: ({ cwd: selected }) => (selected === otherEnv.cwd ? otherEnv : env),
      },
      BACKGROUND_CONTEXT,
    );
    conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd },
    });
    harness.resume();
  }
  async function close() {
    await harness.close(BACKGROUND_CONTEXT);
    await codeMode.close();
    await env.cleanup(BACKGROUND_CONTEXT);
    await otherEnv.cleanup(BACKGROUND_CONTEXT);
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-codemode-"));
    cwd = join(directory, "cwd");
    await mkdir(cwd);
    await mkdir(join(directory, "other"));
    await writeFile(join(directory, "other", "sample.txt"), "other fixture");
    await writeFile(join(cwd, "sample.txt"), "fixture content");
    provider = testModels();
    entered = 0;
    release = false;
    await open();
  });
  afterEach(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  async function start(code: string) {
    await conversation.submit({ type: "input", content: "Run test script." }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(0));
    provider.calls.at(-1)!.tools([{ id: "script", name: "codemode", arguments: { code } }]);
  }
  async function result() {
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(1));
    const message = provider.calls
      .at(-1)!
      .context.messages.findLast((item) => item.role === "toolResult");
    if (!message || message.role !== "toolResult") throw new Error("Missing result");
    return message;
  }

  it("offers native tools and runs nested read/write with actual cwd and no model globals", async () => {
    const tools = (await conversation.agent(BACKGROUND_CONTEXT)).tools.map((item) => item.name);
    expect(tools).toEqual(expect.arrayContaining(["read", "write", "bash", "codemode"]));
    await start(
      `const r = await tools.read({path:"sample.txt"}); text(r); await tools.write({path:"made.txt",content:"created"}); text(typeof models);`,
    );
    const message = await result();
    expect(message.isError).toBe(false);
    expect(JSON.stringify(message.content)).toContain("fixture content");
    expect(JSON.stringify(message.content)).toContain("undefined");
    expect(await readFile(join(cwd, "made.txt"), "utf8")).toBe("created");
    const receipt = presentCodeModeReceipt(message);
    expect(receipt?.calls.map((call) => [call.name, call.state])).toEqual([
      ["read", "complete"],
      ["write", "complete"],
    ]);
    expect(receipt?.calls[0]?.callId).toBe("script/c1");
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("uses each conversation's configured directory", async () => {
    const other = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: PROVIDER_ID, modelId: MODEL_ID },
          cwd: otherEnv.cwd,
        },
      },
      BACKGROUND_CONTEXT,
    );
    await other.submit({ type: "input", content: "Read fixture." }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "other",
        name: "codemode",
        arguments: { code: `text(await tools.read({path:"sample.txt"}));` },
      },
    ]);
    const message = await result();
    expect(JSON.stringify(message.content)).toContain("other fixture");
    expect(JSON.stringify(message.content)).not.toContain("fixture content");
    provider.calls.at(-1)!.finish("Done.");
    await other.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("reports script failures and unavailable tools without inventing results", async () => {
    await start(`await tools.no_such_tool({});`);
    const message = await result();
    expect(message.isError).toBe(true);
    expect(JSON.stringify(message.content)).toContain("no_such_tool");
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(
      presentCodeModeReceipt({ role: "toolResult", toolName: "codemode", toolCallId: "x" }),
    ).toBeUndefined();
  });

  it("reports a nested schema error and continues with a later valid call", async () => {
    await start(
      `try { await tools.read({path:42}); } catch (e) { text("invalid"); } text(await tools.read({path:"sample.txt"}));`,
    );
    const message = await result();
    expect(message.isError).toBe(false);
    expect(JSON.stringify(message.content)).toContain("invalid");
    expect(JSON.stringify(message.content)).toContain("fixture content");
    expect(presentCodeModeReceipt(message)?.calls.map((call) => call.state)).toEqual([
      "error",
      "complete",
    ]);
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("advertises installed callable tools without deferred model globals", async () => {
    await start(`text(JSON.stringify(ALL_TOOLS.map(x => x.name))); text(typeof models);`);
    const message = await result();
    const text = JSON.stringify(message.content);
    expect(text).toContain("read");
    expect(text).toContain("bash");
    expect(text).toContain("undefined");
    expect(text).not.toContain("no_such_tool");
    expect(text).not.toContain("generateImages");
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("allowlists receipt fields and preserves unknown live outcomes", () => {
    const parent = { taskId: 1, callId: "p" };
    const slots = [
      {
        taskId: 2,
        parentTaskId: 1,
        parentCallId: "p",
        callId: "p/c1",
        name: "read",
        status: "done",
        arguments: { secret: "HIDDEN_ARGUMENT" },
        output: "HIDDEN_OUTPUT",
      },
      {
        taskId: 3,
        parentTaskId: 1,
        parentCallId: "p",
        callId: "p/c2",
        name: "bash",
        status: "done",
        summary: { isError: true, error: "HIDDEN_ERROR" },
      },
    ];
    const projected = presentLiveNested(slots, parent);
    expect(projected.map((slot) => slot.state)).toEqual(["unavailable", "error"]);
    expect(JSON.stringify(projected)).not.toContain("HIDDEN");
    const receipt = presentCodeModeReceipt({
      role: "toolResult",
      toolName: "codemode",
      toolCallId: "p",
      details: {
        fullOutputPath: "HIDDEN_PATH",
        calls: [{ id: 1, name: "bash", status: "cancelled", error: "HIDDEN_ERROR" }],
      },
    });
    expect(receipt?.outputSpilled).toBe(true);
    expect(receipt?.calls[0]?.state).toBe("cancelled");
    expect(JSON.stringify(receipt)).not.toContain("HIDDEN");
  });

  it("propagates Stop to nested work and presents only its real owner", async () => {
    await start(`await tools.wait_for_test({});`);
    await vi.waitFor(() => expect(entered).toBe(1));
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    await watch.stop();
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    expect(live?.run).toBeDefined();
    const parent = live?.tools?.find((item) => item.name === "codemode");
    if (!parent?.taskId) throw new Error("Missing parent");
    const calls = presentLiveNested(live?.nestedTools, {
      taskId: parent.taskId,
      callId: parent.callId,
    });
    expect(calls).toEqual([
      expect.objectContaining({ name: "wait_for_test", state: "running", callId: "script/c1" }),
    ]);
    expect(
      presentLiveNested(live?.nestedTools, { taskId: parent.taskId + 1, callId: parent.callId }),
    ).toEqual([]);
    await conversation.abort(BACKGROUND_CONTEXT);
    expect(
      (await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT))?.run,
    ).toBeUndefined();
  });

  it("reopens journaled work without rerunning the completed unsafe effect", async () => {
    await start(`await tools.record({}); await tools.wait_for_test({}); text("finished");`);
    await vi.waitFor(() => expect(entered).toBe(1));
    expect(await readFile(join(directory, "effects.txt"), "utf8")).toBe("once\n");
    await close();
    release = true;
    await open();
    const message = await result();
    expect(message.isError).toBe(false);
    expect(JSON.stringify(message.content)).toContain("finished");
    expect(await readFile(join(directory, "effects.txt"), "utf8")).toBe("once\n");
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("does not replay an interrupted unsafe nested effect on reopen", async () => {
    await start(`await tools.unsafe_wait({});`);
    await vi.waitFor(() => expect(entered).toBe(1));
    await close();
    await open();
    const message = await result();
    expect(message.isError).toBe(true);
    expect(await readFile(join(directory, "inflight.txt"), "utf8")).toBe("once\n");
    expect(entered).toBe(1);
    provider.calls.at(-1)!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
});
