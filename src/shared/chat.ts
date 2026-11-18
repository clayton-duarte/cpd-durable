import { z } from "zod";
import { NestedToolDisplaySchema } from "./nested-tools.ts";
import { AttachmentIdSchema, SavedImageReferenceSchema } from "./attachments.ts";
import { TableDetailsSchema } from "./structured-table.ts";

export const PROVIDER_ID = "opencode-go";
export const MODEL_ID = "deepseek-v4.1-flash";

export const SendModeSchema = z.enum(["reject", "followUp", "steer"]);
export type SendMode = z.infer<typeof SendModeSchema>;
export const InputSchema = z
  .strictObject({
    requestId: z.uuid(),
    text: z.string().trim().max(32_000),
    images: z.array(AttachmentIdSchema).max(4).optional(),
    mode: SendModeSchema.optional(),
  })
  .refine(
    (input) =>
      (!!input.text || !!input.images?.length) &&
      new Set(input.images).size === (input.images?.length ?? 0),
  );
export type ChatInput = z.infer<typeof InputSchema>;

export const ControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("continue"), requestId: z.uuid() }),
  z.strictObject({
    type: z.literal("reset"),
    requestId: z.uuid(),
    handoff: z.string().trim().max(32_000),
  }),
]);
export type ChatControl = z.infer<typeof ControlSchema>;
export const WithdrawSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((id) => Number.isSafeInteger(Number(id))),
});
export const WithdrawResultSchema = z.strictObject({
  status: z.enum(["aborted", "already_placed", "settled", "not_found"]),
});

const RecordIdSchema = z.number().int().positive().safe();
export const HistoryGapSchema = z
  .strictObject({
    after: RecordIdSchema,
    upTo: RecordIdSchema,
  })
  .refine((gap) => gap.upTo > gap.after, "Invalid history gap");
export type HistoryGap = z.infer<typeof HistoryGapSchema>;
export const HistoryQuerySchema = z.strictObject({
  view: z.uuid(),
  oldest: z.coerce.number().int().positive().safe().optional(),
});
export const HistoryLoadSchema = z.strictObject({
  view: z.uuid(),
  gap: HistoryGapSchema.optional(),
});
export const ToolStateSchema = z.enum([
  "pending",
  "running",
  "complete",
  "error",
  "cancelled",
  "unavailable",
]);
export const ToolResultPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("image"), source: SavedImageReferenceSchema }),
  z.strictObject({ type: z.literal("omitted") }),
]);
export const ChatPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: z.string(), type: z.literal("text"), text: z.string() }),
  z.strictObject({ id: z.string(), type: z.literal("reasoning"), text: z.string() }),
  z.strictObject({ id: z.string(), type: z.literal("image"), source: SavedImageReferenceSchema }),
  z.strictObject({
    id: z.string(),
    type: z.literal("tool-call"),
    callId: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.json()),
    argumentsUnavailable: z.boolean().optional(),
    state: ToolStateSchema,
    output: z.string().optional(),
    resultParts: z.array(ToolResultPartSchema).optional(),
    resultEntryId: RecordIdSchema.optional(),
    nested: NestedToolDisplaySchema.optional(),
    table: TableDetailsSchema.optional(),
  }),
  z.strictObject({
    id: z.string(),
    type: z.literal("omitted"),
    kind: z.enum(["reasoning", "tool", "image", "other"]),
  }),
]);
export const MessageOutcomeSchema = z.enum([
  "complete",
  "interrupted",
  "error",
  "length",
  "incomplete",
]);
export const ChatMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  interrupted: z.boolean(),
  parts: z.array(ChatPartSchema).optional(),
  outcome: MessageOutcomeSchema.optional(),
  source: z
    .strictObject({
      entryId: RecordIdSchema,
      // Known SDK assistant entries and direct-shell result entries carry task attribution.
      taskId: RecordIdSchema.optional(),
    })
    .optional(),
});

export const ChatStateSchema = z
  .strictObject({
    messages: z.array(ChatMessageSchema),
    partial: z.string(),
    busy: z.boolean(),
    hasEarlier: z.boolean(),
    failure: z.string().nullable(),
    conversationId: RecordIdSchema.optional(),
    history: z
      .strictObject({
        view: z.uuid(),
        epoch: z.uuid(),
        revision: z.number().int().nonnegative().safe(),
        oldest: RecordIdSchema.optional(),
        gaps: z.array(HistoryGapSchema),
      })
      .optional(),
    window: z
      .strictObject({
        entryIds: z.array(RecordIdSchema),
        beforeEntryId: RecordIdSchema.optional(),
      })
      .optional(),
    live: z
      .strictObject({
        id: z.string(),
        taskId: RecordIdSchema,
        afterEntryId: RecordIdSchema.nullable(),
        text: z.string(),
        parts: z.array(ChatPartSchema),
      })
      .nullable()
      .optional(),
    controls: z
      .strictObject({
        canContinue: z.boolean(),
        resetPending: z.boolean(),
        queue: z.array(
          z.strictObject({
            id: z.string(),
            mode: z.enum(["followUp", "steer"]),
            text: z.string(),
          }),
        ),
      })
      .optional(),
  })
  .superRefine((state, context) => {
    if (
      state.history &&
      new Set(state.history.gaps.map((gap) => `${gap.after}:${gap.upTo}`)).size !==
        state.history.gaps.length
    )
      context.addIssue({ code: "custom", message: "Duplicate history gap" });
    if (new Set(state.messages.map((message) => message.id)).size !== state.messages.length)
      context.addIssue({ code: "custom", message: "Duplicate message identity" });
    for (const message of state.messages) {
      if (
        message.parts &&
        new Set(message.parts.map((part) => part.id)).size !== message.parts.length
      )
        context.addIssue({ code: "custom", message: "Duplicate part identity" });
    }
    if (
      state.live &&
      new Set(state.live.parts.map((part) => part.id)).size !== state.live.parts.length
    )
      context.addIssue({ code: "custom", message: "Duplicate live part identity" });
  });
export type ChatState = z.infer<typeof ChatStateSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatPart = z.infer<typeof ChatPartSchema>;

export const SubmissionSchema = z.strictObject({ id: z.string() });
export const ApiErrorSchema = z.strictObject({ error: z.string() });
