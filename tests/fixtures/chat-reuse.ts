import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../src/client/chat.tsx";
import type { ChatState } from "../../src/shared/chat.ts";

// Vite-only synthetic embedding fixture; not imported by the production app.
const state: ChatState = {
  messages: [],
  partial: "",
  busy: false,
  hasEarlier: false,
  failure: null,
  controls: { canContinue: false, resetPending: false, queue: [] },
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  createElement(
    "div",
    { className: "grid h-dvh grid-cols-2" },
    ...["First chat", "Second chat"].map((title) =>
      createElement(Chat, {
        key: title,
        title,
        state,
        connected: true,
        onSend: () => Promise.resolve(true),
      }),
    ),
  ),
);
