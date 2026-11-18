import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, Harness, type SubmissionId, type AgentChange } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MODEL_ID, PROVIDER_ID } from "../shared/chat.ts";
import { createExecution, workingDirectory } from "./execution.ts";
import { assertInteractiveChat, createTangentCatalogHooks, modelKey, openChats } from "./chats.ts";
import { createTangentRoutes } from "./tangent-routes.ts";
import type { TangentHooks } from "./tangents/index.ts";
import type { ResolvedTangentModel } from "../shared/tangents.ts";
import type { Tx } from "@earendil-works/pi-durable";
import { selection } from "./configuration.ts";
import { createAttachmentBackend, AttachmentAccessError } from "./attachment-routes.ts";
import { createPendingImageCatalog } from "./attachment-catalog.ts";
import { assertModelPolicyTx, createModelPolicy } from "./model-policy.ts";
import { createWorkerTools, type WorkerToolDependencies } from "./worker-tools.ts";
import { createWorkerRoutes } from "./worker-routes.ts";
import { helperHasUnsettled } from "./helpers.ts";
import { createHandoffRoutes } from "./handoff-routes.ts";
import { createHandoffGuards } from "./handoffs.ts";

export type TangentPolicy = {
  resolveModel(): Promise<ResolvedTangentModel>;
  assertResolvedModel(tx: Tx, resolved: ResolvedTangentModel): Promise<void>;
};
export type WorkerHostFactory = (harness: () => Harness) => Omit<WorkerToolDependencies, "harness">;
export async function openChat(
  dataDir: string,
  models: Models,
  cwd = workingDirectory(),
  options: {
    tangentPolicy?: (harness: Harness, models: Models) => TangentPolicy;
    assertNoUnsettledTangent?: (
      tx: Tx,
      tangent: import("@earendil-works/pi-durable").ConversationId,
    ) => Promise<void>;
    workers?: WorkerHostFactory;
  } = {},
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
  let boundTangentHooks: TangentHooks | undefined;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  const getHarness = () => {
    if (!harness) throw new Error("Worker host is not ready.");
    return harness;
  };
  let workerOptions: WorkerToolDependencies | undefined;
  const getWorkers = () => {
    if (!workerOptions) throw new Error("Worker service unavailable.");
    return workerOptions;
  };
  const execution = createExecution(
    cwd,
    () => {
      if (!boundTangentHooks) throw new Error("Tangent service unavailable.");
      return boundTangentHooks;
    },
    createWorkerTools({
      harness: getHarness,
      policy: {
        resolveModelForRole: (role, options) =>
          getWorkers().policy.resolveModelForRole(role, options),
        assertModelPolicy: (tx, resolved) => getWorkers().policy.assertModelPolicy(tx, resolved),
        assertParentWritable: (tx, id) => getWorkers().policy.assertParentWritable(tx, id),
        assertInteractiveParent: (tx, id) => getWorkers().policy.assertInteractiveParent(tx, id),
      },
      assertReadable: (tx, id) => getWorkers().assertReadable(tx, id),
    }),
  );
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
    const modelPolicy = createModelPolicy(harness, models);
    const chats = await openChats(harness, conversation, defaults, models, modelPolicy);
    const handoffs = createHandoffRoutes({
      harness,
      guards: createHandoffGuards(),
      resolve: async (id) => (await chats.resolve(id))?.conversation,
    });
    const custom = options.workers?.(getHarness);
    workerOptions = {
      harness: getHarness,
      policy: {
        resolveModelForRole: (role, opts) =>
          custom
            ? custom.policy.resolveModelForRole(role, opts)
            : modelPolicy.resolveModelForRole(role, opts),
        assertModelPolicy: (tx, resolved) =>
          custom
            ? custom.policy.assertModelPolicy(tx, resolved)
            : assertModelPolicyTx(tx, resolved),
        async assertParentWritable(tx, id) {
          await assertInteractiveChat(tx, id, true);
          await custom?.policy.assertParentWritable(tx, id);
        },
        async assertInteractiveParent(tx, id) {
          await assertInteractiveChat(tx, id, false);
          await custom?.policy.assertInteractiveParent(tx, id);
        },
      },
      async assertReadable(tx, id) {
        await assertInteractiveChat(tx, id, false);
        await custom?.assertReadable(tx, id);
      },
    };
    const policy = options.tangentPolicy?.(harness, models) ?? {
      resolveModel: () => modelPolicy.resolveModelForRole("tangent"),
      assertResolvedModel: assertModelPolicyTx,
    };
    const tangentHooks = createTangentCatalogHooks({
      resolveModel: async () => {
        return policy.resolveModel();
      },
      assertResolvedModel: async (tx, resolved) => {
        await policy.assertResolvedModel(tx, resolved);
      },
      cwd: (source) => workingDirectory(source ?? cwd),
      async assertNoUnsettled(tx, tangent) {
        if (await helperHasUnsettled(tx, tangent))
          throw new Error("Tangent has unsettled workers.");
        await options.assertNoUnsettledTangent?.(tx, tangent);
      },
    });
    boundTangentHooks = tangentHooks;
    const tangents = { routes: createTangentRoutes(harness, tangentHooks, models) };
    const workers = createWorkerRoutes({
      harness,
      resolve: async (id) => {
        const scope = await chats.resolve(id);
        return scope
          ? { conversation: scope.conversation, policy: getWorkers().policy }
          : undefined;
      },
      assertReadable: (tx, id) => getWorkers().assertReadable(tx, id),
      modelName: (provider, id) => models.getModel(provider, id)?.name,
    });
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
      admit: async (scope, draft, expectedModelKey, digest) => {
        const current = await chats.resolve(String(scope.conversation.id));
        if (!current) throw new AttachmentAccessError(404);
        const title = Array.isArray(draft.content)
          ? draft.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
            "Image attachment"
          : draft.content;
        const result = await current.admit(draft, { digest, expectedModelKey, title });
        return { id: String(result.id) };
      },
    });
    harness.resume();
    let closed = false;
    return {
      conversation,
      chats,
      modelPolicy,
      attachments,
      tangents,
      workers,
      handoffs,
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
