import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../src/client/chat.tsx";

function Fixture() {
  const [state, setState] = useState({ chatId: "1", readOnly: false, connected: true });
  Reflect.set(window, "__setTemplateFixture", setState);
  return (
    <Chat
      title="Template fixture"
      chatId={state.chatId}
      readOnly={state.readOnly}
      connected={state.connected}
      state={{
        conversationId: Number(state.chatId),
        messages: [],
        partial: "",
        busy: false,
        hasEarlier: false,
        failure: null,
        controls: { canContinue: false, resetPending: false, queue: [] },
      }}
      onSend={async () => {
        Reflect.set(window, "__templateSent", true);
        return true;
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
