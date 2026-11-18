import { describe, expect, it } from "vite-plus/test";
import { draftInputText, type DraftIntent } from "../src/shared/draft-intent.ts";
import { draftAttemptFingerprint } from "../src/server/draft-attempts.ts";

const intent = (command: "tangent" | "side"): DraftIntent => ({
  kind: "tangent-handoff-request",
  version: 1,
  command,
});

describe("draft command intent", () => {
  it("derives both aliases and rejects escaped, mismatched, ambiguous, and empty commands", () => {
    expect(draftInputText("/tangent  find it", intent("tangent"))).toContain("Goal:\nfind it");
    expect(draftInputText("find it /side", intent("side"))).toContain("Goal:\nfind it");
    expect(draftInputText("\\/side find it", intent("side"))).toBeUndefined();
    expect(draftInputText("/side find it", intent("tangent"))).toBeUndefined();
    expect(draftInputText("/side /tangent find it", intent("side"))).toBeUndefined();
    expect(draftInputText("/side ", intent("side"))).toBeUndefined();
    expect(draftInputText("\\!literal")).toBe("!literal");
  });

  it("binds the intent while leaving the legacy fingerprint format intact", () => {
    const attempt = {
      requestId: "00000000-0000-4000-8000-000000000001",
      draftRevision: 1,
      text: "/side investigate",
      images: [],
      mode: "reject" as const,
    };
    expect(draftAttemptFingerprint({ ...attempt, intent: intent("side") })).not.toBe(
      draftAttemptFingerprint(attempt),
    );
    expect(draftAttemptFingerprint({ ...attempt, intent: intent("side") })).not.toBe(
      draftAttemptFingerprint({ ...attempt, intent: intent("tangent") }),
    );
  });
});
