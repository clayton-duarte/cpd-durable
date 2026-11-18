/** Only fresh, explicitly submitted input is parsed; callers must not parse restored drafts. */
export function parseDirectShell(
  text: string,
  composing = false,
): { command: string; includeInContext: boolean } | undefined {
  if (composing || !text.startsWith("!")) return undefined;
  const excluded = text.startsWith("!!");
  const command = text.slice(excluded ? 2 : 1).trim();
  return command ? { command, includeInContext: !excluded } : undefined;
}
import { z } from "zod";

export const DirectShellRequestSchema = z.strictObject({
  requestId: z.uuid(),
  command: z
    .string()
    .max(32_000)
    .refine((value) => !!value.trim() && !value.includes("\0")),
  includeInContext: z.boolean(),
});
export const DirectShellResultSchema = z.strictObject({
  status: z.enum(["complete", "failed", "cancelled", "interrupted"]),
  output: z.string().max(70_000),
  truncated: z.boolean(),
  outputMayBeIncomplete: z.boolean().optional(),
  exitCode: z.number().int().optional(),
});
export const DirectShellStatusSchema = z.strictObject({
  taskId: z.string(),
  requestId: z.uuid(),
  command: z.string().max(32_000),
  includeInContext: z.boolean(),
  status: z.enum(["running", "complete", "failed", "cancelled", "interrupted", "unavailable"]),
  output: z.string().max(70_000),
  truncated: z.boolean(),
  outputMayBeIncomplete: z.boolean().optional(),
  exitCode: z.number().int().optional(),
});
