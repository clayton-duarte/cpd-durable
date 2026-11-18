import { Chat } from "./chat.tsx";
import { useChat } from "./use-chat.ts";

export function ChatPage({
  chatId,
  active = true,
  readOnly = false,
  mutationAllowed,
  canRequestTangent = false,
  inputBlockedReason,
  onFork,
  onRegenerate,
  onEdit,
  draftGuards,
  onUnsavedDraft,
}: {
  chatId?: string;
  active?: boolean;
  readOnly?: boolean;
  mutationAllowed?: (() => boolean) | undefined;
  canRequestTangent?: boolean;
  inputBlockedReason?: string | undefined;
  onFork?: ((entryId: number) => void) | undefined;
  onRegenerate?: ((entryId: number) => void) | undefined;
  onEdit?: ((entryId: number, text: string) => void) | undefined;
  draftGuards?: React.RefObject<Map<string, () => Promise<boolean>>>;
  onUnsavedDraft?: (chatId: string) => void;
}) {
  const chat = useChat(chatId, active);
  return (
    <main className="h-full min-h-0">
      <Chat
        chatId={chatId}
        active={active}
        readOnly={readOnly}
        mutationAllowed={mutationAllowed}
        canRequestTangent={canRequestTangent}
        inputBlockedReason={inputBlockedReason}
        onFork={onFork}
        onRegenerate={onRegenerate}
        onEdit={onEdit}
        {...(draftGuards ? { draftGuards } : {})}
        {...(onUnsavedDraft ? { onUnsavedDraft } : {})}
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
        shell={chat.shell}
        onRetry={async () => (mutationAllowed?.() === false ? false : chat.retryRequest())}
        {...(readOnly
          ? {}
          : {
              onSend: async (...args) =>
                mutationAllowed?.() === false ? false : chat.send(...args),
              onShell: async (...args) =>
                mutationAllowed?.() === false ? false : chat.sendShell(...args),
              onShellStop: async (...args) => {
                if (mutationAllowed?.() !== false) await chat.stopShell(...args);
              },
              onStop: async () => {
                if (mutationAllowed?.() !== false) await chat.stop();
              },
              onContinue: async () => (mutationAllowed?.() === false ? false : chat.continueRun()),
              onReset: async (...args) =>
                mutationAllowed?.() === false ? false : chat.reset(...args),
              onWithdraw: async (...args) => {
                if (mutationAllowed?.() !== false) await chat.withdraw(...args);
              },
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
