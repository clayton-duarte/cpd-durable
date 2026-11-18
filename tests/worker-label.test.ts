import { describe, expect, it } from "vite-plus/test";
import { workerLabel } from "../src/server/helpers.ts";
import { HelperViewSchema } from "../src/shared/helpers.ts";

describe("worker label projection", () => {
  it("bounds UTF-8, omits later lines and redacts common absolute paths", () => {
    const label = workerLabel(
      `Investigate /private/example and ~/work ${"☃".repeat(90)}\nprivate second line`,
    )!;
    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(120);
    expect(label).not.toContain("/private/example");
    expect(label).not.toContain("~/work");
    expect(label).not.toContain("second line");
    expect(workerLabel(undefined)).toBeNull();
    expect(workerLabel("\nprivate")).toBeNull();
  });
  it("rejects oversized labels and permits legacy missing labels", () => {
    const view = {
      requestId: "r",
      taskId: "t",
      childId: null,
      mode: "background",
      model: null,
      modelName: null,
      stop: "none",
      status: "unknown",
      answerEntryId: null,
      delivery: "notify-only",
    };
    expect(HelperViewSchema.safeParse(view).success).toBe(true);
    expect(HelperViewSchema.safeParse({ ...view, label: "☃".repeat(41) }).success).toBe(false);
  });
});
