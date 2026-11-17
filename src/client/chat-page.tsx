import { Chat } from "./chat.tsx";
import { useChat } from "./use-chat.ts";
import { MODEL_ID } from "../shared/chat.ts";

export function ChatPage() {
  const chat = useChat();
  return (
    <main className="h-dvh">
      <Chat
        title="CPD Durable"
        description={`OpenCode Go · ${MODEL_ID}`}
        state={chat.state}
        connected={chat.connected}
        pending={chat.pending}
        error={chat.error}
        retryText={chat.retryText}
        retryAction={chat.retryAction}
        uncertain={chat.uncertain}
        notice={chat.notice}
        onRetry={chat.retryRequest}
        onSend={chat.send}
        onStop={chat.stop}
        onContinue={chat.continueRun}
        onReset={chat.reset}
        onWithdraw={chat.withdraw}
      />
    </main>
  );
}
