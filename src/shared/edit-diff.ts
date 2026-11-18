import { z } from "zod";

export const EditDiffSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("patch"),
    patch: z.string().max(65536),
  }),
  z.strictObject({ kind: z.literal("unavailable") }),
]);

type DiffLine = { kind: "context" | "added" | "removed"; text: string };

/** Parse only a single SDK-style unified patch; unknown forms remain literal text. */
export function parseEditPatch(patch: string): DiffLine[] | undefined {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  let index = 0;
  if (rows[index]?.startsWith("Index: ")) index++;
  if (rows[index]?.startsWith("===")) index++;
  if (!rows[index++]?.startsWith("--- ") || !rows[index++]?.startsWith("+++ ")) return;
  const result: DiffLine[] = [];
  let hunks = 0;
  while (index < rows.length) {
    const header = rows[index++];
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) return;
    let old = Number(match[2] ?? "1");
    let next = Number(match[4] ?? "1");
    hunks++;
    while (index < rows.length && !rows[index]?.startsWith("@@ ")) {
      const row = rows[index++]!;
      if (row === "\\ No newline at end of file") {
        result.push({ kind: "context", text: row });
        continue;
      }
      const prefix = row[0];
      if (prefix === " ") {
        old--;
        next--;
        result.push({ kind: "context", text: row.slice(1) });
      } else if (prefix === "-") {
        old--;
        result.push({ kind: "removed", text: row.slice(1) });
      } else if (prefix === "+") {
        next--;
        result.push({ kind: "added", text: row.slice(1) });
      } else return;
      if (old < 0 || next < 0) return;
    }
    if (old !== 0 || next !== 0) return;
  }
  return hunks && result.length ? result : undefined;
}
