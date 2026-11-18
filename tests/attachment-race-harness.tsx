import { createRoot } from "react-dom/client";
import type { AttachmentAdapter } from "@assistant-ui/react";
import { Chat } from "../src/client/chat.tsx";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
let next = 0;
let unblock!: () => void;
const gate = new Promise<void>((resolve) => {
  unblock = resolve;
});
const adapter: AttachmentAdapter = {
  accept: "image/png",
  async add({ file }) {
    return {
      id: ids[next++]!,
      type: "image",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async remove() {},
  async send(attachment) {
    await gate;
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "image", image: `/api/chats/1/attachments/${attachment.id}` }],
    };
  },
};
const node = document.createElement("div");
node.id = "controlled-native-composer";
document.body.append(node);
const root = createRoot(node);
root.render(
  <Chat
    title="Race fixture"
    chatId="1"
    connected
    state={{
      conversationId: 1,
      messages: [],
      partial: "",
      busy: false,
      hasEarlier: false,
      failure: null,
    }}
    attachmentAdapter={adapter}
    onSend={async (_text, _mode, images) => {
      Reflect.set(window, "__raceSent", images);
      return false;
    }}
  />,
);
Reflect.set(window, "__releaseAttachmentSend", unblock);
