import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";
import { projectAssistantMessages } from "../src/client/assistant-messages.ts";
import { present } from "../src/server/presentation.ts";
import { ChatStateSchema } from "../src/shared/chat.ts";

const assistant = {
  id: 1,
  kind: "pi.assistant",
  byTaskId: 9,
  model: [
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "parent", name: "codemode", arguments: { code: "test" } }],
    },
  ],
};
const view = (entries: unknown[], live: unknown = {}) =>
  ({ conversation: { id: 1 }, entries, docs: { "pi.live": live } }) as unknown as ConversationView;
const slot = {
  taskId: 12,
  parentTaskId: 10,
  parentCallId: "parent",
  callId: "parent/c1",
  name: "read",
  status: "running",
  arguments: { secret: "SECRET_ARGUMENT" },
  output: "SECRET_OUTPUT",
};

describe("code-mode nested presentation", () => {
  it("projects only calls attached to the current actual parent task", () => {
    const state = ChatStateSchema.parse(
      present(
        view([assistant], {
          run: { taskId: 9 },
          tools: [{ taskId: 10, callId: "parent", name: "codemode", status: "running" }],
          nestedTools: [slot, { ...slot, taskId: 13, parentTaskId: 20, callId: "wrong" }],
        }),
      ),
    );
    const part = state.messages[0]?.parts?.[0];
    expect(part).toMatchObject({
      nested: { state: "live", calls: [{ callId: "parent/c1", name: "read", state: "running" }] },
    });
    expect(JSON.stringify(state)).not.toContain("SECRET_");
    expect(JSON.stringify(state)).not.toContain("wrong");
    const projected = projectAssistantMessages(state);
    expect(JSON.stringify(projected.messages)).toContain("parent/c1");
  });

  it("retains only real receipt calls and removes spill paths and raw errors", () => {
    const result = {
      id: 2,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "parent",
          toolName: "codemode",
          isError: false,
          content: [
            {
              type: "text",
              text: "truncated [Full output: /private/testfile (read with offset/limit)]",
            },
          ],
          details: {
            fullOutputPath: "/private/testfile",
            calls: [
              { id: 1, name: "read", status: "error", error: "SECRET_ERROR", args: "SECRET_ARGS" },
            ],
          },
        },
      ],
    };
    const state = ChatStateSchema.parse(present(view([assistant, result])));
    expect(state.messages[0]?.parts?.[0]).toMatchObject({
      nested: {
        state: "available",
        outputSpilled: true,
        calls: [{ callId: "parent/c1", state: "error" }],
      },
    });
    expect(JSON.stringify(state)).not.toContain("/private/testfile");
    expect(JSON.stringify(state)).not.toContain("SECRET_");
    const missing = structuredClone(result);
    delete (missing.model[0] as { details?: unknown }).details;
    expect(present(view([assistant, missing])).messages[0]?.parts?.[0]).toMatchObject({
      nested: { state: "unavailable", calls: [] },
    });
  });
});
