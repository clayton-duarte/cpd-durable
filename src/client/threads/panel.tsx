import { useEffect, useMemo, useRef, useState } from "react";
import {
  CreateThreadResponseSchema,
  ThreadSourceResponseSchema,
  ThreadSourceSchema,
  type ThreadSource,
  type ThreadView,
} from "../../shared/threads.ts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { UnsentQuotePreview } from "@/components/assistant-ui/elements/quote.aui";
import { ArrowUpIcon, XIcon } from "lucide-react";
import { ChatPage } from "../chat-page.tsx";

const roleLabel = (role: ThreadSource["role"]) =>
  role === "user" ? "Your message" : role === "assistant" ? "Assistant message" : "Saved message";

const activityLabel = (activity: ThreadView["activity"]) =>
  activity === "running"
    ? "Replying…"
    : activity === "waiting"
      ? "Needs you"
      : activity === "interrupted"
        ? "Interrupted"
        : activity === "failed"
          ? "Failed"
          : null;

function SourceBlock({ source }: { source: ThreadSource }) {
  return (
    <div
      data-slot="thread-source"
      className="shrink-0 border-b px-4 pt-4 pb-3"
      aria-label={`Source ${roleLabel(source.role).toLowerCase()}`}
    >
      <div className="text-muted-foreground flex items-center gap-2 pb-1 text-xs">
        <span>{roleLabel(source.role)}</span>
        {source.truncated && <span>· preview truncated</span>}
      </div>
      <p className="max-h-40 overflow-y-auto text-sm leading-[1.6] whitespace-pre-wrap">
        {source.text || "This saved message has no text."}
      </p>
    </div>
  );
}

/**
 * Unsent panel state. It is not a thread yet: closing it leaves no persisted
 * thread, and the parent URL stays in place until the first reply is admitted.
 */
function ReplyComposer({
  parentId,
  entryId,
  quote,
  onDismissQuote,
  disabled,
  onCreated,
  onRecheck,
  closeButton,
}: {
  parentId: string;
  entryId: string;
  quote?: string | undefined;
  onDismissQuote: () => void;
  disabled: boolean;
  onCreated: (thread: ThreadView) => void;
  onRecheck: () => void;
  closeButton: React.RefObject<HTMLButtonElement | null>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const hasFocused = useRef(false);
  useEffect(() => {
    if (disabled || hasFocused.current || !input.current) return;
    // Source lookup can be asynchronous: do not steal focus after the user
    // has deliberately moved away from the initial panel controls.
    const active = document.activeElement;
    if (active !== document.body && active !== closeButton.current) return;
    hasFocused.current = true;
    input.current.focus({ preventScroll: true });
  }, [disabled, closeButton]);
  async function submit() {
    const content = text.trim();
    if (!content || sending || disabled) return;
    setSending(true);
    setError(null);
    request.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/chats/${parentId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.current,
          parentId,
          sourceEntryId: entryId,
          text: content,
          ...(quote === undefined ? {} : { quote }),
        }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const existing =
          body && typeof body === "object" && "existingThreadId" in body
            ? (body as { existingThreadId?: unknown }).existingThreadId
            : undefined;
        // A thread may already own this message. Re-read rather than fork again.
        onRecheck();
        throw new Error(
          typeof existing === "string"
            ? "This message already has a thread. Reopening it instead of creating another."
            : "Reply was not confirmed. Retry uses the same request identity.",
        );
      }
      const result = CreateThreadResponseSchema.parse(await response.json());
      if (result.thread.parentId !== parentId || result.thread.sourceEntryId !== entryId)
        throw new Error("Mismatched thread receipt.");
      request.current = null;
      setText("");
      onCreated(result.thread);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Reply was not confirmed. Retry uses the same request identity.",
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      data-slot="thread-reply-composer"
      className="border-foreground/10 bg-muted/30 focus-within:border-foreground/25 mx-4 mt-4 flex flex-col gap-2 rounded-lg border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {quote !== undefined && <UnsentQuotePreview text={quote} onDismiss={onDismissQuote} />}
      <Textarea
        ref={input}
        aria-label="Reply in thread"
        placeholder="Reply…"
        value={text}
        disabled={disabled || sending}
        className="max-h-40 min-h-9 resize-none border-0 bg-transparent text-[13px]/5 shadow-none focus-visible:ring-0 md:text-[13px]/5 dark:bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <Button
        type="submit"
        size="icon-sm"
        className="self-end rounded-full"
        aria-label={sending ? "Replying…" : "Reply"}
        disabled={disabled || sending || text.trim().length === 0}
      >
        <ArrowUpIcon />
      </Button>
      {error && (
        <p role="alert" className="text-muted-foreground basis-full text-xs">
          {error}
        </p>
      )}
    </form>
  );
}

export function ThreadPanel({
  parentId,
  entryId,
  thread,
  quote,
  onDismissQuote,
  threadMissing = false,
  readOnly,
  onClose,
  onCreated,
  onRecheck,
  onUnsavedDraft,
  draftGuards,
}: {
  parentId: string;
  entryId?: string | undefined;
  thread?: ThreadView | undefined;
  quote?: { entryId: string; text: string } | undefined;
  onDismissQuote: () => void;
  threadMissing?: boolean | undefined;
  readOnly: boolean;
  onClose: () => void;
  onCreated: (thread: ThreadView) => void;
  onRecheck: () => void;
  draftGuards?: React.RefObject<Map<string, () => Promise<boolean>>>;
  onUnsavedDraft?: (chatId: string) => void;
}) {
  const [fetched, setFetched] = useState<ThreadSource | null>(null);
  const [error, setError] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<HTMLDivElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const initialQuote = useMemo(
    () => (quote ? { text: quote.text, messageId: quote.entryId } : undefined),
    [quote],
  );
  const known = thread?.source;
  useEffect(() => {
    if (known || entryId === undefined) {
      setFetched(null);
      setError(false);
      return;
    }
    const controller = new AbortController();
    setFetched(null);
    setError(false);
    void fetch(`/api/chats/${parentId}/threads/source/${entryId}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        const result = ThreadSourceResponseSchema.parse(await response.json());
        if (!controller.signal.aborted) setFetched(ThreadSourceSchema.parse(result.source));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [parentId, entryId, known]);
  useEffect(() => {
    if (!thread || readOnly || threadMissing) close.current?.focus();
  }, [thread?.id, entryId, readOnly, threadMissing]);
  const source = known ?? fetched;
  if (threadMissing)
    return (
      <aside
        data-slot="message-thread-panel"
        aria-label="Message thread"
        className="bg-background fixed inset-0 z-30 flex h-full min-h-0 min-w-0 flex-col md:static md:z-auto"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Thread</h2>
          <TooltipIconButton
            ref={close}
            data-slot="thread-close"
            type="button"
            tooltip="Close thread"
            onClick={onClose}
          >
            <XIcon />
          </TooltipIconButton>
        </header>
        <p role="alert" className="text-muted-foreground p-3 text-sm">
          This thread is not available in this chat. It may have been deleted, or the link may
          belong to another conversation.
        </p>
      </aside>
    );
  const status = thread ? activityLabel(thread.activity) : null;
  return (
    <aside
      data-slot="message-thread-panel"
      data-thread-entry={entryId}
      aria-label="Message thread"
      className="bg-background fixed inset-0 z-30 flex h-full min-h-0 min-w-0 flex-col md:static md:z-auto"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Thread</h2>
        {thread && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {thread.replyCount}
            {thread.replyCountCapped ? "+" : ""} {thread.replyCount === 1 ? "reply" : "replies"}
            {status && ` · ${status}`}
          </span>
        )}
        {thread && <div ref={setSettingsTarget} className="shrink-0" />}
        <TooltipIconButton
          ref={close}
          data-slot="thread-close"
          type="button"
          tooltip="Close thread"
          onClick={onClose}
        >
          <XIcon />
        </TooltipIconButton>
      </header>
      {source ? (
        <SourceBlock source={source} />
      ) : (
        <div className="border-b px-4 pt-4 pb-3 text-sm" role={error ? "alert" : undefined}>
          <span className="text-muted-foreground">
            {error ? "Source message could not be read." : "Reading the saved message…"}
          </span>
        </div>
      )}
      {thread ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatPage
            chatId={thread.id}
            modelRole="tangent"
            focusComposer={1}
            active
            readOnly={readOnly}
            settingsTarget={settingsTarget}
            visibleFromEntryId={Number(thread.sourceEntryId)}
            initialQuote={initialQuote}
            {...(draftGuards ? { draftGuards } : {})}
            {...(onUnsavedDraft ? { onUnsavedDraft } : {})}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
          {readOnly || entryId === undefined ? (
            <p className="text-muted-foreground p-3 text-xs">
              {readOnly
                ? "This chat is read-only, so no new thread can start here."
                : "The saved message could not be read, so no reply can start a thread here."}
            </p>
          ) : (
            <ReplyComposer
              key={entryId}
              parentId={parentId}
              entryId={entryId}
              quote={quote?.text}
              onDismissQuote={onDismissQuote}
              disabled={readOnly || !source}
              onCreated={onCreated}
              onRecheck={onRecheck}
              closeButton={close}
            />
          )}
        </div>
      )}
    </aside>
  );
}
