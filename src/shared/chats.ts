import { z } from "zod";

export const ChatIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((id) => Number.isSafeInteger(Number(id)));
export const ChatSummarySchema = z.strictObject({
  id: ChatIdSchema,
  title: z.string(),
  running: z.boolean(),
});
export const ChatCatalogSchema = z
  .strictObject({
    rootId: ChatIdSchema,
    chats: z.array(ChatSummarySchema),
  })
  .refine(
    (catalog) => new Set(catalog.chats.map((chat) => chat.id)).size === catalog.chats.length,
    "Duplicate chat identity",
  )
  .refine(
    (catalog) => catalog.chats.some((chat) => chat.id === catalog.rootId),
    "Missing original chat",
  );
export const CreateChatSchema = z.strictObject({ requestId: z.uuid() });
export type ChatSummary = z.infer<typeof ChatSummarySchema>;
export type ChatCatalog = z.infer<typeof ChatCatalogSchema>;
