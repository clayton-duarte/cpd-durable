import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type JsonObject,
} from "@earendil-works/pi-durable";
import {
  ExecutionError,
  err,
  type ShellExecOptions,
  type ShellExecResult,
  type Result,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createSearchTools } from "../src/server/tools/search.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

// Real platform ripgrep is a declared test-only dependency, not a runtime
// fallback or an assumption about the developer/CI machine's installed tools.
beforeAll(() => {
  vi.stubEnv("PATH", `${dirname(rgPath)}${delimiter}${process.env["PATH"] ?? ""}`);
});
afterAll(() => vi.unstubAllEnvs());

describe("optional search tools through pi-durable", () => {
  let directory: string;
  let cwd: string;
  let provider: ReturnType<typeof testModels>;
  let env: NodeExecutionEnv;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let conversation: Awaited<ReturnType<typeof harness.root>>;

  async function open(ripgrep?: string) {
    provider = testModels();
    env = new NodeExecutionEnv({ cwd });
    const registry = createRegistry();
    registry.install(createSearchTools(ripgrep ? { ripgrep } : {}));
    harness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry, env: () => env },
      BACKGROUND_CONTEXT,
    );
    conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd },
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-search-tools-"));
    cwd = join(directory, "work dir");
    await mkdir(join(cwd, "nested"), { recursive: true });
    await writeFile(join(cwd, "nested", "café notes.txt"), "Alpha one\nbeta [literal]\n");
    await writeFile(join(cwd, ".hidden.txt"), "Alpha hidden\n");
    await writeFile(join(cwd, "ignored.txt"), "Alpha ignored\n");
    await writeFile(join(cwd, ".ignore"), "ignored.txt\n");
    await writeFile(join(directory, "outside.txt"), "Alpha outside\n");
    await symlink(join(cwd, "nested"), join(cwd, "link"));
    await open();
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await env.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });

  async function call(name: string, args: JsonObject) {
    const index = provider.calls.length;
    await conversation.submit({ type: "input", content: "Run the search." }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls.length).toBe(index + 1));
    provider.calls[index]!.tools([{ id: `call-${index}`, name, arguments: args }]);
    await vi.waitFor(() => expect(provider.calls.length).toBe(index + 2));
    const messages = provider.calls[index + 1]!.context.messages;
    const result = messages.findLast((message) => message.role === "toolResult");
    if (!result || result.role !== "toolResult") throw new Error("Missing tool result");
    provider.calls[index + 1]!.finish("Done.");
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    return { text: JSON.stringify(result.content), error: result.isError };
  }

  it("searches literal and regex patterns without shell interpolation", async () => {
    const literal = await call("grep", { pattern: "[literal]", literal: true, path: "nested" });
    expect(literal.error).toBe(false);
    expect(literal.text).toContain("café notes.txt");
    expect(literal.text).toContain("beta [literal]");
    const regex = await call("grep", { pattern: "^alpha", ignoreCase: true, path: "nested" });
    expect(regex.text).toContain("Alpha one");
    const injection = await call("grep", { pattern: "$(touch injected)", literal: true });
    expect(injection.text).toContain("No results.");
    const invalid = await call("grep", { pattern: "[" });
    expect(invalid.error).toBe(true);
  });

  it("respects independent hidden and ignore options and does not traverse discovered symlinks", async () => {
    const normal = await call("grep", { pattern: "Alpha" });
    expect(normal.text).toContain("café notes.txt");
    expect(normal.text).not.toContain("hidden");
    expect(normal.text).not.toContain("ignored");
    expect(normal.text).not.toContain("/link/");
    const all = await call("grep", { pattern: "Alpha", hidden: true, ignore: false });
    expect(all.text).toContain("hidden");
    expect(all.text).toContain("ignored");
    expect(all.text).not.toContain("/link/");
    const explicit = await call("grep", { pattern: "Alpha", path: "link" });
    expect(explicit.text).toContain("café notes.txt");
  });

  it("finds file globs and lists immediate entries including symlinks and dotfiles", async () => {
    const found = await call("find", { pattern: "*.txt", path: cwd });
    expect(found.text).toContain("café notes.txt");
    // ripgrep's positive --glob overrides hidden/ignore exclusions.
    expect(found.text).toContain("ignored.txt");
    expect(found.text).toContain(".hidden.txt");
    const all = await call("find", { pattern: "*.txt", hidden: true, ignore: false });
    expect(all.text).toContain(".hidden.txt");
    expect(all.text).toContain("ignored.txt");
    const ls = await call("ls", {});
    expect(ls.text).toContain("symlink");
    expect(ls.text).toContain(".hidden.txt");
    const noHidden = await call("ls", { hidden: false });
    expect(noHidden.text).not.toContain(".hidden.txt");
  });

  it("supports absolute and parent paths and reports missing paths", async () => {
    expect((await call("grep", { pattern: "outside", path: "../outside.txt" })).text).toContain(
      "Alpha outside",
    );
    expect((await call("ls", { path: directory })).text).toContain("outside.txt");
    expect((await call("ls", { path: "missing" })).error).toBe(true);
    expect((await call("find", { pattern: "*", path: "missing" })).error).toBe(true);
  });

  it("marks bounded output and handles zero matches", async () => {
    const grep = await call("grep", { pattern: "Alpha", hidden: true, ignore: false, limit: 1 });
    expect(grep.text).toContain("truncated");
    const ls = await call("ls", { limit: 1 });
    expect(ls.text).toContain("truncated");
    const find = await call("find", { pattern: "*.txt", hidden: true, ignore: false, limit: 1 });
    expect(find.text).toContain("truncated");
    const none = await call("find", { pattern: "*.nonexistent" });
    expect(none.text).toContain("No results.");
  });

  it("marks oversized lines and rejects invalid input without executing", async () => {
    await writeFile(join(cwd, "long.txt"), `MATCH ${"a".repeat(6000)}\n`);
    const line = await call("grep", { pattern: "MATCH", path: "long.txt" });
    expect(line.text).toContain("[line truncated]");
    expect(line.text).toContain("Search output truncated");
    await writeFile(join(cwd, "huge.txt"), `MATCH ${"a".repeat(140_000)}\n`);
    const huge = await call("grep", { pattern: "MATCH", path: "huge.txt" });
    expect(huge.text).toContain("Search output truncated");
    expect(huge.text).not.toContain("No results.");
    const invalid = await call("ls", { limit: 0 });
    expect(invalid.error).toBe(true);
  });

  it("reports a missing ripgrep executable instead of claiming no matches", async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await env.cleanup(BACKGROUND_CONTEXT);
    await open(join(directory, "missing-rg"));
    const result = await call("grep", { pattern: "anything" });
    expect(result.error).toBe(true);
    expect(result.text).toContain("Install rg");
    expect(result.text).not.toContain(join(directory, "missing-rg"));
  });

  it("propagates Stop to an in-flight search without imposing a deadline", async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await env.cleanup(BACKGROUND_CONTEXT);
    let started = false;
    let cancelled = false;
    class WaitingEnvironment extends NodeExecutionEnv {
      override async exec(
        _command: string | readonly string[],
        options: ShellExecOptions | undefined,
        context: Context,
      ): Promise<Result<ShellExecResult, ExecutionError>> {
        expect(options?.timeout).toBeUndefined();
        started = true;
        await new Promise<void>((resolve) => {
          if (context.abortSignal?.aborted) resolve();
          else context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        cancelled = true;
        return err(new ExecutionError("aborted", "aborted"));
      }
    }
    provider = testModels();
    env = new WaitingEnvironment({ cwd });
    const registry = createRegistry();
    registry.install(createSearchTools());
    harness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry, env: () => env },
      BACKGROUND_CONTEXT,
    );
    conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd },
    });
    await conversation.submit({ type: "input", content: "Search." }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([{ id: "pending", name: "grep", arguments: { pattern: "x" } }]);
    await vi.waitFor(() => expect(started).toBe(true));
    await conversation.abort(BACKGROUND_CONTEXT);
    expect(cancelled).toBe(true);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
});

describe("search tools in the application registry", () => {
  it("offers and executes the tools through openChat with temporary storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cpd-search-integration-"));
    const provider = testModels();
    let chat: Awaited<ReturnType<typeof openChat>> | undefined;
    try {
      const cwd = join(directory, "work");
      await mkdir(cwd);
      await writeFile(join(cwd, "sample.txt"), "needle\n");
      chat = await openChat(join(directory, "data"), provider.models, cwd);
      const tools = (await chat.conversation.agent(BACKGROUND_CONTEXT)).tools.map(
        (tool) => tool.name,
      );
      expect(tools).toEqual(expect.arrayContaining(["read", "bash", "grep", "find", "ls"]));
      expect(provider.calls).toHaveLength(0);
      await chat.conversation.submit(
        { type: "input", content: "Search the fixture." },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "search", name: "grep", arguments: { pattern: "needle" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const result = provider.calls[1]!.context.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(result?.role).toBe("toolResult");
      expect(JSON.stringify(result)).toContain("sample.txt");
      expect(JSON.stringify(result)).toContain("needle");
      provider.calls[1]!.finish("Done.");
      await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await chat?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
