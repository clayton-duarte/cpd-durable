import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { z } from "zod";
import { StdioMcpClient, type StdioServer } from "./stdio.ts";

const MAX_TOOLS = 1000;
const MAX_PAGES = 100;
const MAX_TEXT = 64 * 1024;
const Tool = z.looseObject({
  name: z.string().min(1).max(512),
  description: z.string().max(8000).optional(),
  inputSchema: z.record(z.string(), z.json()),
  outputSchema: z.unknown().optional(),
  execution: z.looseObject({ taskSupport: z.string().optional() }).optional(),
});
const Page = z.looseObject({ tools: z.array(Tool), nextCursor: z.string().min(1).optional() });
const Result = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional(),
});

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function freezeJson(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

// Deliberately accept a verifiable JSON Schema subset, not unknown constraints
// that pi-schema may ignore. Unsupported schemas fail discovery, never weaken it.
function checkSchema(value: JsonValue, root = true): void {
  if (typeof value === "boolean" && !root) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported MCP input schema.");
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "description",
    "title",
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "anyOf",
    "oneOf",
    "allOf",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || (root && value["type"] !== "object"))
    throw new Error("Unsupported MCP input schema.");
  const types = z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (
    value["type"] !== undefined &&
    !z.union([types, z.array(types).min(1)]).safeParse(value["type"]).success
  )
    throw new Error("Unsupported MCP input schema.");
  if (value["required"] !== undefined && !z.array(z.string()).safeParse(value["required"]).success)
    throw new Error("Unsupported MCP input schema.");
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (value[key] !== undefined && !z.number().finite().safeParse(value[key]).success)
      throw new Error("Unsupported MCP input schema.");
  }
  for (const key of ["pattern", "description", "title"]) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error("Unsupported MCP input schema.");
  }
  if (typeof value["pattern"] === "string") {
    try {
      new RegExp(value["pattern"]);
    } catch {
      throw new Error("Unsupported MCP input schema.");
    }
  }
  if (value["enum"] !== undefined && !Array.isArray(value["enum"]))
    throw new Error("Unsupported MCP input schema.");
  const properties = value["properties"];
  if (properties !== undefined) {
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      throw new Error("Unsupported MCP input schema.");
    for (const schema of Object.values(properties)) checkSchema(schema, false);
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = value[key];
    if (child !== undefined) checkSchema(child, false);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const children = value[key];
    if (children !== undefined) {
      if (!Array.isArray(children) || children.length === 0)
        throw new Error("Unsupported MCP input schema.");
      for (const child of children) checkSchema(child, false);
    }
  }
}

/**
 * Connect configured stdio servers once; return immutable registered tools and
 * matching namespaces. Call after explicit host configuration, before Harness
 * open. Close after Harness close, and on host startup failure.
 *
 * Only MCP 2025-03-26 initialize, tools/list and tools/call are supported.
 * No OAuth, HTTP, sampling, elicitation, prompts, resources or MCP tasks.
 * Stdio server cwd is explicitly host configured, not silently changed per chat.
 */
export async function openMcpTools(configs: readonly StdioServer[]) {
  const ids = new Set<string>();
  const clients: StdioMcpClient[] = [];
  const namespaces: { name: string; prefix: string }[] = [];
  const tools: ReturnType<typeof defineTool>[] = [];
  try {
    if (configs.some((config) => !Array.isArray(config.args)))
      throw new Error("Invalid or duplicate MCP server configuration.");
    const snapshot = configs.map((config) => ({
      ...config,
      args: [...config.args],
      ...(config.env ? { env: { ...config.env } } : {}),
    }));
    for (const config of snapshot) {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(config.id) ||
        ids.has(config.id) ||
        !config.command ||
        !config.cwd ||
        !Array.isArray(config.args)
      )
        throw new Error("Invalid or duplicate MCP server configuration.");
      if (config.transport !== "stdio") throw new Error("Unsupported MCP transport.");
      ids.add(config.id);
      const client = new StdioMcpClient(config);
      clients.push(client);
      await client.connect();
      const prefix = `mcp_${digest(config.id)}__`;
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let count = 0;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) throw new Error("MCP tool catalog exceeds page limit.");
        const result = Page.parse(await client.request("tools/list", cursor ? { cursor } : {}));
        for (const tool of result.tools) {
          if (++count > MAX_TOOLS || names.has(tool.name))
            throw new Error("Invalid MCP tool catalog.");
          if (tool.execution?.taskSupport === "required")
            throw new Error("MCP task-based tools are unsupported.");
          if (tool.outputSchema !== undefined)
            throw new Error("MCP structured output schemas are unsupported.");
          names.add(tool.name);
          checkSchema(tool.inputSchema);
          freezeJson(tool.inputSchema);
          const name = `${prefix}${digest(`${tool.name}\0${stable(tool.inputSchema)}`)}`;
          const description = tool.description ?? "MCP tool";
          tools.push(
            Object.freeze(
              defineTool({
                name,
                description: `${description}\nMCP tool name: ${tool.name}. External effects may be irreversible.`,
                parameters: tool.inputSchema,
                callers: ["tools"],
                replay: "unsafe",
                outputLimits: { maxBytes: MAX_TEXT, retain: "head" },
                async execute(args, _api, context) {
                  if (client.catalogStale)
                    throw new Error("MCP tool catalog changed; restart with a fresh snapshot.");
                  const parsed = Result.safeParse(
                    await client.request(
                      "tools/call",
                      { name: tool.name, arguments: args },
                      context.abortSignal,
                    ),
                  );
                  if (!parsed.success) throw new Error("Invalid MCP tool response.");
                  const response = parsed.data;
                  if (
                    response.content.some((item) => item.type === "text" && item.text === undefined)
                  )
                    throw new Error("Invalid MCP tool response.");
                  const text = response.content.map((item) =>
                    item.type === "text" && item.text !== undefined
                      ? item.text
                      : "[Unsupported MCP non-text content omitted.]",
                  );
                  if (response.structuredContent !== undefined)
                    text.push(`Structured content: ${JSON.stringify(response.structuredContent)}`);
                  const output = text.join("\n");
                  const bytes = Buffer.from(output, "utf8");
                  return {
                    output: [
                      {
                        type: "text",
                        text:
                          bytes.length > MAX_TEXT - 100
                            ? `${bytes.subarray(0, MAX_TEXT - 100).toString("utf8")}\n[MCP output truncated.]`
                            : output,
                      },
                    ],
                    isError: response.isError ?? false,
                  };
                },
              }),
            ),
          );
        }
        if (!result.nextCursor) break;
        if (cursors.has(result.nextCursor))
          throw new Error("MCP tool catalog pagination repeated.");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      if (client.catalogStale) throw new Error("MCP tool catalog changed during discovery.");
      if (count) namespaces.push({ name: `mcp_${digest(config.id)}`, prefix });
    }
    let closed = false;
    return {
      extension: Object.freeze(
        defineExtension({ name: "cpd-mcp-tools", tools: Object.freeze(tools) }),
      ),
      namespaces: Object.freeze(namespaces.map((namespace) => Object.freeze(namespace))),
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all(clients.map((client) => client.close()));
      },
    };
  } catch (error) {
    await Promise.all(clients.map((client) => client.close()));
    if (
      error instanceof Error &&
      [
        "Invalid or duplicate MCP server configuration.",
        "Unsupported MCP transport.",
        "Unsupported MCP input schema.",
        "MCP task-based tools are unsupported.",
        "MCP structured output schemas are unsupported.",
        "Invalid MCP tool catalog.",
        "MCP tool catalog exceeds page limit.",
        "MCP tool catalog pagination repeated.",
        "MCP tool catalog changed during discovery.",
      ].includes(error.message)
    )
      throw new Error(error.message);
    throw new Error("MCP server startup or tool discovery failed.");
  }
}
