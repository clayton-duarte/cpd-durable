import { useEffect, useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { EllipsisIcon, XIcon } from "lucide-react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import {
  CommandPalette,
  type PaletteCommand,
} from "@/components/assistant-ui/elements/command-palette";
import {
  Composer,
  ComposerMenu,
  ComposerToolbar,
} from "@/components/assistant-ui/elements/composer";
import { ElicitationForm } from "@/components/assistant-ui/elements/elicitation-form";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { useChatHost } from "./chat.tsx";

// Only official assistant-ui elements. No local markup, style tokens or UI primitives.
export function DurableControls() {
  const host = useChatHost();
  const aui = useAui();
  const [panel, setPanel] = useState<"actions" | "reset" | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [handoff, setHandoff] = useState("");
  const [confirm, setConfirm] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const busy = host.state?.busy ?? false;
  const queue = host.state?.controls?.queue ?? [];
  const locked = !host.available;
  const error = host.localError ?? host.error ?? host.state?.failure;
  const status = !host.onSend
    ? "Read-only"
    : !host.connected
      ? host.state
        ? "Reconnecting…"
        : "Connecting…"
      : host.pending
        ? "Awaiting acknowledgement…"
        : busy
          ? `Responding…${queue.length ? ` · ${queue.length} queued` : ""}`
          : host.state?.hasEarlier
            ? "Ready · Recent history"
            : "Ready";

  useEffect(() => {
    if (panel) panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [panel]);
  function close() {
    setPanel(null);
    triggerRef.current?.focus();
  }
  const commands: PaletteCommand[] = [];
  function command(id: string, label: string, group: string) {
    commands.push({ id, label, group, keys: [] });
  }
  if (!locked) {
    if (busy) {
      command("followUp", "Queue current draft after this response", "Draft");
      command("steer", "Steer current work with this draft at a boundary", "Draft");
    }
    if (host.onContinue && host.state?.controls?.canContinue && !busy)
      command("continue", "Continue response without adding a message", "Conversation");
    if (host.onReset && host.state?.controls && !host.state.controls.resetPending)
      command("reset", "Reset model context…", "Conversation");
    for (const item of queue)
      if (host.onWithdraw)
        command(
          `withdraw:${item.id}`,
          `Withdraw ${item.mode === "steer" ? "steering request" : "follow-up"}: ${item.text}`,
          "Queued inputs",
        );
  }
  command("close", "Close conversation actions", "Navigation");

  async function run(id: string) {
    if (id === "close") {
      close();
      return;
    }
    if (locked) return;
    host.clearLocalError();
    if (id === "reset") {
      setConfirm("");
      setPanel("reset");
      return;
    }
    if (id === "followUp" || id === "steer") await host.submitDraft(id);
    else if (id === "continue") await host.onContinue?.();
    else if (id.startsWith("withdraw:")) {
      const item = queue.find((item) => `withdraw:${item.id}` === id);
      if (item) await host.onWithdraw?.(item.id);
    }
    close();
  }

  async function retry() {
    if (!host.connected || host.pending || !host.onRetry) return;
    const draft = aui.composer.getState().text;
    if (await host.onRetry()) {
      if (
        host.retryText != null &&
        aui.composer.getState().text === draft &&
        draft.trim() === host.retryText
      )
        aui.composer.setText("");
    }
  }

  return (
    <Composer>
      <ComposerToolbar>
        <AgentStatus
          state={
            !host.connected || !host.onSend
              ? "waiting"
              : busy || host.pending
                ? "working"
                : "waiting"
          }
          label={status}
          role="status"
          title={[
            host.title,
            host.description,
            host.state?.hasEarlier ? "Earlier history remains in session storage." : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        {host.onSend && (
          <TooltipIconButton
            ref={triggerRef}
            tooltip={`Conversation actions${queue.length ? ` · ${queue.length} queued` : ""}`}
            onClick={() => {
              setQuery("");
              setActive(commands[0]?.id ?? "close");
              setPanel((current) => (current ? null : "actions"));
            }}
            aria-expanded={panel !== null}
          >
            <EllipsisIcon />
          </TooltipIconButton>
        )}
      </ComposerToolbar>
      {host.state?.controls?.resetPending && (
        <AgentStatus
          state="waiting"
          label="Context reset pending"
          title="Stop does not withdraw a queued context reset."
        />
      )}
      {error && host.onRetry && (host.retryText != null || host.retryAction) && host.connected ? (
        <ErrorState
          title="Delivery not confirmed"
          detail={error}
          retrying={host.pending ?? false}
          onRetry={() => {
            void retry();
          }}
        />
      ) : error ? (
        <AgentStatus state="failed" label={error} title={error} role="alert" />
      ) : null}
      {host.notice && (
        <AgentStatus state="waiting" label={host.notice} title={host.notice} role="note" />
      )}
      {panel && (
        <ComposerMenu
          open
          role="dialog"
          aria-label={panel === "reset" ? "Reset model context" : "Conversation actions"}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          {panel === "actions" ? (
            <CommandPalette
              ref={panelRef}
              commands={commands}
              query={query}
              activeId={active}
              onQueryChange={(value) => {
                setQuery(value);
                setActive(
                  commands.find((entry) => entry.label.toLowerCase().includes(value.toLowerCase()))
                    ?.id ?? "",
                );
              }}
              onActiveChange={setActive}
              onRun={(id) => {
                void run(id);
              }}
            />
          ) : (
            <ElicitationForm
              ref={panelRef}
              server="Reset model context"
              message="Stored history is retained. If busy, reset waits for a boundary; Stop does not withdraw it. Queued inputs may run in the new context. Optional handoff becomes a user message; reset alone does not request an answer."
              fields={[
                {
                  name: "handoff",
                  label: "Handoff instructions (optional)",
                  kind: "text",
                  value: handoff,
                },
                {
                  name: "confirm",
                  label: "Confirm context reset",
                  kind: "choice",
                  required: true,
                  value: confirm,
                  options: ["Reset model context"],
                },
              ]}
              state="request"
              inert={locked}
              aria-busy={host.pending ?? false}
              onFieldChange={(name, value) => {
                if (name === "handoff") setHandoff(value.slice(0, 32_000));
                else if (name === "confirm") setConfirm(value);
              }}
              onDecline={close}
              onAccept={() => {
                if (locked || confirm !== "Reset model context" || !host.onReset) return;
                host.clearLocalError();
                void host.onReset(handoff.trim()).then((admitted) => {
                  if (admitted) setHandoff("");
                  close();
                });
              }}
            />
          )}
          <TooltipIconButton tooltip="Close conversation actions" onClick={close}>
            <XIcon />
          </TooltipIconButton>
        </ComposerMenu>
      )}
    </Composer>
  );
}
