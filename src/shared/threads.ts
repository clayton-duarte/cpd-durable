import { z } from "zod";
import { ChatIdSchema } from "./chats.ts";
import { QuoteTextSchema, quotedReply } from "./quote.ts";

export const THREAD_SOURCE_TEXT_LIMIT = 4_000;
export const THREAD_REPLY_TEXT_LIMIT = 28_000;
export const THREAD_REPLY_COUNT_LIMIT = 500;

export const ThreadSourceSchema = z.strictObject({
  entryId: ChatIdSchema,
  role: z.enum(["user", "assistant", "other"]),
  text: z.string().max(THREAD_SOURCE_TEXT_LIMIT + 64),
  truncated: z.boolean(),
});
export type ThreadSource = z.infer<typeof ThreadSourceSchema>;

export const ThreadViewSchema = z.strictObject({
  id: ChatIdSchema,
  parentId: ChatIdSchema,
  sourceEntryId: ChatIdSchema,
  slug: z.string().min(1).max(120),
  title: z.string().max(80),
  // Bounded scan: a thread with more replies than the limit reports the limit.
  replyCount: z.number().int().nonnegative().safe(),
  replyCountCapped: z.boolean(),
  activity: z.enum(["running", "waiting", "idle", "interrupted", "failed"]),
  source: ThreadSourceSchema,
});
export type ThreadView = z.infer<typeof ThreadViewSchema>;

export const ThreadListSchema = z.strictObject({ threads: z.array(ThreadViewSchema) });
export const ThreadSourceResponseSchema = z.strictObject({ source: ThreadSourceSchema });
export const CreateThreadSchema = z
  .strictObject({
    requestId: z.string().min(1).max(120),
    parentId: ChatIdSchema,
    sourceEntryId: ChatIdSchema,
    text: z.string().trim().min(1).max(THREAD_REPLY_TEXT_LIMIT),
    quote: QuoteTextSchema.optional(),
  })
  .refine(({ text, quote }) => quote === undefined || quotedReply(text, quote).length <= 32_000);
export type CreateThread = z.infer<typeof CreateThreadSchema>;
export const CreateThreadResponseSchema = z.strictObject({
  thread: ThreadViewSchema,
  admitted: z.boolean(),
});
