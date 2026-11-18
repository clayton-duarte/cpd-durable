import { z } from "zod";
import { ChatIdSchema } from "./chats.ts";

export const RegenerationRequestSchema = z.strictObject({
  sourceId: ChatIdSchema,
  entryId: ChatIdSchema,
  requestId: z.uuid(),
});
export type RegenerationRequest = z.infer<typeof RegenerationRequestSchema>;

export const RegenerationReceiptSchema = z.strictObject({
  type: z.literal("regenerate"),
  sourceId: ChatIdSchema,
  entryId: ChatIdSchema,
  branchId: ChatIdSchema,
  forkEntryId: ChatIdSchema,
  status: z.enum(["prepared", "admitted"]),
  submissionId: ChatIdSchema.optional(),
});
export type RegenerationReceipt = z.infer<typeof RegenerationReceiptSchema>;
export const RecentRegenerationsSchema = z.strictObject({
  operations: z.array(RegenerationReceiptSchema.extend({ requestId: z.uuid() })).max(20),
});
