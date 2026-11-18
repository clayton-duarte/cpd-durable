import { homedir } from "node:os";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { createCodeMode } from "./codemode.ts";
import { createResourceExtension } from "./resources/index.ts";
import { createSearchTools } from "./tools/search.ts";
import { createQuestionExtension } from "./questions.ts";
import { HelpersExtension } from "./helpers.ts";
import type { createWorkerTools } from "./worker-tools.ts";

export function workingDirectory(path = "~"): string {
  return resolve(
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path,
  );
}

// Native host execution, deliberately not a sandbox or approval policy.
export function createExecution(
  defaultCwd = workingDirectory(),
  workerTools?: ReturnType<typeof createWorkerTools>,
) {
  const registry = createRegistry();
  const codeMode = createCodeMode();
  registry.install(CodingTools);
  registry.install(codeMode.extension);
  registry.install(createSearchTools());
  registry.install(defineExtension({ name: "powershell", tools: [createPowerShellTool()] }));
  registry.install(createResourceExtension());
  registry.install(createQuestionExtension());
  registry.install(HelpersExtension);
  if (workerTools) registry.install(workerTools);
  registry.install(
    defineExtension({
      name: "cpd-context",
      sections: [
        section(
          "preamble",
          () =>
            "You are cpd, a coding assistant. Use the available tools to carry out the user's requests. Tool execution uses the host operating system with the user's permissions.",
          { tag: false },
        ),
        section("cwd", ({ env }) => env?.cwd),
        section("model", ({ agent }) =>
          agent.model
            ? `Host-configured provider: ${agent.model.provider}\nHost-configured model: ${agent.model.modelId}\nThis is the model configuration for this request, supplied by the host. Use it when asked which model is running; it is not independent verification of the provider's underlying weights.`
            : undefined,
        ),
      ],
    }),
  );
  const environments = new Map<string, NodeExecutionEnv>();
  return {
    registry,
    env: ({ cwd }: { cwd?: string }) => {
      const directory = workingDirectory(cwd ?? defaultCwd);
      let env = environments.get(directory);
      if (!env) {
        env = new NodeExecutionEnv({ cwd: directory });
        environments.set(directory, env);
      }
      return env;
    },
    async close() {
      try {
        await codeMode.close();
      } finally {
        await Promise.all([...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
        environments.clear();
      }
    },
  };
}
