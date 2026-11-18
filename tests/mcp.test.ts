import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openMcpTools } from "../src/server/mcp/index.ts";
import { StdioMcpClient, type StdioServer } from "../src/server/mcp/stdio.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

// Synthetic process; no configured user servers, credentials or ports.
const serverSource = `
import readline from "node:readline";
import {appendFileSync} from "node:fs";
const args = process.argv.slice(2);
const reply = value => { const s=JSON.stringify(value)+"\\n"; process.stdout.write(s.slice(0,5)); process.stdout.write(s.slice(5)); };
process.stderr.write("PRIVATE_STDERR_MARKER");
readline.createInterface({input:process.stdin}).on("line", line => {
 const m=JSON.parse(line);
 if(m.method==="initialize") { reply({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}}); if(args.includes("server-request")) reply({jsonrpc:"2.0",id:"server-request",method:"sampling/createMessage",params:{}}); return; }
 if(m.id==="server-request" && m.error) { appendFileSync(args[0], String(m.error.code)); return; }
 if(m.method==="tools/list") {
  if(args.includes("cycle")) return reply({jsonrpc:"2.0",id:m.id,result:{tools:[],nextCursor:"same"}});
  if(args.includes("schema")) return reply({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"bad",inputSchema:{type:"object",properties:{},unevaluatedProperties:false}}]}});
  if(m.params.cursor) return reply({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"other",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}});
  return reply({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"echo ☃",description:"echo",inputSchema:{type:"object",properties:{text:{type:args.includes("change")?"number":"string"}},required:["text"],additionalProperties:false}}],nextCursor:"next"}});
 }
 if(m.method==="tools/call") {
  if(m.params.arguments.text==="block") { appendFileSync(args[0], "once\\n"); return; }
  if(m.params.arguments.text==="error") return reply({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"expected tool failure"}],isError:true}});
  if(m.params.arguments.text==="large") return reply({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"X".repeat(80000)}]}});
  return reply({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:JSON.stringify({cwd:process.cwd(), inherited:process.env.CPD_MCP_SYNTHETIC, hostEnv:process.env.CPD_MCP_INHERITED_TEST, text:m.params.arguments.text})}]}});
 }
 if(m.method==="notifications/cancelled") { appendFileSync(args[0]+".cancel","cancelled"); return; }
 if(m.method==="hold") return;
});
`;

describe("stdio MCP adapter", () => {
  let dir: string;
  let server: string;
  let config: StdioServer;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cpd-mcp-test-"));
    await mkdir(join(dir, "cwd space"));
    server = join(dir, "server.mjs");
    await writeFile(server, serverSource);
    config = {
      id: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [server, join(dir, "effect")],
      cwd: join(dir, "cwd space"),
      env: { CPD_MCP_SYNTHETIC: "fixture-only" },
    };
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("discovers pages with stable tools-only definitions and schema-bound identity", async () => {
    const first = await openMcpTools([config]);
    const second = await openMcpTools([{ ...config, args: [...config.args, "change"] }]);
    try {
      expect(first.extension.tools).toHaveLength(2);
      expect(first.namespaces).toHaveLength(1);
      expect(
        first.extension.tools?.every(
          (tool) => tool.callers?.join() === "tools" && tool.replay === "unsafe",
        ),
      ).toBe(true);
      expect(
        first.extension.tools?.every((tool) => tool.name.startsWith(first.namespaces[0]!.prefix)),
      ).toBe(true);
      expect(first.extension.tools?.[0]?.name).not.toBe(second.extension.tools?.[0]?.name);
      expect(first.extension.tools?.[1]?.name).toBe(second.extension.tools?.[1]?.name);
      await expect(openMcpTools([config, config])).rejects.toThrow("Invalid or duplicate");
      await expect(openMcpTools([{ ...config, id: "☃" }])).rejects.toThrow("Invalid or duplicate");
    } finally {
      await first.close();
      await first.close();
      await second.close();
    }
  });

  it("executes through a durable nested tool with validated original JSON schema", async () => {
    const previous = process.env["CPD_MCP_INHERITED_TEST"];
    process.env["CPD_MCP_INHERITED_TEST"] = "inherited-test-only";
    const mcp = await openMcpTools([config]);
    const name = mcp.extension.tools![0]!.name;
    const registry = createRegistry();
    registry.install(mcp.extension);
    registry.install(
      defineExtension({
        name: "test-parent",
        tools: [
          defineTool({
            name: "parent",
            description: "Call a nested tool.",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            async execute(args, api, context) {
              const input = args as { text: string };
              const result = await api.executeTool(
                name,
                input.text === "invalid" ? { text: input.text, extra: true } : input,
                context,
              );
              if (input.text === "large")
                return {
                  output: [
                    {
                      type: "text",
                      text: JSON.stringify(result).includes("MCP output truncated")
                        ? "MCP output truncated"
                        : "missing truncation",
                    },
                  ],
                };
              return { output: [{ type: "text", text: JSON.stringify(result) }] };
            },
          }),
        ],
      }),
    );
    const provider = testModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      });
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      expect(agent.tools.map((tool) => tool.name)).not.toContain(name);
      expect(agent.callable.map((tool) => tool.name)).toContain(name);
      await conversation.submit({ type: "input", content: "Run fixture." }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "one", name: "parent", arguments: { text: "hello" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const result = JSON.stringify(provider.calls[1]!.context.messages);
      expect(result).toContain("fixture-only");
      expect(result).toContain("inherited-test-only");
      expect(result).toContain("cwd space");
      expect(result).not.toContain("PRIVATE_STDERR_MARKER");
      provider.calls[1]!.finish("Done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      await conversation.submit({ type: "input", content: "Invalid input" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
      provider.calls[2]!.tools([{ id: "two", name: "parent", arguments: { text: "invalid" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(4));
      expect(JSON.stringify(provider.calls[3]!.context.messages)).toContain("invalid_arguments");
      provider.calls[3]!.finish("Done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      await conversation.submit({ type: "input", content: "Tool error" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(5));
      provider.calls[4]!.tools([{ id: "three", name: "parent", arguments: { text: "error" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(6));
      expect(JSON.stringify(provider.calls[5]!.context.messages)).toContain(
        "expected tool failure",
      );
      provider.calls[5]!.finish("Done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      await conversation.submit({ type: "input", content: "Large output" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(7));
      provider.calls[6]!.tools([{ id: "large", name: "parent", arguments: { text: "large" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(8));
      expect(JSON.stringify(provider.calls[7]!.context.messages)).toContain("MCP output truncated");
      provider.calls[7]!.finish("Done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const otherCwd = join(dir, "other-chat");
      await mkdir(otherCwd);
      const other = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: otherCwd },
        },
        BACKGROUND_CONTEXT,
      );
      await other.submit({ type: "input", content: "Second chat" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(9));
      provider.calls[8]!.tools([{ id: "other", name: "parent", arguments: { text: "hello" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(10));
      const otherResult = JSON.stringify(provider.calls[9]!.context.messages);
      expect(otherResult).toContain("cwd space");
      expect(otherResult).not.toContain("other-chat");
      provider.calls[9]!.finish("Done");
      await other.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await mcp.close();
      if (previous === undefined) delete process.env["CPD_MCP_INHERITED_TEST"];
      else process.env["CPD_MCP_INHERITED_TEST"] = previous;
    }
  });

  it("rejects unsupported server-initiated sampling requests", async () => {
    const mcp = await openMcpTools([{ ...config, args: [...config.args, "server-request"] }]);
    try {
      await vi.waitFor(async () =>
        expect(await readFile(join(dir, "effect"), "utf8")).toBe("-32601"),
      );
    } finally {
      await mcp.close();
    }
  });

  it("has no 60-second request timeout and cancellation settles the wait", async () => {
    const client = new StdioMcpClient(config);
    await client.connect();
    try {
      vi.useFakeTimers();
      const controller = new AbortController();
      const pending = client.request(
        "tools/call",
        { name: "echo ☃", arguments: { text: "block" } },
        controller.signal,
      );
      const assertion = expect(pending).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(61_000);
      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("correlates concurrent responses to the right request", async () => {
    const client = new StdioMcpClient(config);
    await client.connect();
    try {
      const [first, second] = await Promise.all([
        client.request("tools/list", {}),
        client.request("tools/list", { cursor: "next" }),
      ]);
      expect(JSON.stringify(first)).toContain("echo ☃");
      expect(JSON.stringify(second)).toContain("other");
    } finally {
      await client.close();
    }
  });

  it("does not replay an interrupted unsafe nested MCP call after reopening", async () => {
    const mcp = await openMcpTools([config]);
    const name = mcp.extension.tools![0]!.name;
    const registry = createRegistry();
    registry.install(mcp.extension);
    registry.install(
      defineExtension({
        name: "test-replay",
        tools: [
          defineTool({
            name: "parent",
            description: "Test durable nested MCP.",
            parameters: { type: "object", properties: {} },
            replay: "safe",
            async execute(_args, api, context) {
              const result = await api.executeTool(name, { text: "block" }, context);
              return { output: [{ type: "text", text: JSON.stringify(result) }] };
            },
          }),
        ],
      }),
    );
    const provider = testModels();
    async function open() {
      return await Harness.open(
        await openNodeSqliteStorage(join(dir, "test.sqlite")),
        { models: provider.models, registry },
        BACKGROUND_CONTEXT,
      );
    }
    let harness = await open();
    try {
      let conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      });
      await conversation.submit({ type: "input", content: "Call fixture" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "outer", name: "parent", arguments: {} }]);
      await vi.waitFor(async () =>
        expect(await readFile(join(dir, "effect"), "utf8")).toBe("once\n"),
      );
      await harness.close(BACKGROUND_CONTEXT);
      harness = await open();
      conversation = await harness.root(BACKGROUND_CONTEXT);
      harness.resume();
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      expect(await readFile(join(dir, "effect"), "utf8")).toBe("once\n");
      expect(JSON.stringify(provider.calls[1]!.context.messages)).toContain("isError");
      provider.calls[1]!.finish("Done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await mcp.close();
    }
  });

  it("propagates durable Stop to MCP cancellation without claiming the effect is undone", async () => {
    const mcp = await openMcpTools([config]);
    const name = mcp.extension.tools![0]!.name;
    const registry = createRegistry();
    registry.install(mcp.extension);
    registry.install(
      defineExtension({
        name: "test-stop",
        tools: [
          defineTool({
            name: "parent",
            description: "Wait on nested MCP.",
            parameters: { type: "object", properties: {} },
            async execute(_args, api, context) {
              await api.executeTool(name, { text: "block" }, context);
              return {};
            },
          }),
        ],
      }),
    );
    const provider = testModels();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: provider.models, registry },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      });
      await conversation.submit({ type: "input", content: "Run fixture" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "outer", name: "parent", arguments: {} }]);
      await vi.waitFor(async () =>
        expect(await readFile(join(dir, "effect"), "utf8")).toBe("once\n"),
      );
      const watch = await conversation.watch(BACKGROUND_CONTEXT);
      await watch.stop();
      await conversation.abort(BACKGROUND_CONTEXT);
      await vi.waitFor(async () =>
        expect(await readFile(join(dir, "effect.cancel"), "utf8")).toBe("cancelled"),
      );
      expect(await readFile(join(dir, "effect"), "utf8")).toBe("once\n");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await mcp.close();
    }
  });

  it("closes pending calls and rejects cyclic catalog pagination", async () => {
    const client = new StdioMcpClient(config);
    await client.connect();
    await expect(client.request("resources/list", {})).rejects.toThrow("Unsupported MCP method");
    const pending = client.request("tools/call", { name: "echo ☃", arguments: { text: "block" } });
    const assertion = expect(pending).rejects.toThrow("transport failed");
    await client.close();
    await assertion;
    await expect(openMcpTools([{ ...config, args: [...config.args, "cycle"] }])).rejects.toThrow(
      "pagination repeated",
    );
    await expect(openMcpTools([{ ...config, args: [...config.args, "schema"] }])).rejects.toThrow(
      "Unsupported MCP input schema",
    );
  });
});
