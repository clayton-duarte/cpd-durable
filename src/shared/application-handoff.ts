import { z } from "zod";
import { LegacyTangentHandoffSchema } from "./handoffs.ts";

const id = z.number().int().positive().safe();

/** Presentation evidence for one placed legacy tangent input, not transcript authority. */
export const ApplicationHandoffSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.enum(["tangent-delegate", "tangent-return"]),
    originConversationId: id,
    sourceConversationId: id,
    destinationConversationId: id,
    canonicalEntryId: id,
    modelMessageIndex: z.literal(0),
    handoff: LegacyTangentHandoffSchema,
  })
  .refine(
    (value) =>
      value.originConversationId === value.destinationConversationId &&
      new TextEncoder().encode(JSON.stringify(value.handoff)).byteLength <= 32_000,
  );
export type ApplicationHandoff = z.infer<typeof ApplicationHandoffSchema>;
