import type { ConversationView } from "@earendil-works/pi-durable";
import { expect, it } from "vite-plus/test";
import { present } from "../src/server/presentation.ts";
import { ChatStateSchema } from "../src/shared/chat.ts";
import { projectAssistantMessages } from "../src/client/assistant-messages.ts";

it("projects only canonical coordinates for ordered saved user and orphan tool images", () => {
  const image = { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" };
  const unsupported = { type: "image", mimeType: "image/gif", data: "PRIVATE_GIF_BYTES" };
  const view = {
    conversation: { id: 21 },
    docs: { "pi.live": {} },
    entries: [
      {
        id: 5,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              image,
              { type: "text", text: "after" },
              unsupported,
            ],
          },
        ],
      },
      {
        id: 6,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "x",
            toolName: "read",
            isError: false,
            content: [
              { type: "text", text: "first" },
              image,
              { type: "text", text: "last" },
              unsupported,
            ],
          },
        ],
      },
    ],
  } as unknown as ConversationView;
  const state = ChatStateSchema.parse(present(view));
  expect(state.messages[0]?.parts).toEqual([
    { id: "5:0:0", type: "text", text: "before" },
    { id: "5:0:1", type: "image", source: { entryId: 5, modelIndex: 0, partIndex: 1 } },
    { id: "5:0:2", type: "text", text: "after" },
    { id: "5:0:3", type: "omitted", kind: "image" },
  ]);
  const result = state.messages[1]?.parts?.[0];
  expect(result?.type).toBe("tool-call");
  if (result?.type !== "tool-call") throw new Error("missing orphan result");
  expect(result.resultParts).toEqual([
    { type: "text", text: "first" },
    { type: "image", source: { entryId: 6, modelIndex: 0, partIndex: 1 } },
    { type: "text", text: "last" },
    { type: "omitted" },
  ]);
  expect(JSON.stringify(state)).not.toContain("PRIVATE_IMAGE_BYTES");
  expect(JSON.stringify(state)).not.toContain("PRIVATE_GIF_BYTES");
  const rendered = projectAssistantMessages(state).messages[0]?.content;
  expect(rendered).toEqual([
    { type: "text", text: "before" },
    { type: "image", image: "/api/chats/21/images/5/0/1" },
    { type: "text", text: "after" },
    { type: "data-omitted", data: { kind: "image" } },
  ]);
});

it("does not assign saved coordinates to live images or attach a tool result to another call", () => {
  const image = { type: "image", mimeType: "image/jpeg", data: "PRIVATE_IMAGE_BYTES" };
  const view = {
    conversation: { id: 8 },
    docs: {
      "pi.live": {
        run: { taskId: 1 },
        generation: { attempt: 1, message: { role: "assistant", content: [image] } },
      },
    },
    entries: [
      {
        id: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }],
          },
        ],
      },
      {
        id: 2,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "a",
            toolName: "other",
            isError: false,
            content: [image],
          },
        ],
      },
    ],
  } as unknown as ConversationView;
  const state = ChatStateSchema.parse(present(view));
  expect(state.live?.parts).toEqual([{ id: "generation:8:1:1:0", type: "omitted", kind: "image" }]);
  expect(state.messages[0]?.parts?.[0]).toMatchObject({ type: "tool-call", state: "unavailable" });
  expect(state.messages[1]?.parts?.[0]).toMatchObject({
    type: "tool-call",
    argumentsUnavailable: true,
    resultParts: [{ type: "image", source: { entryId: 2, modelIndex: 0, partIndex: 0 } }],
  });
  expect(JSON.stringify(state)).not.toContain("PRIVATE_IMAGE_BYTES");
});
