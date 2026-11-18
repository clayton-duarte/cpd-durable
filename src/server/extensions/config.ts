import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const MAX_CONFIG_BYTES = 65_536;
const ConfigSchema = z.strictObject({
  modules: z.array(z.string().min(1).max(1024)).max(64),
});

/** A missing config path disables loading. Relative module paths use the config directory. */
export type ConfiguredExtensions = Readonly<{
  baseDirectory: string;
  modules: readonly string[];
}>;

export class ConfiguredExtensionsError extends Error {
  constructor(message = "Configured extensions unavailable.") {
    super(message);
    this.name = "ConfiguredExtensionsError";
  }
}

/** Reads one explicit JSON file only. This is not discovery and executes no module code. */
export async function readConfiguredExtensions(
  path?: string,
): Promise<ConfiguredExtensions | null> {
  if (path === undefined) return null;
  if (!isAbsolute(path))
    throw new ConfiguredExtensionsError("Extension config path must be absolute.");
  try {
    if (!(await stat(path)).isFile()) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) throw new Error();
      const input: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
      const parsed = ConfigSchema.parse(input);
      return Object.freeze({
        baseDirectory: dirname(resolve(path)),
        modules: Object.freeze([...parsed.modules]),
      });
    } finally {
      await file.close();
    }
  } catch {
    throw new ConfiguredExtensionsError("Extension configuration is invalid or unreadable.");
  }
}
