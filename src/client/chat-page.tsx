import { Chat } from "./chat.tsx";
import { useChat } from "./use-chat.ts";
import { MODEL_ID } from "../shared/chat.ts";

export function ChatPage({ chatId, active = true }: { chatId?: string; active?: boolean }) {
  const chat = useChat(chatId, active);
  return (
    <main className="h-full min-h-0">
      <Chat
        active={active}
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
        historyLoading={chat.historyLoading}
        historyError={chat.historyError}
        historyGap={chat.historyGap}
        onRetryHistory={chat.retryHistory}
        {...(chat.state?.history
          ? { onLoadEarlier: chat.loadEarlier, onFillGap: chat.fillGap }
          : {})}
      />
    </main>
  );
}
