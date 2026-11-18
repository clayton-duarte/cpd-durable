import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";
import { present } from "../src/server/presentation.ts";
import { ChatStateSchema } from "../src/shared/chat.ts";

// Deliberately malformed/extra SDK fields exercise the presentation allowlist.
const view = (entries: unknown[], live: unknown = {}): ConversationView =>
  ({
    conversation: { id: 1 },
    entries,
    docs: { "pi.live": live },
  }) as unknown as ConversationView;
const entry = (id: number, content: unknown, stopReason = "stop", kind = "pi.assistant") => ({
  id,
  kind,
  byTaskId: 9,
  model: [{ role: "assistant", content, stopReason }],
});

describe("validated ordered SDK presentation", () => {
  it("projects matched table and edit receipts independently without forwarding extra details", () => {
    const patch = "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-before\n+after\n";
    const table = { version: 1, table: { columns: [{ id: "x", label: "X" }], rows: [{ x: 1 }] } };
    const call = entry(
      1,
      [
        { type: "toolCall", id: "table", name: "display_table", arguments: {} },
        { type: "toolCall", id: "edit", name: "edit", arguments: {} },
      ],
      "toolUse",
    );
    const result = (id: number, name: string, details: unknown) => ({
      id,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: name === "display_table" ? "table" : "edit",
          toolName: name,
          content: [{ type: "text", text: "ordinary" }],
          isError: false,
          details,
        },
      ],
    });
    const state = ChatStateSchema.parse(
      present(
        view([
          call,
          result(2, "display_table", table),
          result(3, "edit", { patch, diff: "diff", secret: "PRIVATE_EXTRA" }),
        ]),
      ),
    );
    const parts = state.messages.flatMap((message) => message.parts ?? []);
    expect(
      parts.find((part) => part.type === "tool-call" && part.name === "display_table"),
    ).toMatchObject({ table });
    expect(parts.find((part) => part.type === "tool-call" && part.name === "edit")).toMatchObject({
      editDiff: { kind: "patch", patch },
    });
    expect(JSON.stringify(state)).not.toContain("PRIVATE_EXTRA");
  });
  it("does not project malformed or foreign table details", () => {
    const call = entry(
      1,
      [{ type: "toolCall", id: "table", name: "display_table", arguments: {} }],
      "toolUse",
    );
    const result = {
      id: 2,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "table",
          toolName: "display_table",
          content: [{ type: "text", text: "Ordinary output" }],
          isError: false,
          details: { version: 1, table: { columns: [], rows: [], secret: "PRIVATE_EXTRA" } },
        },
      ],
    };
    const state = ChatStateSchema.parse(present(view([call, result])));
    expect(JSON.stringify(state)).toContain("Ordinary output");
    expect(JSON.stringify(state)).not.toContain("PRIVATE_EXTRA");
    expect(state.messages[0]?.parts?.[0]).not.toHaveProperty("table");
  });
  it("does not pair a tool result across an unresolved gap with a sparse upper bound", () => {
    const state = present(
      view([
        entry(
          1,
          [{ type: "toolCall", id: "old", name: "bash", arguments: { command: "pwd" } }],
          "toolUse",
        ),
        {
          id: 30,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "old",
              toolName: "bash",
              content: [{ type: "text", text: "Result" }],
              isError: false,
            },
          ],
        },
      ]),
      false,
      [{ after: 1, upTo: 20 }],
    );
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.parts?.[0]).toMatchObject({ state: "unavailable" });
    expect(state.messages[1]?.parts?.[0]).toMatchObject({
      state: "complete",
      argumentsUnavailable: true,
    });
  });

  it("omits empty reasoning and never treats signatures as display text", () => {
    const state = present(
      view([
        entry(1, [
          { type: "thinking", thinking: "", thinkingSignature: "PRIVATE_SIGNATURE" },
          { type: "text", text: "Answer" },
        ]),
      ]),
    );
    expect(state.messages[0]?.parts).toEqual([{ id: "1:0:1", type: "text", text: "Answer" }]);
    expect(state.messages[0]?.text).toBe("Answer");
    expect(JSON.stringify(state)).not.toContain("PRIVATE_SIGNATURE");
  });

  it("pairs reused call IDs in transcript order and retains orphan results without leaking details", () => {
    const call = (id: number) =>
      entry(
        id,
        [{ type: "toolCall", id: "reused", name: "bash", arguments: { command: "pwd" } }],
        "toolUse",
      );
    const result = (id: number, text: string, isError = false) => ({
      id,
      kind: "pi.tool-result",
      data: { diagnostics: [], details: "PRIVATE_DETAILS" },
      model: [
        {
          role: "toolResult",
          toolCallId: "reused",
          toolName: "bash",
          content: [{ type: "text", text }],
          isError,
        },
      ],
    });
    const state = ChatStateSchema.parse(
      present(
        view([
          result(1, "orphan"),
          call(2),
          result(3, "first"),
          call(4),
          result(5, "second", true),
        ]),
      ),
    );
    expect(state.messages.map((message) => message.id)).toEqual(["1:0", "2:0", "4:0"]);
    expect(
      state.messages
        .flatMap((message) => message.parts ?? [])
        .map((part) =>
          part.type === "tool-call" ? [part.state, part.output, part.resultEntryId] : null,
        ),
    ).toEqual([
      ["complete", "orphan", 1],
      ["complete", "first", 3],
      ["error", "second", 5],
    ]);
    expect(JSON.stringify(state)).not.toContain("PRIVATE_DETAILS");
  });

  it("overlays progress only for the current generation's unsettled calls", () => {
    const first = entry(
      1,
      [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }],
      "toolUse",
    );
    const live = {
      run: { taskId: 9 },
      tools: [{ callId: "call", name: "bash", status: "running", output: "streamed" }],
    };
    expect(present(view([first], live)).messages[0]?.parts?.[0]).toMatchObject({
      state: "running",
      output: "streamed",
    });
    expect(
      present(view([first], { ...live, run: { taskId: 10 } })).messages[0]?.parts?.[0],
    ).toMatchObject({ state: "unavailable" });
  });

  it("preserves text/omission boundaries and canonical source indexes without leaking payloads", () => {
    const result = ChatStateSchema.parse(
      present(
        view([
          entry(4, [
            { type: "text", text: "Before\n  indentation" },
            {
              type: "thinking",
              thinking: "Provider reasoning",
              thinkingSignature: "PRIVATE_SIGNATURE",
            },
            { type: "text", text: "After" },
            {
              type: "toolCall",
              id: "private-call",
              name: "bash",
              arguments: { command: "echo synthetic" },
            },
            { type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" },
            { type: "PRIVATE_CUSTOM_KIND", data: "PRIVATE_DATA" },
            { type: "text", text: 123 },
            null,
          ]),
        ]),
      ),
    );
    expect(result.messages[0]).toMatchObject({
      id: "4:0",
      source: { entryId: 4, taskId: 9 },
      outcome: "complete",
      interrupted: false,
      parts: [
        { id: "4:0:0", type: "text", text: "Before\n  indentation" },
        { id: "4:0:1", type: "reasoning", text: "Provider reasoning" },
        { id: "4:0:2", type: "text", text: "After" },
        {
          id: "4:0:3",
          type: "tool-call",
          name: "bash",
          arguments: { command: "echo synthetic" },
          state: "unavailable",
        },
        { id: "4:0:4", type: "omitted", kind: "image" },
        { id: "4:0:5", type: "omitted", kind: "other" },
        { id: "4:0:6", type: "omitted", kind: "other" },
        { id: "4:0:7", type: "omitted", kind: "other" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("keeps model-message order and adjacent assistant entries without rendering raw custom events", () => {
    const result = present(
      view([
        { id: 1, kind: "app.event", data: { text: "PRIVATE_EVENT" } },
        {
          id: 2,
          kind: "app.messages",
          byTaskId: 9,
          model: [
            { role: "system", content: "PRIVATE_SYSTEM" },
            { role: "user", content: "**Literal**\n  user" },
            { role: "toolResult", content: [{ type: "text", text: "PRIVATE_RESULT" }] },
            { role: "assistant", content: [{ type: "text", text: "First" }], stopReason: "stop" },
          ],
        },
        entry(3, [{ type: "text", text: "Second" }]),
      ]),
    );
    expect(result.messages.map((message) => [message.id, message.role, message.text])).toEqual([
      ["2:1", "user", "**Literal**\n  user"],
      ["2:3", "assistant", "First"],
      ["3:0", "assistant", "Second"],
    ]);
    expect(result.messages[1]?.source).toEqual({ entryId: 2 });
    expect(result.window?.entryIds).toEqual([1, 2, 3]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("distinguishes cancellation, error, length and unknown outcomes", () => {
    const result = present(
      view(
        ["aborted", "error", "length", "stop", "PRIVATE_REASON"].map((reason, index) =>
          entry(index + 1, [{ type: "text", text: `Message ${index}` }], reason),
        ),
        { runFailure: { reason: "PRIVATE_FAILURE", detail: "PRIVATE_DIAGNOSTIC" } },
      ),
    );
    expect(result.messages.map((message) => message.outcome)).toEqual([
      "interrupted",
      "error",
      "length",
      "complete",
      "incomplete",
    ]);
    expect(result.messages.map((message) => message.interrupted)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(result.failure).toContain("(unknown)");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("projects live task/attempt and window boundary, not provider identity or retry diagnostics", () => {
    const result = ChatStateSchema.parse(
      present(
        view([{ id: 3, kind: "pi.user", model: [{ role: "user", content: "Request" }] }], {
          run: { taskId: 9, inputs: [4] },
          generation: {
            attempt: 2,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Partial" },
                {
                  type: "thinking",
                  thinking: "Provider reasoning",
                  thinkingSignature: "PRIVATE_SIGNATURE",
                },
              ],
              provider: "PRIVATE_PROVIDER",
            },
            retry: { error: "PRIVATE_RETRY" },
          },
        }),
      ),
    );
    expect(result.live).toMatchObject({
      id: "generation:1:9:2",
      taskId: 9,
      afterEntryId: 3,
      text: "Partial",
      parts: [
        { id: "generation:1:9:2:0", type: "text", text: "Partial" },
        { id: "generation:1:9:2:1", type: "reasoning", text: "Provider reasoning" },
      ],
    });
    expect(result.partial).toBe("Partial");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("does not turn a busy run without a partial into a live assistant message", () => {
    const result = present(view([], { run: { taskId: 9 }, generation: { attempt: 1 } }));
    expect(result).toMatchObject({ busy: true, live: null, partial: "", messages: [] });
  });

  it("rejects unknown wire parts and duplicate identities rather than interpreting them as UI", () => {
    const snapshot = present(view([entry(1, [{ type: "text", text: "Actual" }])]));
    const message = snapshot.messages[0]!;
    expect(ChatStateSchema.safeParse({ ...snapshot, messages: [message, message] }).success).toBe(
      false,
    );
    expect(
      ChatStateSchema.safeParse({
        ...snapshot,
        messages: [
          { ...message, parts: [{ id: "x", type: "execute-code", code: "PRIVATE_CODE" }] },
        ],
      }).success,
    ).toBe(false);
    const part = message.parts![0]!;
    expect(
      ChatStateSchema.safeParse({ ...snapshot, messages: [{ ...message, parts: [part, part] }] })
        .success,
    ).toBe(false);
  });
});
