import { useAuiState } from "@assistant-ui/react";
import { MessageSquareTextIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useChatHost } from "./chat-host.ts";

/**
 * Reply affordance on a saved message. Opening resolves an existing thread or
 * an unsent panel; it never forks, admits input or adds a sidebar chat.
 */
export function ReplyInThreadAction() {
  const host = useChatHost();
  const entryId = useAuiState((state) => state.message.metadata.custom["sourceEntryId"]);
  if (
    !host.onReplyInThread ||
    host.readOnly ||
    typeof entryId !== "number" ||
    !Number.isSafeInteger(entryId) ||
    entryId <= 0
  )
    return null;
  const threads = (host.threads ?? []).filter((thread) => thread.sourceEntryId === String(entryId));
  const replies = threads.reduce((total, thread) => total + thread.replyCount, 0);
  const label =
    threads.length === 0
      ? "Reply in thread"
      : `Open thread · ${replies} ${replies === 1 ? "reply" : "replies"}`;
  return (
    <TooltipIconButton
      tooltip={label}
      aria-label={label}
      className={threads.length ? "relative outline-1 outline-foreground/25" : "relative"}
      onClick={() => host.onReplyInThread?.(entryId)}
    >
      <MessageSquareTextIcon />
      {threads.length > 0 && (
        <span
          aria-hidden="true"
          className="bg-foreground text-background absolute -top-1 -right-1 rounded-full px-1 text-[10px] leading-3 tabular-nums"
        >
          {replies > 99 ? "99+" : replies}
        </span>
      )}
    </TooltipIconButton>
  );
}
