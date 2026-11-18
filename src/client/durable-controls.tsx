import { useEffect, useRef, useState } from "react";
import {
  useAui,
  unstable_useSlashCommandAdapter,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { ElicitationForm } from "@/components/assistant-ui/elements/elicitation-form";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { MessageQueue } from "@/components/assistant-ui/elements/message-queue";
import { useChatHost } from "./chat-host.ts";

// Host bindings only: the supplied elements own all visual presentation.
export function DurableControls() {
  const host = useChatHost();
  const aui = useAui();
  const [resetOpen, setResetOpen] = useState(false);
  const [handoff, setHandoff] = useState("");
  const [confirm, setConfirm] = useState("");
  const formRef = useRef<HTMLDivElement>(null);
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
          ? "Responding…"
          : null;

  useEffect(() => {
    if (resetOpen) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [resetOpen]);

  function closeReset() {
    const input = formRef.current
      ?.closest(".aui-thread-root")
      ?.querySelector<HTMLTextAreaElement>("textarea");
    setResetOpen(false);
    input?.focus();
  }

  const commands: Unstable_SlashCommand[] = [];
  if (!locked && !resetOpen) {
    if (busy) {
      commands.push(
        {
          id: "queue",
          description: "Send this draft after the current response",
          execute: () => {
            void host.submitDraft("followUp");
          },
        },
        {
          id: "steer",
          description: "Apply this draft at the next eligible boundary",
          execute: () => {
            void host.submitDraft("steer");
          },
        },
      );
    }
    if (host.onContinue && host.state?.controls?.canContinue && !busy)
      commands.push({
        id: "continue",
        description: "Request an answer from current context without sending the draft",
        execute: () => {
          void host.onContinue?.();
        },
      });
    if (host.onReset && host.state?.controls && !host.state.controls.resetPending)
      commands.push({
        id: "reset",
        description: "Confirm a fresh model context; stored history is retained",
        execute: () => {
          host.clearLocalError();
          setConfirm("");
          setResetOpen(true);
        },
      });
  }
  const slash = unstable_useSlashCommandAdapter({ commands, removeOnExecute: true });

  async function retry() {
    if (!host.connected || host.pending || !host.onRetry) return;
    const draft = aui.composer.getState().text;
    if (
      (await host.onRetry()) &&
      host.retryText != null &&
      aui.composer.getState().text === draft &&
      draft.trim() === host.retryText
    )
      aui.composer.setText("");
  }

  return (
    <>
      {host.onSend && (
        <ComposerTriggerPopover
          char="/"
          {...slash}
          aria-label="Conversation commands"
          emptyItemsLabel="No commands available for this state"
        />
      )}
      {status && (
        <AgentStatus
          state={busy || host.pending ? "working" : "waiting"}
          label={status}
          role="status"
          title={host.title}
        />
      )}
      {host.state?.hasEarlier && (
        <AgentStatus
          state="waiting"
          label="Recent history only"
          title="Earlier history remains in session storage."
          role="note"
        />
      )}
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
      {queue.length > 0 && (
        <MessageQueue
          queued={queue.map((item) => ({
            id: item.id,
            text: `${item.mode === "steer" ? "Steer at boundary" : "Follow-up"}: ${item.text}`,
          }))}
          queueDescription={
            busy
              ? "Steering: next boundary · Follow-up: next run"
              : "Pending placement; not yet delivered"
          }
          {...(!locked && host.onWithdraw
            ? {
                onCancel: (id: string) => {
                  void host.onWithdraw?.(id);
                },
              }
            : {})}
        />
      )}
      {resetOpen && (
        <ElicitationForm
          ref={formRef}
          role="dialog"
          aria-label="Reset model context"
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
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeReset();
            }
            // The supplied text field must not implicitly submit the parent composer.
            if (event.key === "Enter" && event.target instanceof HTMLInputElement)
              event.preventDefault();
          }}
          onFieldChange={(name, value) => {
            if (name === "handoff") setHandoff(value.slice(0, 32_000));
            else if (name === "confirm") setConfirm(value);
          }}
          onDecline={closeReset}
          onAccept={() => {
            if (
              locked ||
              host.state?.controls?.resetPending ||
              confirm !== "Reset model context" ||
              !host.onReset
            )
              return;
            host.clearLocalError();
            void host.onReset(handoff.trim()).then((admitted) => {
              if (admitted) setHandoff("");
              closeReset();
            });
          }}
        />
      )}
    </>
  );
}
