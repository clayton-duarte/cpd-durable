import { describe, expect, it } from "vite-plus/test";
import { assistantMessages } from "../src/client/assistant-messages.ts";
import type { ChatState } from "../src/shared/chat.ts";

const state: ChatState = {
  messages: [
    { id: "1:0", role: "user", text: "Literal\n  **text**", interrupted: false },
    { id: "2:0", role: "assistant", text: "Interrupted", interrupted: true },
    { id: "3:0", role: "assistant", text: "Separate reply", interrupted: false },
  ],
  partial: "Streaming",
  busy: true,
  hasEarlier: true,
  failure: null,
};

describe("assistant-ui presentation adapter", () => {
  it("retains durable order, IDs, literal text and separate assistant entries", () => {
    const messages = assistantMessages(state);
    expect(messages.map((message) => message.id)).toEqual(["1:0", "2:0", "3:0", "live:partial"]);
    expect(messages[0]?.content).toEqual([{ type: "text", text: "Literal\n  **text**" }]);
    expect(messages[1]?.status).toEqual({ type: "incomplete", reason: "other" });
    expect(messages[1]?.content).toContainEqual({ type: "data-interruption", data: {} });
    expect(messages[1]?.metadata?.custom).toEqual({ interrupted: true });
    expect(messages[2]?.status).toEqual({ type: "complete", reason: "stop" });
    expect(messages[3]?.status).toEqual({ type: "running" });
    expect(state.messages).toHaveLength(3);
  });

  it("updates a single partial identity and replaces it with authoritative committed output", () => {
    const first = assistantMessages(state);
    const next = assistantMessages({ ...state, partial: "Streaming more" });
    expect(next.at(-1)?.id).toBe(first.at(-1)?.id);
    const settled = assistantMessages({
      ...state,
      partial: "",
      busy: false,
      messages: [
        ...state.messages,
        { id: "4:0", role: "assistant", text: "Streaming more", interrupted: false },
      ],
    });
    expect(settled.map((message) => message.id)).toEqual(["1:0", "2:0", "3:0", "4:0"]);
    expect(assistantMessages(null)).toEqual([]);
  });
});
