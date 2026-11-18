import { useEffect, useRef, useState } from "react";
import { unstable_useSlashCommandAdapter, type Unstable_SlashCommand } from "@assistant-ui/react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { MessageQueue } from "@/components/assistant-ui/elements/message-queue";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { useChatHost } from "./chat-host.ts";

// Host bindings only: the supplied elements own all visual presentation.
export function DurableControls() {
  const host = useChatHost();
  const [resetOpen, setResetOpen] = useState(false);
  useEffect(() => {
    if (host.active === false) setResetOpen(false);
  }, [host.active]);
  const [handoff, setHandoff] = useState("");
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resetInFlight = useRef(false);
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
      : null;

  const commands: Unstable_SlashCommand[] = [];
  if (!locked && !resetOpen) {
    if (host.canRequestTangent && !busy) {
      for (const id of ["tangent", "side"]) {
        commands.push({
          id,
          description: "Request tangent: ask the main agent to prepare a handoff",
          execute: () => {
            void host.requestTangent();
          },
        });
      }
    }
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
          composerInputRef.current =
            document.activeElement
              ?.closest(".aui-thread-root")
              ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]') ?? null;
          setResetOpen(true);
        },
      });
  }
  const slash = unstable_useSlashCommandAdapter({ commands, removeOnExecute: true });

  async function retry() {
    if (!host.connected || host.pending || !host.onRetry) return;
    await host.onRetry();
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
      {status && <AgentStatus state="waiting" label={status} role="status" title={host.title} />}
      {host.state?.hasEarlier && !host.onLoadEarlier && (
        <AgentStatus
          state="waiting"
          label="Recent history only"
          title="Earlier history remains in session storage."
          role="note"
        />
      )}
      {host.historyError && host.onLoadEarlier && host.historyGap === undefined && (
        <ErrorState
          title="History unavailable"
          detail={host.historyError}
          retrying={host.historyLoading ?? false}
          pendingLabel="Loading history"
          disabled={!host.connected}
          onRetry={() => {
            void (host.onRetryHistory ?? host.onLoadEarlier)?.();
          }}
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
      <AlertDialog open={resetOpen && host.active !== false} onOpenChange={setResetOpen}>
        <AlertDialogContent
          initialFocus={cancelRef}
          finalFocus={composerInputRef}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset model context?</AlertDialogTitle>
            <AlertDialogDescription>
              Stored history is retained. Handoff becomes a user message; reset alone requests no
              answer.
              {busy && " While busy, reset waits for a boundary; Stop does not cancel it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Handoff instructions (optional)"
            placeholder="Handoff instructions (optional)"
            rows={3}
            className="max-h-40"
            maxLength={32_000}
            value={handoff}
            disabled={host.pending ?? false}
            onChange={(event) => setHandoff(event.currentTarget.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} type="button">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={locked || host.state?.controls?.resetPending}
              onClick={() => {
                if (
                  locked ||
                  host.state?.controls?.resetPending ||
                  resetInFlight.current ||
                  !host.onReset
                )
                  return;
                resetInFlight.current = true;
                const submittedHandoff = handoff;
                setResetOpen(false);
                host.clearLocalError();
                void host
                  .onReset(submittedHandoff.trim())
                  .then((admitted) => {
                    if (admitted)
                      setHandoff((current) => (current === submittedHandoff ? "" : current));
                  })
                  .finally(() => {
                    resetInFlight.current = false;
                  });
              }}
            >
              Reset context
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
