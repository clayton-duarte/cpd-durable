import { describe, expect, it } from "vite-plus/test";
import { EditDiffSchema, parseEditPatch } from "../src/shared/edit-diff.ts";
import { presentEditDiff } from "../src/server/edit-diff-presentation.ts";

const receipt = (patch: string, diff = "diff") => ({
  role: "toolResult",
  toolName: "edit",
  toolCallId: "one",
  isError: false,
  details: { patch, diff, secret: "not projected" },
});

describe("bounded native edit receipts", () => {
  it("parses multi-hunk changes, empty-file additions and deletions without fabricating snapshots", () => {
    const patch = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n context\n-old\n+新\n@@ -9,1 +9,0 @@\n-gone\n";
    expect(parseEditPatch(patch)).toEqual([
      { kind: "context", text: "context" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "新" },
      { kind: "removed", text: "gone" },
    ]);
    expect(parseEditPatch("--- a\n+++ b\n@@ -0,0 +1,1 @@\n+hello\n")).toEqual([
      { kind: "added", text: "hello" },
    ]);
    expect(parseEditPatch("--- a\n+++ b\n@@ -1,1 +0,0 @@\n-bye\n")).toEqual([
      { kind: "removed", text: "bye" },
    ]);
    expect(parseEditPatch("--- a\n+++ b\n@@ -1,2 +1,1 @@\n-a\n+b\n")).toBeUndefined();
  });

  it("rejects malformed, oversized and wrong-identity details without forwarding extras", () => {
    expect(presentEditDiff(receipt("patch"))).toEqual({ kind: "patch", patch: "patch" });
    expect(presentEditDiff(receipt("é".repeat(32769)))).toEqual({ kind: "unavailable" });
    expect(presentEditDiff(receipt("a\n".repeat(1000)))).toEqual({ kind: "unavailable" });
    expect(presentEditDiff({ ...receipt("x"), isError: true })).toEqual({ kind: "unavailable" });
    expect(presentEditDiff({ ...receipt("x"), toolName: "read" })).toEqual({ kind: "unavailable" });
    expect(presentEditDiff({ ...receipt("x"), details: undefined })).toEqual({
      kind: "unavailable",
    });
    expect(EditDiffSchema.safeParse({ kind: "patch", patch: "é".repeat(32769) }).success).toBe(
      false,
    );
    expect(EditDiffSchema.safeParse({ kind: "patch", patch: "a\n".repeat(1000) }).success).toBe(
      false,
    );
  });
});
