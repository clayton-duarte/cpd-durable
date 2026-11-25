import { Chat } from "./chat.tsx";
import type { ThreadView } from "../shared/threads.ts";
import { useChat } from "./use-chat.ts";

export function ChatPage({
  chatId,
  active = true,
  readOnly = false,
  settingsTarget,
  settingsIncludeDefaults,
  mutationAllowed,
  canRequestTangent = false,
  inputBlockedReason,
  visibleFromEntryId,
  initialQuote,
  threads,
  highlightsEntryId,
  onReplyInThread,
  onFork,
  onRegenerate,
  onEdit,
  draftGuards,
  onUnsavedDraft,
}: {
  chatId?: string;
  active?: boolean;
  readOnly?: boolean;
  settingsTarget?: HTMLElement | null | undefined;
  settingsIncludeDefaults?: boolean | undefined;
  mutationAllowed?: (() => boolean) | undefined;
  canRequestTangent?: boolean;
  inputBlockedReason?: string | undefined;
  visibleFromEntryId?: number | undefined;
  initialQuote?: { text: string; messageId: string } | undefined;
  threads?: readonly ThreadView[] | null | undefined;
  highlightsEntryId?: string | undefined;
  onReplyInThread?: ((entryId: number, quote?: string) => void) | undefined;
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
        settingsTarget={settingsTarget}
        settingsIncludeDefaults={settingsIncludeDefaults}
        mutationAllowed={mutationAllowed}
        canRequestTangent={canRequestTangent}
        inputBlockedReason={inputBlockedReason}
        {...(visibleFromEntryId === undefined ? {} : { visibleFromEntryId })}
        {...(initialQuote === undefined ? {} : { initialQuote })}
        {...(threads === undefined ? {} : { threads })}
        {...(highlightsEntryId === undefined ? {} : { highlightsEntryId })}
        {...(onReplyInThread === undefined ? {} : { onReplyInThread })}
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
