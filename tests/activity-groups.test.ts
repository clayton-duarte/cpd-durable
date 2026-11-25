import { describe, expect, it } from "vite-plus/test";
import type { ThreadMessage } from "@assistant-ui/react";
import { activityGroups } from "../src/client/activity-groups.ts";

const message = (id: string, content: unknown[], extra = {}) =>
  ({
    id,
    role: "assistant",
    content,
    metadata: { custom: {} },
    status: { type: "complete", reason: "stop" },
    ...extra,
  }) as unknown as ThreadMessage;
const tool = { type: "tool-call", toolCallId: "call", toolName: "read", args: {} };

describe("view-only activity grouping", () => {
  it("combines consecutive tools and reasoning but never crosses text or user boundaries", () => {
    const messages = [
      message("1", [tool]),
      message("2", [{ type: "reasoning", text: "Thinking" }]),
      message("3", [{ type: "text", text: "Update" }, tool]),
      message("4", [tool]),
      message("5", [{ type: "text", text: "Next" }], { role: "user" }),
      message("6", [tool]),
    ];
    expect(activityGroups(messages).map((g) => g.indices)).toEqual([[0, 1], [2], [3], [4], [5]]);
    expect(messages.map((m) => m.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
  it("keeps gaps, interruptions, failures, images and empty live messages visible", () => {
    const messages = [
      message("1", [tool]),
      message("2", [tool], { status: { type: "incomplete", reason: "error" } }),
      message("3", [{ type: "data-history-gap", data: {} }]),
      message("4", [tool, { type: "data-interruption", data: {} }]),
      message("5", [tool, { type: "image", image: "example" }]),
      message("6", [], { status: { type: "running" } }),
      message("7", [tool], { status: { type: "running" } }),
    ];
    expect(activityGroups(messages).map((g) => g.activity)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});
