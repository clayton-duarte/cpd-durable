import type { ConversationView } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ChatMessage, ChatPart, ChatState } from "../shared/chat.ts";
import {
  presentCodeModeReceipt,
  presentLiveNested,
  sanitizeCodeModeOutput,
} from "./nested-tool-presentation.ts";
import { SavedImageReferenceSchema, ImageMimeSchema } from "../shared/attachments.ts";
import { DirectShellResultSchema } from "../shared/direct-shell.ts";
import { TableDetailsSchema } from "../shared/structured-table.ts";
import { presentEditDiff } from "./edit-diff-presentation.ts";

// Allowlist presentation fields; unknown payloads and provider diagnostics never cross the wire.
const RecordIdSchema = z.number().int().positive().safe();
const MessageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.unknown())]),
  stopReason: z.string().optional(),
});
const PartSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
const ImagePartSchema = z.looseObject({
  type: z.literal("image"),
  mimeType: ImageMimeSchema,
  data: z.string(),
});
const ToolCallSchema = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.json()),
});
const ReasoningSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
});
const ToolResultSchema = z.looseObject({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.unknown()),
  isError: z.boolean(),
});
const LiveSchema = z.looseObject({
  run: z.looseObject({ taskId: RecordIdSchema.optional() }).optional(),
  generation: z
    .looseObject({
      attempt: z.number().int().positive().optional(),
      message: MessageSchema.optional(),
      retry: z.unknown().optional(),
    })
    .optional(),
  runFailure: z.looseObject({ reason: z.string() }).optional(),
  tools: z
    .array(
      z.looseObject({
        callId: z.string(),
        name: z.string(),
        taskId: RecordIdSchema.optional(),
        status: z.enum(["pending", "running", "done"]),
        output: z.string().optional(),
        diagnostics: z.array(z.looseObject({ code: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  nestedTools: z.unknown().optional(),
});
const InboxSchema = z.looseObject({
  items: z
    .array(
      z.discriminatedUnion("mode", [
        z.looseObject({
          id: RecordIdSchema,
          mode: z.enum(["steer", "followUp"]),
          content: z.union([z.string(), z.array(z.unknown())]),
        }),
        z.looseObject({
          id: RecordIdSchema,
          mode: z.literal("write"),
          entry: z.looseObject({ kind: z.string() }),
        }),
      ]),
    )
    .default([]),
});

function partsOf(
  content: z.infer<typeof MessageSchema>["content"],
  prefix: string,
  assistant = false,
  saved?: { entryId: number; modelIndex: number },
): ChatPart[] {
  if (typeof content === "string")
    return content ? [{ id: `${prefix}:0`, type: "text", text: content }] : [];
  return content.flatMap((raw, index): ChatPart[] => {
    const part = PartSchema.safeParse(raw);
    const id = `${prefix}:${index}`;
    if (saved && ImagePartSchema.safeParse(raw).success) {
      const source = SavedImageReferenceSchema.safeParse({ ...saved, partIndex: index });
      if (source.success) return [{ id, type: "image", source: source.data }];
    }
    const reasoning = assistant ? ReasoningSchema.safeParse(raw) : null;
    if (reasoning?.success)
      return reasoning.data.thinking
        ? [{ id, type: "reasoning", text: reasoning.data.thinking }]
        : [];
    const call = assistant ? ToolCallSchema.safeParse(raw) : null;
    if (call?.success)
      return [
        {
          id,
          type: "tool-call",
          callId: call.data.id,
          name: call.data.name,
          arguments: call.data.arguments,
          state: "unavailable",
        },
      ];
    if (part.success && part.data.type === "text" && part.data.text !== undefined)
      return part.data.text ? [{ id, type: "text", text: part.data.text }] : [];
    // Unsupported payloads stay omitted. Provider signatures/encrypted metadata
    // are never inferred as reasoning text or forwarded as arbitrary UI data.
    const kind = !part.success
      ? "other"
      : part.data.type === "thinking"
        ? "reasoning"
        : part.data.type === "toolCall" || part.data.type === "toolResult"
          ? "tool"
          : part.data.type === "image"
            ? "image"
            : "other";
    return [{ id, type: "omitted", kind }];
  });
}

const textOf = (parts: readonly ChatPart[]) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

function outcomeOf(reason: string | undefined): ChatMessage["outcome"] {
  switch (reason) {
    case "aborted":
      return "interrupted";
    case "error":
      return "error";
    case "length":
      return "length";
    case "stop":
    case "toolUse":
      return "complete";
    case undefined:
    default:
      return "incomplete";
  }
}

const failureReasons = new Set([
  "model_error",
  "no_model",
  "aborted",
  "reset",
  "faulted",
  "orphaned",
  "interrupted",
  "restart_limit",
  "nothing_to_answer",
  "turn_limit",
]);

export function present(
  view: ConversationView,
  canContinue = false,
  gaps: readonly { after: number; upTo: number }[] = [],
): ChatState {
  const live = LiveSchema.parse(view.docs["pi.live"] ?? {});
  const inbox = InboxSchema.parse(view.docs["pi.inbox"] ?? {});
  const taskId = live.run?.taskId;
  const generation = live.generation;
  const liveId =
    taskId !== undefined && generation?.attempt !== undefined
      ? `generation:${view.conversation.id}:${taskId}:${generation.attempt}`
      : null;
  const liveParts = generation?.message
    ? partsOf(generation.message.content, liveId ?? "partial", true)
    : [];
  const messages: ChatMessage[] = [];
  const pending = new Map<string, Extract<ChatPart, { type: "tool-call" }>>();
  const pendingTasks = new Map<string, number | undefined>();
  let gapIndex = 0;
  for (const entry of view.entries) {
    while (gaps[gapIndex] && entry.id >= gaps[gapIndex]!.upTo) {
      pending.clear();
      pendingTasks.clear();
      gapIndex++;
    }
    if (entry.kind === "cpd.direct-shell") {
      const data = z
        .strictObject({
          command: z.string().max(32_000),
          includeInContext: z.boolean(),
          result: DirectShellResultSchema,
        })
        .safeParse(entry.data);
      if (data.success) {
        const { command, includeInContext, result } = data.data;
        const id = `${entry.id}:shell`;
        messages.push({
          id,
          role: "assistant",
          text: "",
          interrupted: false,
          outcome: "complete",
          source: {
            entryId: entry.id,
            ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
          },
          parts: [
            {
              id: `${id}:0`,
              type: "tool-call",
              callId: id,
              name: includeInContext ? "Direct shell" : "Direct shell (not in model context)",
              arguments: { command },
              state:
                result.status === "complete"
                  ? "complete"
                  : result.status === "cancelled"
                    ? "cancelled"
                    : "error",
              output: `${result.truncated ? "[Earlier output truncated]\n" : ""}${result.output}${result.outputMayBeIncomplete ? "\n[Output may be incomplete; effects may be uncertain.]" : ""}${result.exitCode === undefined ? "" : `\nExit code: ${result.exitCode}`}`,
            },
          ],
        });
      }
      continue;
    }
    for (const [index, raw] of (entry.model ?? []).entries()) {
      const resultMessage =
        entry.kind === "pi.tool-result" ? ToolResultSchema.safeParse(raw) : null;
      if (resultMessage?.success) {
        const result = resultMessage.data;
        const rawOutput = partsOf(result.content, `${entry.id}:${index}`)
          .map((part) =>
            part.type === "text" ? part.text : "[Non-text tool output is not displayed.]",
          )
          .join("\n");
        const output =
          result.toolName === "codemode" ? sanitizeCodeModeOutput(raw, rawOutput) : rawOutput;
        const resultParts = result.content.map((raw, partIndex) => {
          const text = PartSchema.safeParse(raw);
          if (text.success && text.data.type === "text" && text.data.text !== undefined)
            return {
              type: "text" as const,
              text:
                result.toolName === "codemode"
                  ? sanitizeCodeModeOutput(resultMessage.data, text.data.text)
                  : text.data.text,
            };
          const source = SavedImageReferenceSchema.safeParse({
            entryId: entry.id,
            modelIndex: index,
            partIndex,
          });
          return source.success && ImagePartSchema.safeParse(raw).success
            ? { type: "image" as const, source: source.data }
            : { type: "omitted" as const };
        });
        const imageOutput = result.content.some(
          (raw) => PartSchema.safeParse(raw).data?.type === "image",
        );
        const diagnostics = z
          .looseObject({
            diagnostics: z.array(z.looseObject({ code: z.string().optional() })),
          })
          .safeParse(entry.data);
        const cancelled =
          diagnostics.success &&
          diagnostics.data.diagnostics.some((item) => item.code === "aborted");
        const call = pending.get(result.toolCallId);
        const state = cancelled ? "cancelled" : result.isError ? "error" : "complete";
        const receipt = result.toolName === "codemode" ? presentCodeModeReceipt(raw) : undefined;
        const nested =
          result.toolName === "codemode"
            ? receipt
              ? {
                  state: "available" as const,
                  calls: receipt.calls,
                  outputSpilled: receipt.outputSpilled,
                }
              : { state: "unavailable" as const, calls: [] }
            : undefined;
        if (call && call.name === result.toolName) {
          call.state = state;
          call.output = output;
          if (imageOutput) call.resultParts = resultParts;
          call.resultEntryId = entry.id;
          if (nested) call.nested = nested;
          if (call.name === "display_table" && state === "complete") {
            const details = z.looseObject({ details: TableDetailsSchema }).safeParse(raw);
            if (details.success) call.table = details.data.details;
          }
          if (call.name === "edit" && state === "complete") call.editDiff = presentEditDiff(raw);
          pending.delete(result.toolCallId);
        } else {
          // Window may start after the originating call. Keep its result visible,
          // without inventing arguments or attaching it to a different invocation.
          messages.push({
            id: `${entry.id}:${index}`,
            role: "assistant",
            text: "",
            interrupted: false,
            outcome: "complete",
            source: { entryId: entry.id },
            parts: [
              {
                id: `${entry.id}:${index}:result`,
                type: "tool-call",
                callId: result.toolCallId,
                name: result.toolName,
                arguments: {},
                argumentsUnavailable: true,
                state,
                output,
                ...(imageOutput ? { resultParts } : {}),
                resultEntryId: entry.id,
                ...(nested ? { nested } : {}),
              },
            ],
          });
        }
        continue;
      }
      const result = MessageSchema.safeParse(raw);
      if (!result.success) continue;
      const message = result.data;
      const id = `${entry.id}:${index}`;
      const parts = partsOf(
        message.content,
        id,
        entry.kind === "pi.assistant" && message.role === "assistant",
        entry.kind === "pi.user" && message.role === "user"
          ? { entryId: entry.id, modelIndex: index }
          : undefined,
      );
      if (parts.length === 0) continue;
      for (const part of parts) {
        if (part.type === "tool-call") {
          pending.set(part.callId, part);
          pendingTasks.set(part.callId, entry.byTaskId);
        }
      }
      const outcome = message.role === "assistant" ? outcomeOf(message.stopReason) : undefined;
      messages.push({
        id,
        role: message.role,
        text: textOf(parts),
        parts,
        interrupted: outcome === "interrupted",
        ...(outcome ? { outcome } : {}),
        source: {
          entryId: entry.id,
          ...(entry.kind === "pi.assistant" &&
          entry.model?.length === 1 &&
          index === 0 &&
          message.role === "assistant" &&
          entry.byTaskId !== undefined
            ? { taskId: entry.byTaskId }
            : {}),
        },
      });
    }
  }
  // Only the current round's still-unsettled calls receive live progress.
  for (const slot of live.tools ?? []) {
    const call = pending.get(slot.callId);
    if (
      call &&
      taskId !== undefined &&
      pendingTasks.get(slot.callId) === taskId &&
      call.name === slot.name &&
      slot.status !== "done"
    ) {
      call.state = slot.status;
      if (slot.output !== undefined) call.output = slot.output;
      if (slot.name === "codemode" && slot.taskId !== undefined) {
        call.nested = {
          state: "live",
          calls: presentLiveNested(live.nestedTools, {
            taskId: slot.taskId,
            callId: slot.callId,
          }),
        };
      }
    }
  }
  for (const part of liveParts) {
    if (part.type === "tool-call") part.state = "pending";
  }
  return {
    conversationId: view.conversation.id,
    window: {
      entryIds: view.entries.map((entry) => entry.id),
      ...(view.before !== undefined ? { beforeEntryId: view.before } : {}),
    },
    controls: {
      canContinue: live.run === undefined && canContinue,
      resetPending: inbox.items.some(
        (item) => item.mode === "write" && item.entry.kind === "pi.reset",
      ),
      queue: inbox.items.flatMap((item) =>
        item.mode === "write"
          ? []
          : [
              {
                id: String(item.id),
                mode: item.mode,
                text: textOf(partsOf(item.content, "queue")),
              },
            ],
      ),
    },
    messages,
    partial: textOf(liveParts),
    live:
      liveId && taskId !== undefined && liveParts.length > 0
        ? {
            id: liveId,
            taskId,
            afterEntryId: view.entries.at(-1)?.id ?? view.before ?? null,
            text: textOf(liveParts),
            parts: liveParts,
          }
        : null,
    busy: live.run !== undefined,
    hasEarlier: view.before !== undefined,
    failure: live.runFailure
      ? live.runFailure.reason === "aborted"
        ? "Response stopped."
        : `Response did not complete (${failureReasons.has(live.runFailure.reason) ? live.runFailure.reason : "unknown"}). You can send another message.`
      : generation?.retry !== undefined
        ? "The provider request failed. Retrying…"
        : null,
  };
}
