import { z } from "zod";
import {
  CodeModeReceiptSchema,
  NestedToolSchema,
  type CodeModeReceipt,
  type NestedTool,
} from "../shared/nested-tools.ts";

const Id = z.number().int().positive().safe();
const Slot = z.looseObject({
  callId: z.string().min(1),
  parentCallId: z.string().min(1),
  parentTaskId: Id,
  taskId: Id,
  name: z.string().min(1),
  status: z.enum(["pending", "running", "done"]),
  summary: z.looseObject({ isError: z.boolean() }).optional(),
});
const Receipt = z.looseObject({
  role: z.literal("toolResult"),
  toolName: z.literal("codemode"),
  toolCallId: z.string().min(1),
  details: z.looseObject({
    calls: z.array(
      z.looseObject({
        id: z.number().int().positive().safe(),
        name: z.string().min(1),
        status: z.enum(["running", "ok", "error", "cancelled"]),
      }),
    ),
    fullOutputPath: z.string().optional(),
  }),
});

/**
 * Project only slots directly owned by the identified live code-mode task.
 * Parent identity comes from the actual live tool slot, never from callId alone.
 * An absent summary is unknown, not a success. Caller scopes to its conversation.
 */
export function presentLiveNested(
  value: unknown,
  parent: { taskId: number; callId: string },
): NestedTool[] {
  const list = z.array(z.unknown()).safeParse(value);
  if (!list.success) return [];
  return list.data.flatMap((raw) => {
    const result = Slot.safeParse(raw);
    if (!result.success) return [];
    const item = result.data;
    if (item.parentTaskId !== parent.taskId || item.parentCallId !== parent.callId) return [];
    const state =
      item.status !== "done"
        ? item.status
        : item.summary === undefined
          ? "unavailable"
          : item.summary.isError
            ? "error"
            : "complete";
    return [
      NestedToolSchema.parse({
        callId: item.callId,
        parentCallId: item.parentCallId,
        name: item.name,
        state,
      }),
    ];
  });
}

/**
 * Extract code-mode's persisted per-call details from its tool-result message.
 * No details means no receipt (including interrupted/older results); do not
 * invent completion. Raw error strings, arguments and spill paths stay private.
 */
export function presentCodeModeReceipt(value: unknown): CodeModeReceipt | undefined {
  const parsed = Receipt.safeParse(value);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  return CodeModeReceiptSchema.parse({
    parentCallId: result.toolCallId,
    calls: result.details.calls.map((call) => ({
      callId: `${result.toolCallId}/c${call.id}`,
      parentCallId: result.toolCallId,
      name: call.name,
      state:
        call.status === "ok" ? "complete" : call.status === "running" ? "unavailable" : call.status,
    })),
    outputSpilled: result.details.fullOutputPath !== undefined,
  });
}
