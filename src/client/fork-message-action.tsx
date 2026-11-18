import { useAuiState } from "@assistant-ui/react";
import { GitForkIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useChatHost } from "./chat-host.ts";

export function ForkMessageAction() {
  const host = useChatHost();
  const entryId = useAuiState((state) => state.message.metadata.custom["sourceEntryId"]);
  if (
    !host.onFork ||
    host.readOnly ||
    typeof entryId !== "number" ||
    !Number.isSafeInteger(entryId) ||
    entryId <= 0
  )
    return null;
  return (
    <TooltipIconButton tooltip="Fork from saved entry" onClick={() => host.onFork?.(entryId)}>
      <GitForkIcon />
    </TooltipIconButton>
  );
}
