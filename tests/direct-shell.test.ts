import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  admitDirectShell,
  DirectShellEntry,
  DirectShellExtension,
} from "../src/server/direct-shell.ts";
import { openChats } from "../src/server/chats.ts";
import { parseDirectShell } from "../src/shared/direct-shell.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

let dir: string;
let env: NodeExecutionEnv;
let harness: Awaited<ReturnType<typeof Harness.open>>;
let conversation: Awaited<ReturnType<typeof harness.root>>;
let provider: ReturnType<typeof testModels>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cpd-shell-"));
  env = new NodeExecutionEnv({ cwd: dir });
  provider = testModels();
  const registry = createRegistry();
  registry.install(DirectShellExtension);
  harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "state.sqlite")),
    {
      models: provider.models,
      registry,
      env: () => env,
    },
    BACKGROUND_CONTEXT,
  );
  conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: dir },
  });
  harness.resume();
});
afterEach(async () => {
  await harness.close(BACKGROUND_CONTEXT);
  await env.cleanup(BACKGROUND_CONTEXT);
  await rm(dir, { recursive: true, force: true });
});
const allow = async () => {};
const run = (requestId: string, command: string, includeInContext = true) =>
  admitDirectShell(conversation, { requestId, command, includeInContext }, allow);

it("parses only an explicit first-character prefix and ignores empty or composing input", () => {
  expect(parseDirectShell("! echo hi\nthere")).toEqual({
    command: "echo hi\nthere",
    includeInContext: true,
  });
  expect(parseDirectShell("!! pwd")).toEqual({ command: "pwd", includeInContext: false });
  for (const text of ["!", "!! ", " !pwd", "\\!pwd", "hello"])
    expect(parseDirectShell(text)).toBeUndefined();
  expect(parseDirectShell("!pwd", true)).toBeUndefined();
});

it("runs real commands without a provider call, retains cwd, hides !! from later requests, and deduplicates", async () => {
  const id = await run("first", "printf synthetic > result; pwd");
  expect(await run("first", "printf synthetic > result; pwd")).toBe(id);
  await expect(run("first", "echo different")).rejects.toThrow("identity");
  await harness.waitForTask(id, BACKGROUND_CONTEXT);
  expect(await readFile(join(dir, "result"), "utf8")).toBe("synthetic");
  expect(provider.calls).toHaveLength(0);
  const secret = await run("second", "printf hidden-marker", false);
  await harness.waitForTask(secret, BACKGROUND_CONTEXT);
  const view = await conversation.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(view.messages)).toContain("Shell command:");
  expect(JSON.stringify(view.messages)).not.toContain("hidden-marker");
  const entries = await conversation.entries({}, 30, undefined, BACKGROUND_CONTEXT);
  expect(entries.items.filter((entry) => DirectShellEntry.is(entry))).toHaveLength(2);
  await conversation.submit({ type: "input", content: "next" }, BACKGROUND_CONTEXT);
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  expect(JSON.stringify(provider.calls[0]!.context.messages)).not.toContain("hidden-marker");
  provider.calls[0]!.finish("done");
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
});

it("records nonzero exits and Stop without running a blocked shell twice", async () => {
  const failed = await run("failure", "printf failure; exit 7");
  const failure = await harness.waitForTask(failed, BACKGROUND_CONTEXT);
  expect(failure.state.outcome).toMatchObject({ result: { status: "failed", exitCode: 7 } });
  const waiting = await run("stop", "printf once > effect; sleep 30");
  await vi.waitFor(async () => expect(await readFile(join(dir, "effect"), "utf8")).toBe("once"));
  await conversation.abort(BACKGROUND_CONTEXT);
  const stopped = await harness.waitForTask(waiting, BACKGROUND_CONTEXT);
  expect(stopped.state.outcome).toMatchObject({
    status: "aborted",
    result: { status: "cancelled" },
  });
  expect(await run("stop", "printf once > effect; sleep 30")).toBe(waiting);
});

it("serializes normal chat admission and shell admission in both directions", async () => {
  const chats = await openChats(
    harness,
    conversation,
    { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: dir },
    provider.models,
  );
  const scope = (await chats.resolve(String(conversation.id)))!;
  const waiting = await run("shell", "sleep 30");
  await expect(scope.admit({ type: "input", content: "no", requestId: "input" })).rejects.toThrow(
    "direct shell",
  );
  await conversation.abort(BACKGROUND_CONTEXT);
  await harness.waitForTask(waiting, BACKGROUND_CONTEXT);
  await scope.admit({ type: "input", content: "hello", requestId: "input" });
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  await expect(run("other", "echo no")).rejects.toThrow("busy");
  provider.calls[0]!.finish("done");
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
});

it("keeps excluded entries out of forked and reopened model context", async () => {
  const first = await run("visible", "printf visible-marker");
  await harness.waitForTask(first, BACKGROUND_CONTEXT);
  const second = await run("hidden", "printf hidden-marker", false);
  await harness.waitForTask(second, BACKGROUND_CONTEXT);
  const entries = await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  const latest = entries.items.find((entry) => DirectShellEntry.is(entry))!;
  const fork = await conversation.fork(
    latest.id,
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  expect(JSON.stringify((await fork.context(BACKGROUND_CONTEXT)).messages)).toContain(
    "visible-marker",
  );
  expect(JSON.stringify((await fork.context(BACKGROUND_CONTEXT)).messages)).not.toContain(
    "hidden-marker",
  );
  await harness.close(BACKGROUND_CONTEXT);
  const registry = createRegistry();
  registry.install(DirectShellExtension);
  harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "state.sqlite")),
    {
      models: provider.models,
      registry,
      env: () => env,
    },
    BACKGROUND_CONTEXT,
  );
  conversation = await harness.root(BACKGROUND_CONTEXT);
  const reopened = JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages);
  expect(reopened).toContain("visible-marker");
  expect(reopened).not.toContain("hidden-marker");
});

it("retains bounded output and reports truncation", async () => {
  const id = await run("large", "yes x | head -c 100000");
  const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
  expect(settled.state.outcome).toMatchObject({ result: { status: "complete", truncated: true } });
  expect(JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages)).toContain(
    "[Earlier output truncated]",
  );
});

it("atomically admits only one of concurrent model input and shell", async () => {
  const chats = await openChats(
    harness,
    conversation,
    { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: dir },
    provider.models,
  );
  const scope = (await chats.resolve(String(conversation.id)))!;
  const outcomes = await Promise.allSettled([
    run("race-shell", "sleep 30"),
    scope.admit({ type: "input", content: "race", requestId: "race-input" }),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  if (outcomes[1]?.status === "fulfilled") {
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("done");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  } else await conversation.abort(BACKGROUND_CONTEXT);
});

it("never reruns an interrupted side effect after reopening", async () => {
  const id = await run("restart", "printf x >> effect; sleep 30");
  await vi.waitFor(async () => expect(await readFile(join(dir, "effect"), "utf8")).toBe("x"));
  await harness.close(BACKGROUND_CONTEXT);
  const registry = createRegistry();
  registry.install(DirectShellExtension);
  harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "state.sqlite")),
    {
      models: provider.models,
      registry,
      env: () => env,
    },
    BACKGROUND_CONTEXT,
  );
  conversation = await harness.root(BACKGROUND_CONTEXT);
  harness.resume();
  const settled = await harness.waitForTask(id, BACKGROUND_CONTEXT);
  expect(settled.state.outcome).toMatchObject({
    status: "aborted",
    result: { status: "interrupted" },
  });
  expect(await readFile(join(dir, "effect"), "utf8")).toBe("x");
});
