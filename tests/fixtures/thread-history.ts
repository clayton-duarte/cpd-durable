import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "../../src/client/chat-page.tsx";

// Vite-only synthetic fixture. Parent entries <= 10 are model context, not replies.
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(createElement(ChatPage, { chatId: "1", visibleFromEntryId: 10 }));
