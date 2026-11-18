import { describe, expect, it } from "vite-plus/test";
import { TangentViewSchema } from "../src/shared/tangents.ts";
import { tangentChildView } from "../src/client/tangents/adapter.ts";

describe("durable tangent view adapter", () => {
  it("retains lifecycle, activity, and attention independently", () => {
    const record = TangentViewSchema.parse({
      id: 2,
      parentId: 1,
      sourceId: 1,
      sourceEntryId: null,
      title: "Investigation",
      model: { provider: "example", modelId: "model", thinkingLevel: "off", name: null },
      lifecycle: "archived",
      readOnly: true,
      activity: "unknown",
      attention: "report-ready",
      handoffRevision: 1,
      startState: "create-only",
      latestHandoff: {
        revision: 1,
        kind: "delegate",
        delivery: "available",
        submissionId: null,
        accepted: false,
        handoff: {
          goal: "Investigate",
          decisions: [],
          constraints: [],
          exclusions: [],
          references: [],
          suggestedSkills: [],
          discretion: "",
          deliverable: "",
          evidence: "",
          limits: "",
        },
      },
    });
    expect(tangentChildView(record)).toEqual({
      id: "2",
      parentId: "1",
      title: "Investigation",
      model: "example/model",
      lifecycle: "archived",
      activity: "unknown",
      attention: "report-ready",
    });
    expect(
      tangentChildView({
        ...record,
        lifecycle: "open",
        activity: "interrupted",
        attention: "needs-answer",
      }),
    ).toMatchObject({ lifecycle: "open", activity: "interrupted", attention: "needs-input" });
  });
});
