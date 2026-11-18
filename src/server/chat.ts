import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, Harness, type SubmissionId, type AgentChange } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL_ID, PROVIDER_ID } from "../shared/chat.ts";
import { createExecution, workingDirectory } from "./execution.ts";
import { modelKey, openChats } from "./chats.ts";
import { selection } from "./configuration.ts";
import { createAttachmentBackend, AttachmentAccessError } from "./attachment-routes.ts";
import { createPendingImageCatalog } from "./attachment-catalog.ts";
import { openConfiguredMcp } from "./mcp/config.ts";

export async function openChat(
  dataDir: string,
  models: Models,
  cwd = workingDirectory(),
  options: { mcpConfigPath?: string } = {},
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const mcp = await openConfiguredMcp(
    options.mcpConfigPath !== undefined ? { path: options.mcpConfigPath } : {},
  );
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let execution: ReturnType<typeof createExecution> | undefined;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
    execution = createExecution(cwd, mcp);
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
    const processor = await createNodePhotonImages();
    const attachments = createAttachmentBackend({
      harness,
      root: dataDir,
      processor,
      resolve: (id) => chats.resolve(id),
      catalog: (host, scope) =>
        createPendingImageCatalog(host, scope.conversation.id, (tx) => scope.assertWritable(tx)),
      model: async (scope) => {
        const current = selection(
          await harness!.snapshot(AgentDoc, scope.conversation.id, BACKGROUND_CONTEXT),
        );
        const model = (await models.getAvailable(current.provider)).find(
          (item) => item.id === current.modelId,
        );
        return model ? { key: modelKey(current), input: model.input } : null;
      },
      admit: async (scope, draft, expectedModelKey, digest, savedDraft) => {
        const current = await chats.resolve(String(scope.conversation.id));
        if (!current) throw new AttachmentAccessError(404);
        const title = Array.isArray(draft.content)
          ? draft.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
            "Image attachment"
          : draft.content;
        const result = await current.admit(draft, {
          digest,
          expectedModelKey,
          title,
          ...(savedDraft ? { draft: savedDraft } : {}),
        });
        return {
          id: String(result.id),
          ...(result.clearedDraftRevision === undefined
            ? {}
            : { clearedDraftRevision: result.clearedDraftRevision }),
        };
      },
    });
    harness.resume();
    let closed = false;
    return {
      conversation,
      chats,
      attachments,
      withdraw: (id: SubmissionId) =>
        harness!.abortSubmission(id, BACKGROUND_CONTEXT, conversation.id),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await harness!.close(BACKGROUND_CONTEXT);
        } finally {
          try {
            await execution!.close();
          } finally {
            await mcp.close();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else if (storage) await storage.close(BACKGROUND_CONTEXT);
    } finally {
      try {
        await execution?.close();
      } finally {
        await mcp.close();
      }
    }
    throw error;
  }
}
