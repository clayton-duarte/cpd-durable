import { z } from "zod";
import { EditDiffSchema } from "../shared/edit-diff.ts";

const Receipt = z.looseObject({
  role: z.literal("toolResult"),
  toolName: z.literal("edit"),
  toolCallId: z.string().min(1),
  isError: z.literal(false),
  details: z.looseObject({ diff: z.string(), patch: z.string() }),
});

export function presentEditDiff(value: unknown) {
  const result = Receipt.safeParse(value);
  if (!result.success) return { kind: "unavailable" as const };
  const { patch, diff } = result.data.details;
  if (
    !patch ||
    !diff ||
    Buffer.byteLength(patch, "utf8") > 65536 ||
    Buffer.byteLength(diff, "utf8") > 65536 ||
    patch.split("\n").length > 1000 ||
    diff.split("\n").length > 1000
  )
    return { kind: "unavailable" as const };
  return EditDiffSchema.parse({ kind: "patch", patch });
}
