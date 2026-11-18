import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { Harness, type SubmissionId, type AgentChange } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL_ID, PROVIDER_ID } from "../shared/chat.ts";
import { createExecution, workingDirectory } from "./execution.ts";
import { openChats } from "./chats.ts";

export async function openChat(dataDir: string, models: Models, cwd = workingDirectory()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
  const execution = createExecution(cwd);
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry: execution.registry,
        env: execution.env,
        settings: { retry: { maxRetries: 2 } },
        identity: {
          userAgent: { custom: "cpd-durable/0.1.0" },
          attribution: {
            name: "CPD Durable",
            url: "https://github.com/clayton-duarte/cpd-durable",
          },
        },
        // Log categories only: reports can contain prompts, paths or credentials.
        onReport: (report) => console.error("pi-durable report:", report.kind),
      },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    // Initialize new chats; retain each reopened conversation's saved model/thinking.
    const defaults: AgentChange = {
      model: { provider: PROVIDER_ID, modelId: MODEL_ID },
      cwd: workingDirectory(cwd),
      extensions: null,
      tools: null,
      modelTools: null,
      maxTurns: null,
    };
    const chats = await openChats(harness, conversation, defaults, models);
    harness.resume();
    let closed = false;
    return {
      conversation,
      chats,
      withdraw: (id: SubmissionId) =>
        harness!.abortSubmission(id, BACKGROUND_CONTEXT, conversation.id),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await harness!.close(BACKGROUND_CONTEXT);
        } finally {
          await execution.close();
        }
      },
    };
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else await storage.close(BACKGROUND_CONTEXT);
    } finally {
      await execution.close();
    }
    throw error;
  }
}
