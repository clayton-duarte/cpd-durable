import { useEffect, useState } from "react";
import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { PencilIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useChatHost } from "./chat-host.ts";

export function EditMessageAction() {
  const host = useChatHost();
  const entryId = useAuiState((state) => state.message.metadata.custom["sourceEntryId"]);
  const [eligible, setEligible] = useState(false);
  useEffect(() => {
    setEligible(false);
    if (
      !host.onEdit ||
      !host.chatId ||
      host.readOnly ||
      typeof entryId !== "number" ||
      !Number.isSafeInteger(entryId) ||
      entryId < 1
    )
      return;
    const controller = new AbortController();
    void fetch(`/api/chats/${host.chatId}/edit-eligibility/${entryId}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result: unknown = await response.json();
        if (
          !controller.signal.aborted &&
          result !== null &&
          typeof result === "object" &&
          Reflect.get(result, "eligible") === true
        )
          setEligible(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [host.onEdit, host.chatId, host.readOnly, entryId]);
  if (!eligible || !host.onEdit || host.readOnly || !host.connected) return null;
  return (
    <ActionBarPrimitive.Edit
      render={<TooltipIconButton tooltip="Edit in new chat" className="aui-user-action-edit" />}
    >
      <PencilIcon />
    </ActionBarPrimitive.Edit>
  );
}
