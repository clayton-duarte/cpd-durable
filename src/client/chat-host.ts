import { createContext, useContext } from "react";
import type { AttachmentAdapter } from "@assistant-ui/react";
import type { ChatState, SendMode, HistoryGap } from "../shared/chat.ts";
import type { DraftAdmission } from "../shared/drafts.ts";
import type { DirectShellStatusSchema } from "../shared/direct-shell.ts";
import type { z } from "zod";

export interface ChatProps {
  chatId?: string | undefined;
  draftGuards?: React.RefObject<Map<string, () => Promise<boolean>>>;
  onUnsavedDraft?: (chatId: string) => void;
  active?: boolean;
  readOnly?: boolean;
  mutationAllowed?: (() => boolean) | undefined;
  canRequestTangent?: boolean;
  inputBlockedReason?: string | undefined;
  onFork?: ((entryId: number) => void) | undefined;
  onRegenerate?: ((entryId: number) => void) | undefined;
  onEdit?: ((entryId: number, text: string) => void) | undefined;
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
  onSend?: (
    text: string,
    mode?: SendMode,
    images?: string[],
    prepared?: {
      requestId: string;
      draft: DraftAdmission;
      onClear?: (revision: number) => void;
    },
  ) => Promise<boolean>;
  onShell?: (command: string, includeInContext: boolean) => Promise<boolean>;
  shell?: z.infer<typeof DirectShellStatusSchema> | null;
  onShellStop?: () => Promise<void>;
  attachmentAdapter?: AttachmentAdapter;
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
  requestTangent: (command: "tangent" | "side") => Promise<boolean>;
};

export const ChatHostContext = createContext<ChatHost | null>(null);

export function useChatHost() {
  const host = useContext(ChatHostContext);
  if (!host) throw new Error("Missing durable chat host");
  return host;
}
