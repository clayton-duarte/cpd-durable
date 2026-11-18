import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { RefreshCwIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useChatHost } from "./chat-host.ts";

export function RegenerateMessageAction() {
  const host = useChatHost();
  const entryId = useAuiState((state) => state.message.metadata.custom["sourceEntryId"]);
  const [eligible, setEligible] = useState(false);
  useEffect(() => {
    setEligible(false);
    if (
      !host.onRegenerate ||
      !host.chatId ||
      host.readOnly ||
      typeof entryId !== "number" ||
      !Number.isSafeInteger(entryId) ||
      entryId < 1
    )
      return;
    const controller = new AbortController();
    void fetch(`/api/chats/${host.chatId}/regeneration-eligibility/${entryId}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        const data: unknown = await response.json();
        if (
          !controller.signal.aborted &&
          data !== null &&
          typeof data === "object" &&
          Reflect.get(data, "eligible") === true
        )
          setEligible(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [host.onRegenerate, host.chatId, host.readOnly, entryId]);
  if (
    !eligible ||
    !host.onRegenerate ||
    !host.connected ||
    host.readOnly ||
    typeof entryId !== "number"
  )
    return null;
  return (
    <TooltipIconButton
      tooltip="Regenerate in new chat"
      onClick={() => host.onRegenerate?.(entryId)}
    >
      <RefreshCwIcon />
    </TooltipIconButton>
  );
}
