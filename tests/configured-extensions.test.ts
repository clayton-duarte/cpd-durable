import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { readConfiguredExtensions } from "../src/server/extensions/config.ts";
import { loadConfiguredExtensions } from "../src/server/extensions/loader.ts";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { testModels } from "./models.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "configured-ext-"));
  roots.push(dir);
  return dir;
}
async function config(dir: string, modules: string[]) {
  const path = join(dir, "extensions.json");
  await writeFile(path, JSON.stringify({ modules }));
  return readConfiguredExtensions(path);
}
function moduleSource(name: string, tool: string, log: string) {
  return `
import { defineExtension, defineTool } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
import { appendFile } from "node:fs/promises";
export default defineExtension({ name: ${JSON.stringify(name)}, tools: [defineTool({
 name: ${JSON.stringify(tool)}, description: "Synthetic", parameters: { type: "object", properties: {}, additionalProperties: false },
 async execute() { return { output: [{ type: "text", text: "extension-result" }] }; }
})] });
export async function dispose() { await appendFile(${JSON.stringify(log)}, ${JSON.stringify(name + "\n")}); }
`;
}
function taskSource(extensionName: string, taskName: string, version: number) {
  return `
import { defineExtension, defineTask } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
const task = defineTask({ name: ${JSON.stringify(taskName)}, version: ${version},
 initial: () => ({ phase: "run" }), phases: { run: async () => {} } });
export default defineExtension({name: ${JSON.stringify(extensionName)}, tasks: [task]});
`;
}
describe("configured extension foundation", () => {
  it("combines configured MCP and extensions, closing the extension before the MCP process", async () => {
    const dir = await fixture();
    const pidFile = join(dir, "mcp.pid");
    const log = join(dir, "cleanup.txt");
    const server = join(dir, "server.mjs");
    await writeFile(
      server,
      `
import readline from "node:readline"; import {writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
readline.createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);
if(m.method==="initialize") console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}}));
if(m.method==="tools/list") console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"example",inputSchema:{type:"object"}}]}}));});
`,
    );
    const mcpPath = join(dir, "mcp.json");
    await writeFile(
      mcpPath,
      JSON.stringify({
        servers: [
          {
            id: "fixture",
            transport: "stdio",
            command: process.execPath,
            args: [server],
            cwd: ".",
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "coexist.mjs"),
      `
import {readFile, appendFile} from "node:fs/promises";
export default {name:"coexist"};
export async function dispose(){const pid=Number(await readFile(${JSON.stringify(pidFile)},"utf8")); process.kill(pid,0); await appendFile(${JSON.stringify(log)},"extension-before-mcp\\n");}
`,
    );
    const extPath = join(dir, "extensions.json");
    await writeFile(extPath, JSON.stringify({ modules: ["./coexist.mjs"] }));
    const provider = testModels();
    const chat = await openChat(join(dir, "state"), provider.models, dir, {
      mcpConfigPath: mcpPath,
      extensionsConfigPath: extPath,
    });
    await chat.close();
    expect(await readFile(log, "utf8")).toBe("extension-before-mcp\n");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();

    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
    const name = `mcp_${hash("fixture")}__${hash('example\0{"type":"object"}')}`;
    await writeFile(join(dir, "collision.mjs"), moduleSource("external-collision", name, log));
    await writeFile(extPath, JSON.stringify({ modules: ["./collision.mjs"] }));
    await expect(
      openChat(join(dir, "collision"), provider.models, dir, {
        mcpConfigPath: mcpPath,
        extensionsConfigPath: extPath,
      }),
    ).rejects.toThrow("could not be loaded");
    const collisionPid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(collisionPid, 0)).toThrow();
  });
  it("loads a configured tool in production openChat, and closes it only after the SDK harness", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    const marker = join(dir, "harness-closed");
    const sdk = import.meta.resolve("@earendil-works/pi-durable");
    await writeFile(
      join(dir, "production.mjs"),
      `
import { defineExtension, defineTool } from ${JSON.stringify(sdk)};
import { access, appendFile } from "node:fs/promises";
export default defineExtension({name:"production", tools:[defineTool({
 name:"production_tool", description:"Synthetic", parameters:{type:"object",properties:{},additionalProperties:false},
 async execute(){ return {output:[{type:"text",text:"production-tool-result"}]}; }
})]});
export async function dispose(){ await access(${JSON.stringify(marker)}); await appendFile(${JSON.stringify(log)}, "disposed\\n"); }
`,
    );
    const path = join(dir, "extensions.json");
    await writeFile(path, JSON.stringify({ modules: ["./production.mjs"] }));
    const mcpPath = join(dir, "mcp.json");
    await writeFile(mcpPath, JSON.stringify({ servers: [] }));
    const originalOpen = Harness.open.bind(Harness);
    const spy = vi.spyOn(Harness, "open").mockImplementation(async (storage, options, context) => {
      const harness = await originalOpen(storage, options, context);
      const close = harness.close.bind(harness);
      vi.spyOn(harness, "close").mockImplementation(async (closeContext) => {
        await close(closeContext);
        await writeFile(marker, "closed");
      });
      return harness;
    });
    const provider = testModels();
    const chat = await openChat(join(dir, "data"), provider.models, dir, {
      extensionsConfigPath: path,
      mcpConfigPath: mcpPath,
    });
    try {
      const app = createApp(chat);
      const response = await app.request(
        `http://localhost:3000/api/chats/${chat.conversation.id}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Synthetic", requestId: crypto.randomUUID() }),
        },
      );
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "tool", name: "production_tool", arguments: {} }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      expect(JSON.stringify(provider.calls[1]!.context.messages)).toContain(
        "production-tool-result",
      );
      provider.calls[1]!.finish("Done");
      await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await chat.close();
      await chat.close();
      spy.mockRestore();
    }
    expect(await readFile(log, "utf8")).toBe("disposed\n");
  });
  it("cleans acquired modules on storage or Harness.open failure and does not load by default", async () => {
    const dir = await fixture();
    const provider = testModels();
    const marker = join(dir, "imported");
    const log = join(dir, "cleanup.txt");
    const source = moduleSource("failure-fixture", "failure_tool", log);
    await writeFile(
      join(dir, "failure.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)},"yes");\n${source}`,
    );
    const path = join(dir, "extensions.json");
    await writeFile(path, JSON.stringify({ modules: ["./failure.mjs"] }));
    const ordinary = await openChat(join(dir, "default"), provider.models, dir);
    await ordinary.close();
    await expect(access(marker)).rejects.toThrow();
    const blocked = join(dir, "not-a-directory");
    await writeFile(blocked, "file");
    await expect(
      openChat(blocked, provider.models, dir, { extensionsConfigPath: path }),
    ).rejects.toThrow();
    expect(await readFile(log, "utf8")).toBe("failure-fixture\n");
    await mkdir(join(dir, "fail-storage", "session.sqlite"), { recursive: true });
    await expect(
      openChat(join(dir, "fail-storage"), provider.models, dir, { extensionsConfigPath: path }),
    ).rejects.toThrow();
    expect(await readFile(log, "utf8")).toBe("failure-fixture\nfailure-fixture\n");
    vi.spyOn(Harness, "open").mockRejectedValueOnce(new Error("synthetic internal error"));
    await expect(
      openChat(join(dir, "fail-harness"), provider.models, dir, { extensionsConfigPath: path }),
    ).rejects.toThrow();
    expect(await readFile(log, "utf8")).toBe("failure-fixture\nfailure-fixture\nfailure-fixture\n");
  });
  it("rejects task namespace collisions irrespective of version against native and configured definitions", async () => {
    const dir = await fixture();
    const registry = createRegistry();
    const native = registry.snapshot().tasks()[0]!.definition;
    for (const version of [native.version, native.version + 1]) {
      await writeFile(
        join(dir, `native-${version}.mjs`),
        taskSource("native-conflict", native.name, version),
      );
      await expect(
        loadConfiguredExtensions(registry, await config(dir, [`./native-${version}.mjs`])),
      ).rejects.toThrow("could not be loaded");
    }
    await writeFile(join(dir, "first.mjs"), taskSource("first-task", "sample.task", 1));
    await writeFile(join(dir, "same.mjs"), taskSource("same-task", "sample.task", 1));
    await writeFile(join(dir, "other.mjs"), taskSource("other-task", "sample.task", 2));
    for (const conflict of ["./same.mjs", "./other.mjs"])
      await expect(
        loadConfiguredExtensions(registry, await config(dir, ["./first.mjs", conflict])),
      ).rejects.toThrow("could not be loaded");
    expect(registry.snapshot().installed()).toHaveLength(0);
  });
  it("rejects symlink aliases before a second import and disposes the first only once", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    await writeFile(join(dir, "a.mjs"), moduleSource("a", "one", log));
    await symlink(join(dir, "a.mjs"), join(dir, "alias.mjs"));
    await expect(
      loadConfiguredExtensions(createRegistry(), await config(dir, ["./a.mjs", "./alias.mjs"])),
    ).rejects.toThrow("could not be loaded");
    expect(await readFile(log, "utf8")).toBe("a\n");
  });
  it("sanitizes production startup failure and continues reverse cleanup for an invalid module", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    await writeFile(join(dir, "first.mjs"), moduleSource("first", "one", log));
    await writeFile(
      join(dir, "invalid.mjs"),
      `
import { appendFile } from "node:fs/promises";
export default { name: "invalid", tools: [{}] };
export async function dispose(){ await appendFile(${JSON.stringify(log)}, "invalid\\n"); throw new Error("sensitive synthetic"); }
`,
    );
    const path = join(dir, "extensions.json");
    await writeFile(path, JSON.stringify({ modules: ["./first.mjs", "./invalid.mjs"] }));
    const result = await openChat(join(dir, "data"), testModels().models, dir, {
      extensionsConfigPath: path,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("Configured extensions could not be loaded.");
    expect(String(result)).not.toContain("sensitive synthetic");
    expect(await readFile(log, "utf8")).toBe("invalid\nfirst\n");
  });
  it("loads exact paths and packages from the config directory and runs an SDK tool", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    await writeFile(join(dir, "first.mjs"), moduleSource("first", "custom_first", log));
    const pkg = join(dir, "node_modules", "sample-extension");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sample-extension", main: "./index.cjs" }),
    );
    await writeFile(join(pkg, "index.cjs"), `module.exports = { name: "package-extension" };`);
    const registry = createRegistry();
    const loaded = await loadConfiguredExtensions(
      registry,
      await config(dir, ["./first.mjs", "sample-extension"]),
    );
    expect(
      registry
        .snapshot()
        .installed()
        .map((item) => item.name),
    ).toEqual(["first", "package-extension"]);
    const provider = testModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const chat = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      });
      await chat.submit({ type: "input", content: "Use the test tool" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "call", name: "custom_first", arguments: {} }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      expect(JSON.stringify(provider.calls[1]!.context.messages)).toContain("extension-result");
      provider.calls[1]!.finish("Done");
      await chat.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await loaded.close();
      await loaded.close();
    }
    expect(await readFile(log, "utf8")).toBe("first\n");
    expect(registry.snapshot().installed()).toHaveLength(0);
    const reopened = await loadConfiguredExtensions(registry, await config(dir, ["./first.mjs"]));
    expect(registry.snapshot().extension("first")).toBeDefined();
    const reopenedHarness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry },
      BACKGROUND_CONTEXT,
    );
    await reopenedHarness.root(BACKGROUND_CONTEXT);
    await reopenedHarness.close(BACKGROUND_CONTEXT);
    await reopened.close();
  });
  it("is disabled by default and rejects invalid, missing, oversized and special config files", async () => {
    const dir = await fixture();
    const registry = createRegistry();
    const marker = join(dir, "imported");
    await writeFile(
      join(dir, "never.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default {name:"never"};`,
    );
    expect(await readConfiguredExtensions()).toBeNull();
    const disabled = await loadConfiguredExtensions(registry, null);
    await disabled.close();
    await expect(access(marker)).rejects.toThrow();
    expect(registry.snapshot().installed()).toHaveLength(0);
    await expect(readConfiguredExtensions(join(dir, "missing.json"))).rejects.toThrow(
      "invalid or unreadable",
    );
    const path = join(dir, "bad.json");
    await writeFile(path, '{"modules":42}');
    await expect(readConfiguredExtensions(path)).rejects.toThrow("invalid or unreadable");
    await writeFile(path, "x".repeat(65_537));
    await expect(readConfiguredExtensions(path)).rejects.toThrow("invalid or unreadable");
    const pipe = join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);
    await expect(readConfiguredExtensions(pipe)).rejects.toThrow("invalid or unreadable");
  });
  it("rejects name/tool collisions and sanitizes failures while disposing in reverse order", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    await writeFile(join(dir, "a.mjs"), moduleSource("a", "one", log));
    await writeFile(join(dir, "b.mjs"), moduleSource("b", "two", log));
    await writeFile(join(dir, "bad.mjs"), 'throw new Error("sensitive synthetic diagnostic");');
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "native",
        tools: [
          {
            name: "native_tool",
            description: "Native",
            parameters: { type: "object" },
            async execute() {
              return { output: [] };
            },
          },
        ],
      }),
    );
    await expect(
      loadConfiguredExtensions(registry, await config(dir, ["./a.mjs", "./b.mjs", "./bad.mjs"])),
    ).rejects.toThrow("Configured extensions could not be loaded.");
    expect(await readFile(log, "utf8")).toBe("b\na\n");
    expect(
      registry
        .snapshot()
        .installed()
        .map((item) => item.name),
    ).toEqual(["native"]);
    await writeFile(join(dir, "collision.mjs"), moduleSource("native", "other", log));
    await expect(
      loadConfiguredExtensions(registry, await config(dir, ["./collision.mjs"])),
    ).rejects.toThrow("could not be loaded");
    await writeFile(join(dir, "duplicate.mjs"), moduleSource("other", "one", log));
    await expect(
      loadConfiguredExtensions(registry, await config(dir, ["./a.mjs", "./duplicate.mjs"])),
    ).rejects.toThrow("could not be loaded");
    await expect(
      loadConfiguredExtensions(registry, await config(dir, ["https://invalid.example/a.js"])),
    ).rejects.toThrow("could not be loaded");
    await writeFile(join(dir, "native-tool.mjs"), moduleSource("external", "native_tool", log));
    await expect(
      loadConfiguredExtensions(registry, await config(dir, ["./native-tool.mjs"])),
    ).rejects.toThrow("could not be loaded");
    expect(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    ).toEqual(["native_tool"]);
  });
  it("continues reverse cleanup after a disposal failure without leaking exception text", async () => {
    const dir = await fixture();
    const log = join(dir, "cleanup.txt");
    await writeFile(join(dir, "a.mjs"), moduleSource("a", "one", log));
    await writeFile(
      join(dir, "bad-dispose.mjs"),
      `export default { name: "bad-dispose" }; export function dispose(){ throw new Error("secret synthetic"); }`,
    );
    const registry = createRegistry();
    const loaded = await loadConfiguredExtensions(
      registry,
      await config(dir, ["./a.mjs", "./bad-dispose.mjs"]),
    );
    await expect(loaded.close()).rejects.toThrow("Configured extensions could not close cleanly.");
    await expect(loaded.close()).rejects.not.toThrow("secret synthetic");
    expect(await readFile(log, "utf8")).toBe("a\n");
    expect(registry.snapshot().installed()).toHaveLength(0);
  });
});
