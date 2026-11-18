import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { readConfiguredExtensions } from "../src/server/extensions/config.ts";
import { loadConfiguredExtensions } from "../src/server/extensions/loader.ts";
import { testModels } from "./models.ts";

const roots: string[] = [];
afterEach(async () => {
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
describe("configured extension foundation", () => {
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
