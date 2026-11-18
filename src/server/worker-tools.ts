import {
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { HelperLaunchSchema } from "../shared/helpers.ts";
import {
  collectHelperResult,
  inspectHelpers,
  launchHelper,
  requestWorkerStop,
  type WorkerDependencies,
} from "./helpers.ts";

export type WorkerToolDependencies = {
  harness(): Harness;
  policy: WorkerDependencies;
  assertReadable(tx: Tx, id: ConversationId): Promise<void>;
};

/** Install before Harness.open; the closure must resolve the active host Harness. */
export function createWorkerTools(deps: WorkerToolDependencies) {
  const taskId = z.strictObject({
    taskId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(20),
  });
  const launch = HelperLaunchSchema.omit({ requestId: true });
  return defineExtension({
    name: "cpd.worker-tools",
    tools: [
      defineTool({
        name: "launch_worker",
        description:
          "Admit an owned worker. Completion is separate; no result is sent to the parent automatically.",
        parameters: z.toJSONSchema(launch, { io: "input" }),
        replay: "safe",
        async execute(args, api, context) {
          const admission: Pick<Conversation, "id" | "commit"> = {
            id: api.conversationId,
            commit: (change) => api.commit(change, context),
          };
          const id = await launchHelper(
            admission,
            {
              ...launch.parse(args),
              requestId: `worker-tool:${api.taskId}`,
            },
            deps.policy,
          );
          return {
            output: [{ type: "text", text: JSON.stringify({ taskId: id, status: "admitted" }) }],
          };
        },
      }),
      defineTool({
        name: "stop_worker",
        description: "Request Stop for one owned worker. Admission is not proof it has stopped.",
        parameters: z.toJSONSchema(taskId),
        replay: "safe",
        async execute(args, api, context) {
          const admission: Pick<Conversation, "id" | "commit"> = {
            id: api.conversationId,
            commit: (change) => api.commit(change, context),
          };
          const result = await requestWorkerStop(
            deps.harness(),
            admission,
            taskId.parse(args).taskId,
            { requestId: `worker-stop-tool:${api.taskId}` },
            deps.policy,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "inspect_workers",
        description:
          "Inspect workers owned by this conversation, including unknown and unsettled states.",
        parameters: z.toJSONSchema(z.strictObject({})),
        replay: "safe",
        async execute(_args, api, context) {
          await api.commit((tx) => deps.assertReadable(tx, api.conversationId), context);
          const parent = await deps.harness().conversation(api.conversationId, context);
          if (!parent) throw new Error("Parent conversation unavailable");
          const view = await inspectHelpers(deps.harness(), parent);
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  ...view,
                  helpers: view.helpers.map((helper) => ({
                    ...helper,
                    modelName: helper.model
                      ? (api.models.getModel(helper.model.provider, helper.model.modelId)?.name ??
                        null)
                      : null,
                  })),
                }),
              },
            ],
          };
        },
      }),
      defineTool({
        name: "collect_worker",
        description:
          "Read an owned worker's finished result without sending it to the parent or marking review accepted.",
        parameters: z.toJSONSchema(taskId),
        replay: "safe",
        async execute(args, api, context) {
          await api.commit((tx) => deps.assertReadable(tx, api.conversationId), context);
          const parent = await deps.harness().conversation(api.conversationId, context);
          if (!parent) throw new Error("Parent conversation unavailable");
          const result = await collectHelperResult(
            deps.harness(),
            parent,
            taskId.parse(args).taskId,
          );
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
    ],
  });
}
