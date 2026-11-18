import { z } from "zod";
import { ChatIdSchema } from "./chats.ts";

export const EditBranchRequestSchema = z.strictObject({
  sourceId: ChatIdSchema,
  entryId: ChatIdSchema,
  requestId: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(32_000)
    .refine((text) => text.trim().length > 0),
});
export type EditBranchRequest = z.infer<typeof EditBranchRequestSchema>;

export const EditBranchReceiptSchema = z.strictObject({
  type: z.literal("edit"),
  sourceId: ChatIdSchema,
  entryId: ChatIdSchema,
  branchId: ChatIdSchema,
  // Null means the target was the first visible entry and a new conversation was created.
  forkEntryId: ChatIdSchema.nullable(),
  configuration: z.enum(["fork-boundary", "source-current-at-creation"]),
  status: z.enum(["prepared", "admitted"]),
  submissionId: ChatIdSchema.optional(),
});
export type EditBranchReceipt = z.infer<typeof EditBranchReceiptSchema>;

export const RecentEditOperationsSchema = z.strictObject({
  operations: z.array(EditBranchReceiptSchema.extend({ requestId: z.uuid() })).max(20),
});
export type RecentEditOperation = z.infer<typeof RecentEditOperationsSchema>["operations"][number];
