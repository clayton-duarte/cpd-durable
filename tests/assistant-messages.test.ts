import { describe, expect, it } from "vite-plus/test";
import { assistantMessages, projectAssistantMessages } from "../src/client/assistant-messages.ts";
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
    expect(messages[1]?.metadata?.custom).toMatchObject({ interrupted: true, durableId: "2:0" });
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

const streamed = (): ChatState => ({
  conversationId: 1,
  messages: [
    {
      id: "1:0",
      role: "user",
      text: "Request",
      interrupted: false,
      source: { entryId: 1 },
    },
  ],
  window: { entryIds: [1] },
  live: {
    id: "generation:1:9:1",
    taskId: 9,
    afterEntryId: 1,
    text: "Partial",
    parts: [{ id: "generation:1:9:1:0", type: "text", text: "Partial" }],
  },
  partial: "Partial",
  busy: true,
  hasEarlier: false,
  failure: null,
});
const settled = (initial: ChatState, text = "Final"): ChatState => ({
  ...initial,
  live: null,
  partial: "",
  busy: false,
  window: { entryIds: [1, 2] },
  messages: [
    ...initial.messages,
    {
      id: "2:0",
      role: "assistant",
      text,
      interrupted: false,
      outcome: "complete",
      parts: [{ id: "2:0:0", type: "text", text }],
      source: { entryId: 2, taskId: 9 },
    },
  ],
});

describe("source-proven live-to-committed identity", () => {
  it("keeps the row key across updates, corrected final content and reconnect snapshots", () => {
    const initial = streamed();
    const first = projectAssistantMessages(initial);
    const more = projectAssistantMessages(
      {
        ...initial,
        partial: "More",
        live: {
          ...initial.live!,
          text: "More",
          parts: [{ id: "generation:1:9:1:0", type: "text", text: "More" }],
        },
      },
      first,
    );
    expect(more.liveKey).toBe(first.liveKey);
    // No text-prefix assumption: final content can differ completely.
    const done = projectAssistantMessages(settled(initial, "Authoritative correction"), more);
    expect(done.messages.at(-1)?.id).toBe(first.liveKey);
    expect(done.messages.at(-1)?.metadata?.custom).toMatchObject({
      durableId: "2:0",
      partIds: ["2:0:0"],
      interrupted: false,
    });
    expect(done.messages.at(-1)?.status).toEqual({ type: "complete", reason: "stop" });
    const reconnected = projectAssistantMessages({ ...settled(initial) }, done);
    expect(reconnected.messages.at(-1)?.id).toBe(first.liveKey);
    expect(reconnected.streaming).toBe(false);
    // A new mount needs no browser identity persistence; canonical history suffices.
    expect(projectAssistantMessages(settled(initial)).messages.at(-1)?.id).toBe("2:0");
  });

  it("never matches identical text from another task, another conversation or ambiguous commits", () => {
    const initial = streamed();
    const first = projectAssistantMessages(initial);
    const wrongTask = settled(initial, "Partial");
    wrongTask.messages[1]!.source!.taskId = 10;
    expect(projectAssistantMessages(wrongTask, first).messages.at(-1)?.id).toBe("2:0");
    expect(
      projectAssistantMessages({ ...settled(initial), conversationId: 2 }, first).messages.at(-1)
        ?.id,
    ).toBe("2:0");
    const ambiguous = settled(initial);
    ambiguous.messages.push({
      ...ambiguous.messages[1]!,
      id: "3:0",
      source: { entryId: 3, taskId: 9 },
    });
    ambiguous.window = { entryIds: [1, 2, 3] };
    expect(projectAssistantMessages(ambiguous, first).aliases.size).toBe(0);
  });

  it("does not guess across a missing append boundary or unattributed scheduler salvage", () => {
    const initial = streamed();
    const first = projectAssistantMessages(initial);
    const gap = settled(initial);
    gap.window = { entryIds: [2, 3], beforeEntryId: 4 };
    expect(projectAssistantMessages(gap, first).messages.at(-1)?.id).toBe("2:0");
    const salvage = settled(initial);
    salvage.messages[1]!.source = { entryId: 2 };
    expect(projectAssistantMessages(salvage, first).messages.at(-1)?.id).toBe("2:0");
  });

  it("separates retried attempts and preserves the committed error row", () => {
    const initial = streamed();
    const first = projectAssistantMessages(initial);
    const retry = settled(initial, "Failed output");
    retry.busy = true;
    retry.messages[1]!.outcome = "error";
    retry.live = {
      id: "generation:1:9:2",
      taskId: 9,
      afterEntryId: 2,
      text: "Retry",
      parts: [{ id: "generation:1:9:2:0", type: "text", text: "Retry" }],
    };
    const next = projectAssistantMessages(retry, first);
    expect(next.messages[1]?.id).toBe(first.liveKey);
    expect(next.messages[1]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "Response failed.",
    });
    expect(next.liveKey).not.toBe(first.liveKey);
    const done = projectAssistantMessages(
      {
        ...retry,
        busy: false,
        live: null,
        window: { entryIds: [1, 2, 3] },
        messages: [
          ...retry.messages,
          {
            id: "3:0",
            role: "assistant",
            text: "Answered",
            interrupted: false,
            outcome: "complete",
            source: { entryId: 3, taskId: 9 },
          },
        ],
      },
      next,
    );
    expect(done.messages.map((message) => message.id)).toEqual([
      "1:0",
      first.liveKey,
      next.liveKey,
    ]);
    expect(new Set(done.messages.map((message) => message.id)).size).toBe(3);
  });

  it("segments reused task/attempt IDs at a proven new assistant entry", () => {
    const initial = streamed();
    const first = projectAssistantMessages(initial);
    const reused = settled(initial);
    reused.live = { ...initial.live!, afterEntryId: 2 };
    reused.busy = true;
    const next = projectAssistantMessages(reused, first);
    expect(next.messages[1]?.id).toBe(first.liveKey);
    expect(next.liveKey).not.toBe(first.liveKey);
    expect(next.messages).toHaveLength(3);
  });

  it("retains ordered omission markers and distinguishes interruption from errors and limits", () => {
    const initial = settled(streamed());
    initial.messages[1]!.parts = [
      { id: "2:0:0", type: "text", text: "Before" },
      { id: "2:0:1", type: "omitted", kind: "other" },
      { id: "2:0:2", type: "text", text: "After" },
    ];
    const content = assistantMessages(initial).at(-1)?.content;
    expect(content).toEqual([
      { type: "text", text: "Before" },
      { type: "data-omitted", data: { kind: "other" } },
      { type: "text", text: "After" },
    ]);
    for (const outcome of ["interrupted", "error", "length", "incomplete"] as const) {
      initial.messages[1]!.outcome = outcome;
      const message = assistantMessages(initial).at(-1)!;
      expect(message.status?.type).toBe("incomplete");
      if (outcome === "interrupted")
        expect(message.content).toContainEqual({ type: "data-interruption", data: {} });
      else expect(message.content).toEqual(content);
    }
  });

  it("does not invent streaming during an after-run wait or replay stale partial text", () => {
    const initial = settled(streamed());
    initial.busy = true;
    initial.partial = "Stale";
    expect(projectAssistantMessages(initial).streaming).toBe(false);
    expect(assistantMessages(initial)).toHaveLength(2);
    expect(assistantMessages(initial).at(-1)?.status).toEqual({ type: "complete", reason: "stop" });
  });
});
