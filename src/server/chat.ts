import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL_ID } from "../shared/chat.ts";

export async function openChat(dataDir: string, models: Models) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: { retry: { maxRetries: 2 } },
      // Log categories only: reports can contain prompts, paths or credentials.
      onReport: (report) => console.error("pi-durable report:", report.kind),
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "openrouter", modelId: MODEL_ID }, tools: [] },
    });
    harness.resume();
    let closed = false;
    return {
      conversation,
      async close() {
        if (closed) return;
        closed = true;
        await harness.close(BACKGROUND_CONTEXT);
      },
    };
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
