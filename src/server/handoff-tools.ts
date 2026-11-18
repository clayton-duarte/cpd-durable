import { defineExtension, defineTool, type Harness } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  HandoffActionSchema,
  RecordHandoffSchema,
  ReviewHandoffSchema,
} from "../shared/handoffs.ts";
import { createHandoffService, handoffParent, type HandoffGuards } from "./handoffs.ts";

/** Tools are caller-bound: no argument can select the actor conversation. */
export function createHandoffTools(guards: HandoffGuards) {
  const recordBase = RecordHandoffSchema.omit({
    operationId: true,
    parentId: true,
    childId: true,
    kind: true,
    delivery: true,
  });
  const childId = z.number().int().positive().safe();
  const parentRecord = recordBase.extend({ childId });
  const recordTool = (
    name: string,
    kind: "delegate" | "update" | "escalate" | "return",
    fromParent: boolean,
  ) =>
    defineTool({
      name,
      description:
        "Record a notify-only handoff. This does not admit a message, prove it was read, or start a model request.",
      parameters: z.toJSONSchema(fromParent ? parentRecord : recordBase, { io: "input" }),
      replay: "safe",
      async execute(args, api, context) {
        const driver: Pick<Harness, "commit"> = { commit: (change) => api.commit(change, context) };
        const peer = fromParent
          ? parentRecord.parse(args).childId
          : await api.commit((tx) => handoffParent(tx, api.conversationId), context);
        const base = recordBase.parse(
          fromParent
            ? (() => {
                const { childId: _id, ...rest } = parentRecord.parse(args);
                return rest;
              })()
            : args,
        );
        const service = createHandoffService(driver, { id: api.conversationId }, guards);
        const result = await service.record({
          ...base,
          operationId: `handoff-tool:${api.taskId}`,
          parentId: fromParent ? api.conversationId : peer,
          childId: fromParent ? peer : api.conversationId,
          kind,
          delivery: "notify-only",
        });
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      },
    });
  const collect = HandoffActionSchema.omit({ operationId: true, parentId: true });
  const review = ReviewHandoffSchema.omit({ operationId: true, parentId: true });
  const inspect = HandoffActionSchema.omit({ operationId: true, parentId: true, revision: true });
  return defineExtension({
    name: "cpd.handoff-tools",
    tools: [
      recordTool("delegate_handoff", "delegate", true),
      recordTool("update_handoff", "update", true),
      recordTool("escalate_handoff", "escalate", false),
      recordTool("report_handoff", "return", false),
      defineTool({
        name: "inspect_handoffs",
        description:
          "Inspect notify-only handoff records for one child and assignment; this does not deliver them.",
        parameters: z.toJSONSchema(inspect),
        replay: "safe",
        async execute(args, api, context) {
          const input = inspect.parse(args);
          const driver: Pick<Harness, "commit"> = {
            commit: (change) => api.commit(change, context),
          };
          const service = createHandoffService(driver, { id: api.conversationId }, guards);
          const records = await service.list(api.conversationId, input.childId, input.assignmentId);
          return { output: [{ type: "text", text: JSON.stringify({ records }) }] };
        },
      }),
      defineTool({
        name: "collect_handoff",
        description:
          "Explicitly collect a return or escalation; collection does not prove comprehension.",
        parameters: z.toJSONSchema(collect),
        replay: "safe",
        async execute(args, api, context) {
          const driver: Pick<Harness, "commit"> = {
            commit: (change) => api.commit(change, context),
          };
          const service = createHandoffService(driver, { id: api.conversationId }, guards);
          const result = await service.collect({
            ...collect.parse(args),
            parentId: api.conversationId,
            operationId: `handoff-tool:${api.taskId}`,
          });
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
      defineTool({
        name: "review_handoff",
        description: "Record the parent's explicit review of a collected visible return.",
        parameters: z.toJSONSchema(review),
        replay: "safe",
        async execute(args, api, context) {
          const driver: Pick<Harness, "commit"> = {
            commit: (change) => api.commit(change, context),
          };
          const service = createHandoffService(driver, { id: api.conversationId }, guards);
          const result = await service.review({
            ...review.parse(args),
            parentId: api.conversationId,
            operationId: `handoff-tool:${api.taskId}`,
          });
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }),
    ],
  });
}
