import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { openMcpTools } from "./index.ts";
import type { StdioServer } from "./stdio.ts";

const nonempty = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"));
const serverSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  transport: z.literal("stdio"),
  command: nonempty,
  args: z.array(z.string().refine((value) => !value.includes("\0"))),
  cwd: nonempty,
  env: z
    .record(
      z.string().regex(/^[^=\0]+$/),
      z.string().refine((value) => !value.includes("\0")),
    )
    .optional(),
});
const configSchema = z.strictObject({ servers: z.array(serverSchema) });

/** An omitted path disables MCP. Relative paths resolve against the supplied host cwd;
 * each server cwd is fixed at startup and relative to the configuration file. */
export async function loadMcpConfig(
  path?: string,
  hostCwd = process.cwd(),
): Promise<StdioServer[]> {
  if (path === undefined) return [];
  if (!path || path.includes("\0")) throw new Error("Invalid MCP configuration path.");
  const file = resolve(hostCwd, path);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw new Error("Unable to read MCP configuration.");
  }
  const parsed = configSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.servers.map((server) => server.id)).size !== parsed.data.servers.length
  )
    throw new Error("Invalid MCP configuration.");
  return parsed.data.servers.map((server) => ({
    ...server,
    cwd: resolve(dirname(file), server.cwd),
  }));
}

/** Explicit path takes precedence over the caller-provided server environment. */
export async function openConfiguredMcp(
  options: {
    path?: string;
    env?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
  } = {},
) {
  const path = options.path ?? options.env?.["CPD_MCP_CONFIG"];
  return openMcpTools(await loadMcpConfig(path, options.cwd));
}
