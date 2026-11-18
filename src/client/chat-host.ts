import { createContext, useContext } from "react";
import type { ChatState, SendMode, HistoryGap } from "../shared/chat.ts";

export interface ChatProps {
  title: string;
  description?: string;
  state: ChatState | null;
  connected: boolean;
  pending?: boolean;
  error?: string | null;
  retryText?: string | null;
  retryAction?: boolean;
  onRetry?: () => Promise<boolean>;
  uncertain?: boolean;
  notice?: string | null;
  historyLoading?: boolean;
  historyError?: string | null;
  historyGap?: HistoryGap | undefined;
  onRetryHistory?: () => Promise<void>;
  onLoadEarlier?: () => Promise<void>;
  onFillGap?: (gap: HistoryGap) => Promise<void>;
  onSend?: (text: string, mode?: SendMode) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onContinue?: () => Promise<boolean>;
  onReset?: (handoff: string) => Promise<boolean>;
  onWithdraw?: (id: string) => Promise<void>;
}

type ChatHost = ChatProps & {
  available: boolean;
  localError: string | null;
  clearLocalError: () => void;
  submitDraft: (mode: SendMode) => Promise<boolean>;
};

export const ChatHostContext = createContext<ChatHost | null>(null);

export function useChatHost() {
  const host = useContext(ChatHostContext);
  if (!host) throw new Error("Missing durable chat host");
  return host;
}
