import { Chat } from "./chat.tsx";
import { useChat } from "./use-chat.ts";

export function ChatPage({
  chatId,
  active = true,
  readOnly = false,
  onFork,
  onEdit,
}: {
  chatId?: string;
  active?: boolean;
  readOnly?: boolean;
  onFork?: ((entryId: number) => void) | undefined;
  onEdit?: ((entryId: number, text: string) => void) | undefined;
}) {
  const chat = useChat(chatId, active);
  return (
    <main className="h-full min-h-0">
      <Chat
        chatId={chatId}
        active={active}
        readOnly={readOnly}
        onFork={onFork}
        onEdit={onEdit}
        title="CPD Durable"
        description="Durable chat · model settings in Chat details"
        state={chat.state}
        connected={chat.connected}
        pending={chat.pending}
        error={chat.error}
        retryText={chat.retryText}
        retryAction={chat.retryAction}
        uncertain={chat.uncertain}
        notice={chat.notice}
        onRetry={chat.retryRequest}
        {...(readOnly
          ? {}
          : {
              onSend: chat.send,
              onStop: chat.stop,
              onContinue: chat.continueRun,
              onReset: chat.reset,
              onWithdraw: chat.withdraw,
            })}
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
