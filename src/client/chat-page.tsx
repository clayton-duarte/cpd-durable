import { Chat } from "./chat.tsx";
import { useChat } from "./use-chat.ts";
import { MODEL_ID } from "../shared/chat.ts";

export function ChatPage() {
  const { state, connected, pending, error, retryText, send, stop } = useChat();
  return (
    <main className="h-dvh">
      <Chat
        title="CPD Durable"
        description={`OpenCode Go · ${MODEL_ID}`}
        state={state}
        connected={connected}
        pending={pending}
        error={error}
        retryText={retryText}
        onSend={send}
        onStop={stop}
      />
    </main>
  );
}
