import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRegistry, type Extension, type Registry } from "@earendil-works/pi-durable";
import { ConfiguredExtensionsError, type ConfiguredExtensions } from "./config.ts";

type Acquired = { extension: Extension; dispose?: () => void | Promise<void> };
const barePackage = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/;

function validExtension(value: unknown): value is Extension {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["name"] !== "string" || !candidate["name"].trim()) return false;
  for (const key of ["tools", "sections", "hooks", "wraps", "tasks"])
    if (candidate[key] !== undefined && !Array.isArray(candidate[key])) return false;
  if (Array.isArray(candidate["tools"]))
    for (const item of candidate["tools"] as unknown[]) {
      if (!item || typeof item !== "object") return false;
      const tool = item as Record<string, unknown>;
      if (
        typeof tool["name"] !== "string" ||
        !tool["name"] ||
        typeof tool["description"] !== "string" ||
        !tool["parameters"] ||
        typeof tool["parameters"] !== "object" ||
        typeof tool["execute"] !== "function"
      )
        return false;
    }
  if (Array.isArray(candidate["sections"]))
    for (const item of candidate["sections"] as unknown[]) {
      if (!item || typeof item !== "object") return false;
      const section = item as Record<string, unknown>;
      if (typeof section["key"] !== "string" || typeof section["render"] !== "function")
        return false;
    }
  return true;
}

async function modulePath(specifier: string, baseDirectory: string): Promise<string> {
  let path: string;
  if (isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../"))
    path = resolve(baseDirectory, specifier);
  else {
    if (!barePackage.test(specifier) || specifier.split("/").includes("..")) throw new Error();
    path = createRequire(join(baseDirectory, "__cpd_extension_config__.cjs")).resolve(specifier);
  }
  if (
    !isAbsolute(path) ||
    ![".js", ".mjs", ".cjs"].includes(extname(path)) ||
    !(await stat(path)).isFile()
  )
    throw new Error();
  return realpath(path);
}

function checkCollisions(registry: Registry, extension: Extension) {
  const snapshot = registry.snapshot();
  if (snapshot.extension(extension.name)) throw new Error();
  const names = new Set(snapshot.tools().map(({ tool }) => tool.name));
  for (const tool of extension.tools ?? []) {
    if (!tool || typeof tool.name !== "string" || !tool.name || names.has(tool.name))
      throw new Error();
    names.add(tool.name);
  }
}

// Snapshot the registration arrays and their descriptors. Task definitions
// are SDK objects and remain owned by the extension; this is not isolation.
function snapshotExtension(extension: Extension): Extension {
  return Object.freeze({
    ...extension,
    ...(extension.tools
      ? { tools: Object.freeze(extension.tools.map((tool) => Object.freeze({ ...tool }))) }
      : {}),
    ...(extension.sections
      ? {
          sections: Object.freeze(
            extension.sections.map((section) => Object.freeze({ ...section })),
          ),
        }
      : {}),
    ...(extension.hooks ? { hooks: Object.freeze([...extension.hooks]) } : {}),
    ...(extension.wraps ? { wraps: Object.freeze([...extension.wraps]) } : {}),
    ...(extension.tasks ? { tasks: Object.freeze([...extension.tasks]) } : {}),
  });
}

/**
 * Loads an explicit, immutable host snapshot before Harness.open. Module default
 * is a public SDK Extension; optional named dispose is a host lifecycle adapter.
 * Imports and module code have full host authority, including environment access.
 * The SDK validates task/section constraints, but neither SDK nor this loader
 * can prove arbitrary extension behavior safe. No cleanup reverses external effects.
 */
export async function loadConfiguredExtensions(
  registry: Registry,
  config: ConfiguredExtensions | null,
): Promise<{ close(): Promise<void> }> {
  const acquired: Acquired[] = [];
  const installed: Extension[] = [];
  let closed: Promise<void> | undefined;
  async function cleanup() {
    let failed = false;
    for (const extension of installed.reverse()) {
      try {
        if (registry.snapshot().extension(extension.name) === extension)
          registry.uninstall(extension);
      } catch {
        failed = true;
      }
    }
    for (const entry of acquired.reverse()) {
      try {
        await entry.dispose?.();
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new ConfiguredExtensionsError("Configured extensions could not close cleanly.");
  }
  const close = () => (closed ??= cleanup());
  if (!config) return { close };
  try {
    const staged = createRegistry();
    for (const existing of registry.snapshot().installed()) staged.install(existing);
    const paths = new Set<string>();
    for (const specifier of config.modules) {
      const path = await modulePath(specifier, config.baseDirectory);
      if (paths.has(path)) throw new Error();
      paths.add(path);
      const loaded: unknown = await import(pathToFileURL(path).href);
      if (!loaded || typeof loaded !== "object") throw new Error();
      const module = loaded as Record<string, unknown>;
      if (module["dispose"] !== undefined && typeof module["dispose"] !== "function")
        throw new Error();
      const dispose = module["dispose"] as (() => void | Promise<void>) | undefined;
      // Record cleanup as soon as a successful import exposes it, even if validation fails.
      const candidate = module["default"];
      if (!validExtension(candidate)) {
        if (dispose) acquired.push({ extension: { name: "" }, dispose });
        throw new Error();
      }
      const acquiredEntry: Acquired = { extension: candidate, ...(dispose ? { dispose } : {}) };
      acquired.push(acquiredEntry);
      const extension = snapshotExtension(candidate);
      acquiredEntry.extension = extension;
      checkCollisions(staged, extension);
      staged.install(extension);
    }
    for (const entry of acquired) {
      checkCollisions(registry, entry.extension);
      installed.push(entry.extension);
      registry.install(entry.extension);
    }
    return { close };
  } catch {
    await close().catch(() => {});
    throw new ConfiguredExtensionsError("Configured extensions could not be loaded.");
  }
}
