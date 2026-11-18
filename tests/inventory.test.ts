import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const changedMarkdown = ["README.md", "docs/chat-components.md", "docs/pi-durable-features.md"];
const conflictMarker = (line: string) =>
  /^\s*(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/.test(line) ||
  /^\s*\|\s*={7}\s*\|/.test(line) ||
  /^\s*(?:>\s*){7}(?:\||\S)/.test(line);

describe("changed documentation structure", () => {
  it("recognizes raw and formatter-mangled marker forms", () => {
    for (const line of [
      `${"<".repeat(7)} HEAD`,
      "=".repeat(7),
      `${">".repeat(7)} branch`,
      `${"|".repeat(7)} base`,
      `| ${"=".repeat(7)} |`,
      `${"> ".repeat(7)}origin/main`,
      `${"> ".repeat(7)}| Capability | Details | Status |`,
    ])
      expect(conflictMarker(line)).toBe(true);
  });
  it("contains neither literal nor formatter-mangled conflict markers", () => {
    for (const file of changedMarkdown) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        expect(conflictMarker(line), `${file}:${index + 1}`).toBe(false);
      }
    }
  });
  it("keeps one three-column tools inventory row per capability", () => {
    const doc = readFileSync("docs/pi-durable-features.md", "utf8");
    const section = doc
      .split("## Tools and extensibility")[1]
      ?.split("## Durability, state and parallel execution")[0];
    expect(section).toBeDefined();
    const rows = section!.split(/\r?\n/).filter((line) => line.startsWith("|"));
    const expected = [
      "Coding tools",
      "Custom tools",
      "Tool-to-tool execution",
      "Deferred tool discovery",
      "Code mode",
      "Extension registry",
      "Prompt composition",
      "Hooks / wrapping",
      "After-run tasks",
      "Execution environments",
    ];
    expect(rows).toHaveLength(expected.length + 2);
    for (const row of rows) expect(row.split("|").slice(1, -1)).toHaveLength(3);
    const names = rows.slice(2).map((row) => row.split("|")[1]!.trim());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(expected));
  });
});
