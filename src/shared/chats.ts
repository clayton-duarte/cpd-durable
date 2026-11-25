import { z } from "zod";

export const ChatIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((id) => Number.isSafeInteger(Number(id)));
export const ChatSummarySchema = z.strictObject({
  id: ChatIdSchema,
  title: z.string(),
  running: z.boolean(),
  status: z.enum(["regular", "archived"]).default("regular"),
  /** Readable URL fragment; a catalog without one still resolves by numeric id. */
  slug: z.string().min(1).max(120).optional(),
  parentId: ChatIdSchema.optional(),
  forkEntryId: ChatIdSchema.optional(),
  branchRootId: ChatIdSchema.optional(),
});
export const ChatCatalogSchema = z
  .strictObject({
    rootId: ChatIdSchema,
    chats: z.array(ChatSummarySchema),
  })
  .refine(
    (catalog) => new Set(catalog.chats.map((chat) => chat.id)).size === catalog.chats.length,
    "Duplicate chat identity",
  );
export const CreateChatSchema = z.strictObject({ requestId: z.uuid() });
export const RenameChatSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  expected: z.string(),
});
export const ForkChatSchema = z.strictObject({ requestId: z.uuid(), at: ChatIdSchema });
export const ChatActionSchema = z.strictObject({
  action: z.enum(["archive", "unarchive", "delete"]),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;
export type ChatCatalog = z.infer<typeof ChatCatalogSchema>;
