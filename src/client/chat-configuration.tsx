import { useEffect, useState } from "react";
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorContent,
} from "@/components/assistant-ui/elements/model-selector";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Button } from "@/components/ui/button";
import {
  ConfigurationSchema,
  type Configuration,
  type Selection,
} from "../shared/configuration.ts";
import { useChatHost } from "./chat-host.ts";

const key = (value: { provider: string; modelId: string }) =>
  JSON.stringify([value.provider, value.modelId]);
export function ChatConfiguration() {
  const host = useChatHost();
  const [data, setData] = useState<Configuration>();
  const [draft, setDraft] = useState<Selection>();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const base = host.chatId === undefined ? "/api" : `/api/chats/${host.chatId}`;
  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const response = await fetch(`${base}/configuration`);
        if (!response.ok) throw new Error();
        const next = ConfigurationSchema.parse(await response.json());
        if (host.chatId !== undefined && next.conversationId !== host.chatId) throw new Error();
        if (active) {
          setData(next);
          setDraft(next.selection);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }
    if (host.active !== false) void read();
    return () => {
      active = false;
    };
  }, [base, host.chatId, host.active, refresh]);
  async function save() {
    if (!data || !draft || pending || error || host.readOnly || host.mutationAllowed?.() === false)
      return;
    setPending(true);
    try {
      const response = await fetch(`${base}/configuration`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected: data.selection, selection: draft }),
      });
      if (!response.ok) throw new Error();
      const next = ConfigurationSchema.parse(await response.json());
      if (next.conversationId !== data.conversationId) throw new Error();
      setData(next);
      setDraft(next.selection);
      setNotice(
        "Saved for subsequent provider requests. A request already in flight retains its pinned model.",
      );
    } catch {
      setError(true);
      setNotice(
        "Save unconfirmed or conflicted. Refresh configuration before another choice; no automatic write retry.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="Model configuration" className="flex flex-col gap-3">
      <h3 className="font-medium">Model and thinking</h3>
      <p className="text-xs text-muted-foreground">
        Server-authenticated choices only. Saves persist for this chat and affect subsequent
        provider requests, not an already pinned request. Credentials never enter the picker.
      </p>
      {error && (
        <ErrorState
          title="Configuration unavailable or changed"
          detail="Refresh reads saved settings without sending a prompt."
          retrying={false}
          onRetry={() => setRefresh((value) => value + 1)}
        />
      )}
      {data && draft && (
        <>
          <AgentStatus
            trailing={null}
            state="waiting"
            label={`Saved: ${data.selection.provider}/${data.selection.modelId} · thinking ${data.selection.thinkingLevel}`}
          />
          {!host.readOnly && host.onSend && (
            <>
              <ModelSelectorRoot
                models={data.choices.map((choice) => ({
                  id: key(choice),
                  name: choice.name,
                  description: choice.provider,
                  efforts: choice.thinkingLevels.map((level) => ({ id: level, name: level })),
                  disabled: pending || error,
                }))}
                value={key(draft)}
                effort={draft.thinkingLevel}
                onValueChange={(value) => {
                  const choice = data.choices.find((choice) => key(choice) === value);
                  if (choice)
                    setDraft({
                      provider: choice.provider,
                      modelId: choice.modelId,
                      thinkingLevel: choice.thinkingLevels.includes(draft.thinkingLevel)
                        ? draft.thinkingLevel
                        : (choice.thinkingLevels[0] ?? "off"),
                    });
                }}
                onEffortChange={(level) => {
                  const choice = data.choices.find((choice) => key(choice) === key(draft));
                  const supported = choice?.thinkingLevels.find((value) => value === level);
                  if (supported && !pending && !error)
                    setDraft({ ...draft, thinkingLevel: supported });
                }}
              >
                <ModelSelectorTrigger
                  disabled={pending || error || !!host.shell || !data.choices.length}
                />
                <ModelSelectorContent searchable />
              </ModelSelectorRoot>
              <Button
                variant="outline"
                disabled={pending || error || !!host.shell || !data.choices.length}
                onClick={() => {
                  void save();
                }}
              >
                Save model settings
              </Button>
            </>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
    </section>
  );
}
