import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { loadMcpConfig, openConfiguredMcp } from "../src/server/mcp/config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cpd-mcp-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("defaults to disabled and resolves configured cwd relative to the file", async () => {
  const empty = await openConfiguredMcp();
  expect(empty.extension.tools).toEqual([]);
  await empty.close();
  const config = {
    servers: [
      {
        id: "one",
        transport: "stdio",
        command: "node",
        args: [],
        cwd: ".",
        env: { TOKEN: "synthetic-secret" },
      },
    ],
  };
  await writeFile(join(dir, "mcp.json"), JSON.stringify(config));
  expect(await loadMcpConfig("mcp.json", dir)).toEqual([{ ...config.servers[0], cwd: dir }]);
});

it("rejects invalid, unreadable, duplicate and unknown configuration without exposing contents", async () => {
  const file = join(dir, "mcp.json");
  await expect(loadMcpConfig(join(dir, "missing"))).rejects.toThrow("Unable to read");
  for (const value of [
    "synthetic-secret{",
    JSON.stringify({ servers: [], secret: "synthetic-secret" }),
    JSON.stringify({
      servers: [{ id: "bad!", transport: "stdio", command: "x", args: [], cwd: "." }],
    }),
    JSON.stringify({
      servers: Array(2).fill({ id: "same", transport: "stdio", command: "x", args: [], cwd: "." }),
    }),
    JSON.stringify({
      servers: [
        {
          id: "ok",
          transport: "stdio",
          command: "x",
          args: [],
          cwd: ".",
          env: { "BAD=KEY": "synthetic-secret" },
        },
      ],
    }),
  ]) {
    await writeFile(file, value);
    const error = await loadMcpConfig(file).catch((e: unknown) => e);
    expect(String(error)).not.toContain("synthetic-secret");
    expect(error).toBeInstanceOf(Error);
  }
});

it("cleans up an already-started server when a later server fails", async () => {
  const server = join(dir, "server.mjs");
  await writeFile(
    server,
    `import readline from "node:readline"; readline.createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s); if(m.method==="initialize") console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}})); if(m.method==="tools/list") console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[]}}));});`,
  );
  const file = join(dir, "mcp.json");
  await writeFile(
    file,
    JSON.stringify({
      servers: [
        { id: "first", transport: "stdio", command: process.execPath, args: [server], cwd: "." },
        { id: "second", transport: "stdio", command: join(dir, "missing"), args: [], cwd: "." },
      ],
    }),
  );
  await expect(openConfiguredMcp({ env: { CPD_MCP_CONFIG: file } })).rejects.toThrow(
    "MCP server startup",
  );
});
