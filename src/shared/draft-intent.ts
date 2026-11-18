import { z } from "zod";
import { modelInputText } from "./direct-shell.ts";

export const DraftIntentSchema = z.strictObject({
  kind: z.literal("tangent-handoff-request"),
  version: z.literal(1),
  command: z.enum(["tangent", "side"]),
});
export type DraftIntent = z.infer<typeof DraftIntentSchema>;

/** Returns undefined for malformed or ambiguous commands, never an arbitrary replacement. */
export function draftInputText(text: string, intent?: DraftIntent): string | undefined {
  if (!intent) return modelInputText(text);
  const matches = [...text.matchAll(/(?:^|\s)\/(tangent|side)(?=\s|$)/gu)];
  if (matches.length !== 1 || matches[0]?.[1] !== intent.command) return undefined;
  const match = matches[0];
  if (!match || match.index === undefined) return undefined;
  const slash = match.index + match[0].indexOf("/");
  const goal = (text.slice(0, slash) + text.slice(slash + intent.command.length + 1)).trim();
  if (!goal) return undefined;
  return `Please prepare a bounded handoff for the following goal and use create_tangent to create an interactive tangent. Include relevant decisions, constraints, references, and the expected deliverable. Create it without starting work (start: false).\n\nGoal:\n${goal}`;
}
