import { z } from "zod";

const IdSchema = z.number().int().positive().safe();
const ChatIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((id) => Number.isSafeInteger(Number(id)));

// The caller supplies catalog-authorized, nondeleted IDs; no SDK-wide discovery is implied.
export const TranscriptScopeSchema = z.strictObject({
  conversationIds: z
    .array(ChatIdSchema)
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length),
  includeArchived: z.boolean(),
});
export type TranscriptScope = z.infer<typeof TranscriptScopeSchema>;

export const TranscriptLimitsSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(200).default(50),
  maxEntries: z.number().int().min(1).max(1_000_000).default(100_000),
});
export type TranscriptLimits = z.input<typeof TranscriptLimitsSchema>;

export const TranscriptMessageSchema = z.strictObject({
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  // Index is the original model content-array index, or 0 for string content.
  textParts: z.array(
    z.strictObject({ partIndex: z.number().int().nonnegative(), text: z.string() }),
  ),
  omittedContent: z.boolean(),
});
export const TranscriptEntrySchema = z.strictObject({
  conversationId: ChatIdSchema,
  originConversationId: ChatIdSchema,
  entryId: IdSchema,
  kind: z.enum(["user", "assistant", "reset", "compaction", "other"]),
  headEntryId: IdSchema.optional(),
  omittedContent: z.boolean(),
  messages: z.array(TranscriptMessageSchema),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const TranscriptReportSchema = z.strictObject({
  scope: TranscriptScopeSchema,
  status: z.enum(["complete", "capped", "cancelled"]),
  partial: z.boolean(),
  scannedEntries: z.number().int().nonnegative().safe(),
  conversations: z.array(
    z.strictObject({
      conversationId: ChatIdSchema,
      archived: z.boolean(),
      // Absent: cancellation prevented freezing. Null: empty at the freeze boundary.
      upperEntryId: IdSchema.nullable().optional(),
      scannedEntries: z.number().int().nonnegative().safe(),
      complete: z.boolean(),
    }),
  ),
});
export type TranscriptReport = z.infer<typeof TranscriptReportSchema>;

export const TranscriptSearchSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(512)
    .refine((query) => query.trim().length > 0 && Array.from(query).length <= 256)
    .refine((query) =>
      Array.from(query).every((character) => {
        const point = character.codePointAt(0)!;
        return point < 0xd800 || point > 0xdfff;
      }),
    ),
  caseSensitive: z.boolean(),
  maxResults: z.number().int().min(1).max(1000).default(100),
});
export type TranscriptSearch = z.input<typeof TranscriptSearchSchema>;
export const TranscriptSearchResultSchema = z.strictObject({
  report: TranscriptReportSchema,
  query: z.string(),
  caseSensitive: z.boolean(),
  offsetEncoding: z.literal("utf-16"),
  hits: z.array(
    z.strictObject({
      conversationId: ChatIdSchema,
      originConversationId: ChatIdSchema,
      entryId: IdSchema,
      messageId: z.string(),
      role: z.enum(["user", "assistant"]),
      partIndex: z.number().int().nonnegative(),
      // Offsets are relative to the original text part, in UTF-16 code units.
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      match: z.string(),
      before: z.string().max(80),
      after: z.string().max(80),
    }),
  ),
});
export type TranscriptSearchResult = z.infer<typeof TranscriptSearchResultSchema>;

export const TranscriptExportOptionsSchema = z.strictObject({
  maxTextCharacters: z.number().int().min(1).max(50_000_000).default(10_000_000),
});
export type TranscriptExportOptions = z.input<typeof TranscriptExportOptionsSchema>;
export const TranscriptExportSchema = z.strictObject({
  format: z.literal("cpd-logical-transcript-v1"),
  restorableBackup: z.literal(false),
  contentPolicy: z.literal("user-assistant-text-only"),
  inheritedHistory: z.literal("repeated-per-conversation"),
  report: TranscriptReportSchema,
  entries: z.array(TranscriptEntrySchema),
});
export type TranscriptExport = z.infer<typeof TranscriptExportSchema>;

export const HistorySearchRequestSchema = z.strictObject({
  scope: TranscriptScopeSchema,
  search: TranscriptSearchSchema,
});
export const HistoryExportRequestSchema = z.strictObject({
  scope: TranscriptScopeSchema,
  format: z.enum(["json", "markdown"]),
});
export const HistoryDownloadSchema = z.strictObject({
  format: z.enum(["json", "markdown"]),
  content: z.string(),
  report: TranscriptReportSchema,
});
