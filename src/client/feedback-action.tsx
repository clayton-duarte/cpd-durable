import { useEffect, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FeedbackViewSchema, type FeedbackView } from "../shared/feedback.ts";
import { useChatHost } from "./chat-host.ts";

type Attempt = {
  requestId: string;
  expectedRevision: number;
  value: { vote: "helpful" | "unhelpful"; comment: string | null } | null;
};

/** Composes supplied action buttons and the existing Dialog; no optimistic vote. */
export function FeedbackAction() {
  const host = useChatHost();
  const entryId = useAuiState((state) => state.message.metadata.custom["sourceEntryId"]);
  const modelIndex = useAuiState((state) => state.message.metadata.custom["feedbackModelIndex"]);
  if (
    !host.chatId ||
    typeof entryId !== "number" ||
    !Number.isSafeInteger(entryId) ||
    entryId <= 0 ||
    typeof modelIndex !== "number" ||
    !Number.isSafeInteger(modelIndex) ||
    modelIndex < 0
  )
    return null;
  return (
    <FeedbackControl
      key={`${host.chatId}:${entryId}:${modelIndex}`}
      chatId={host.chatId}
      entryId={entryId}
      modelIndex={modelIndex}
      active={host.active !== false}
      writable={
        host.active !== false &&
        host.connected &&
        !host.readOnly &&
        String(host.state?.conversationId) === host.chatId
      }
    />
  );
}

function FeedbackControl({
  chatId,
  entryId,
  modelIndex,
  active: isActive,
  writable,
}: {
  chatId: string;
  entryId: number;
  modelIndex: number;
  active: boolean;
  writable: boolean;
}) {
  const [view, setView] = useState<FeedbackView>();
  const [open, setOpen] = useState(false);
  const [vote, setVote] = useState<"helpful" | "unhelpful">("helpful");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>();
  const [draftTouched, setDraftTouched] = useState(false);
  const generation = useRef(0);
  const canWrite = useRef(writable);
  canWrite.current = writable;
  const url = `/api/chats/${chatId}/feedback/${entryId}/${modelIndex}`;

  async function refresh() {
    const current = ++generation.current;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error();
      const next = FeedbackViewSchema.parse(await response.json());
      if (
        next.conversationId !== chatId ||
        next.target.entryId !== entryId ||
        next.target.modelIndex !== modelIndex
      )
        throw new Error("Mismatched feedback target");
      if (generation.current === current) {
        setView(next);
        setError(undefined);
        setConflict(false);
      }
    } catch {
      if (generation.current === current) setError("Feedback unavailable. Refresh before saving.");
    }
  }
  useEffect(() => {
    setBusy(false);
    if (isActive && !attempt && !conflict) void refresh();
    return () => {
      generation.current++;
    };
    // A chat instance is retained; a target change must never reuse a previous read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, isActive]);

  async function send(payload: Attempt) {
    if (busy || !canWrite.current || view?.readOnly) return;
    const current = ++generation.current;
    setAttempt(payload);
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 409) {
        if (generation.current === current && canWrite.current) {
          setAttempt(undefined);
          setConflict(true);
          setError("Feedback changed or is read-only. Refresh before trying again.");
        }
        return;
      }
      if (!response.ok) throw new Error();
      const next = FeedbackViewSchema.parse(await response.json());
      if (
        next.conversationId !== chatId ||
        next.target.entryId !== entryId ||
        next.target.modelIndex !== modelIndex
      )
        throw new Error("Mismatched feedback target");
      if (generation.current === current && canWrite.current) {
        setView(next);
        setAttempt(undefined);
        setError(undefined);
      }
    } catch {
      if (generation.current === current)
        setError("Save unconfirmed. Retry the same request before starting another save.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  const choose = (selected: "helpful" | "unhelpful") => {
    setVote(selected);
    if (!draftTouched && !attempt) setComment(view?.value?.comment ?? "");
    setOpen(true);
  };
  const submit = (value: Attempt["value"]) => {
    if (!view || conflict || attempt || busy || !canWrite.current || view.readOnly) return;
    void send({ requestId: crypto.randomUUID(), expectedRevision: view.revision, value });
  };
  return (
    <>
      <TooltipIconButton
        tooltip="Helpful"
        disabled={!writable || !!view?.readOnly}
        aria-pressed={view?.value?.vote === "helpful"}
        onClick={() => choose("helpful")}
      >
        <ThumbsUpIcon />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Not helpful"
        disabled={!writable || !!view?.readOnly}
        aria-pressed={view?.value?.vote === "unhelpful"}
        onClick={() => choose("unhelpful")}
      >
        <ThumbsDownIcon />
      </TooltipIconButton>
      <Dialog open={open && isActive} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Private response feedback</DialogTitle>
            <DialogDescription>
              Private feedback, stored with this chat—not sent to provider. Clearing feedback does
              not promise physical erasure of retained SDK records.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">Selected: {vote === "helpful" ? "Helpful" : "Not helpful"}</p>
          <label htmlFor={`feedback-${chatId}-${entryId}-${modelIndex}`}>Optional comment</label>
          <Textarea
            id={`feedback-${chatId}-${entryId}-${modelIndex}`}
            maxLength={4000}
            value={comment}
            onChange={(event) => {
              setDraftTouched(true);
              setComment(event.target.value);
            }}
          />
          {error && <p role="alert">{error}</p>}
          {view && !error && (
            <p role="status">
              {view.value ? `Saved revision ${view.revision}.` : "No current feedback."}
            </p>
          )}
          <DialogFooter>
            {(conflict || !view) && (
              <Button
                variant="outline"
                onClick={() => {
                  void refresh();
                }}
              >
                Refresh feedback
              </Button>
            )}
            {attempt && (
              <Button
                variant="outline"
                disabled={busy || !writable || !!view?.readOnly}
                onClick={() => {
                  void send(attempt);
                }}
              >
                Retry same save
              </Button>
            )}
            {view?.value && (
              <Button
                variant="outline"
                disabled={busy || !!attempt || conflict || !writable || view.readOnly}
                onClick={() => submit(null)}
              >
                Clear feedback
              </Button>
            )}
            <Button
              disabled={!view || busy || !!attempt || conflict || !writable || !!view?.readOnly}
              onClick={() => submit({ vote, comment: comment || null })}
            >
              Save feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
