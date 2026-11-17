import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  MessagePrimitive,
  MessagePartPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useExternalMessageConverter,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { ArrowDownIcon, CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import type { ChatState } from "../shared/chat.ts";
import { ChatComposer, type ComposerActions } from "./chat-composer.tsx";
import { assistantMessages } from "./assistant-messages.ts";

const MarkdownText = lazy(() =>
  import("./components/assistant-ui/elements/markdown-text.tsx").then((module) => ({
    default: module.MarkdownText,
  })),
);
// Rendering Markdown must not trigger model-supplied remote image requests.
const markdownComponents = {
  img: ({ alt }: { alt?: string | undefined }) => <span>[Image: {alt || "not loaded"}]</span>,
};

export interface ChatProps extends ComposerActions {
  title: string;
  description?: ReactNode;
  state: ChatState | null;
  connected: boolean;
  pending?: boolean;
  error?: string | null;
  retryText?: string | null;
  retryAction?: boolean;
  onRetry?: () => Promise<boolean>;
  uncertain?: boolean;
  notice?: string | null;
}

const convertMessage = (message: ThreadMessageLike) => message;

// One runtime per mounted chat. The host still owns routes, sizing and transport.
export function Chat(props: ChatProps) {
  const projected = useMemo(() => assistantMessages(props.state), [props.state]);
  const messages = useExternalMessageConverter({
    messages: projected,
    callback: convertMessage,
    isRunning: props.state?.busy ?? false,
    joinStrategy: "none",
  });
  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (
        !props.onSend ||
        !props.connected ||
        props.pending ||
        props.uncertain ||
        props.retryText != null ||
        props.retryAction ||
        props.state?.busy ||
        props.state === null ||
        message.role !== "user" ||
        (message.attachments?.length ?? 0) > 0 ||
        message.content.some((part) => part.type !== "text")
      ) {
        throw new Error("This conversation cannot admit that message.");
      }
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      if (!(await props.onSend(text.trim(), "reject")))
        throw new Error("Message admission was not confirmed.");
    },
    [
      props.onSend,
      props.connected,
      props.pending,
      props.uncertain,
      props.retryText,
      props.retryAction,
      props.state,
    ],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: props.state?.busy ?? false,
    isLoading: props.state === null,
    isDisabled: !props.onSend,
    // The documented Root.onSubmit override keeps drafts until durable admission.
    // Gate eager native composer sends; direct thread appends still use validated admission.
    isSendDisabled: true,
    onNew,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <ChatThread {...props} />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function ChatThread({
  title,
  description,
  state,
  connected,
  pending = false,
  error = null,
  retryText = null,
  retryAction = false,
  onRetry,
  uncertain = false,
  notice = null,
  onSend,
  onStop,
  onContinue,
  onReset,
  onWithdraw,
}: ChatProps) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const busy = state?.busy ?? false;
  const empty =
    state !== null && state.messages.length === 0 && !state.partial && !busy && !state.hasEarlier;
  async function retrySubmission() {
    const draft = aui.composer.getState().text;
    if (await (onRetry ? onRetry() : onSend?.(retryText ?? ""))) {
      if (aui.composer.getState().text === draft && draft.trim() === retryText)
        aui.composer.setText("");
    }
  }
  return (
    <section
      aria-label={title}
      className="aui-root flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-sm font-medium">{title}</h1>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
        <div className="flex items-center gap-2">
          {!onSend && <Badge variant="outline">Read-only</Badge>}
          <div role="status" className="text-xs text-muted-foreground">
            {!connected
              ? state
                ? "Reconnecting…"
                : "Connecting…"
              : busy
                ? "Responding…"
                : "Ready"}
          </div>
        </div>
      </header>
      <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport
          data-slot="aui-thread-viewport"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <div
            className={cn(
              "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-6 sm:px-6",
              empty && "justify-center",
            )}
          >
            {state === null ? (
              <div
                aria-label="Loading conversation"
                aria-busy="true"
                className="flex flex-col gap-3"
              >
                <Skeleton className="ml-auto h-9 w-2/5" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : empty ? (
              <div className="flex flex-col gap-2 py-6">
                <h2 className="text-2xl font-medium tracking-tight">No messages yet</h2>
                <p className="text-sm text-muted-foreground">
                  {onSend ? "What would you like to work on?" : "This conversation is read-only."}
                </p>
              </div>
            ) : null}
            {state?.hasEarlier && (
              <p className="text-center text-xs text-muted-foreground">
                Showing recent messages. Earlier history remains in session storage.
              </p>
            )}
            <div aria-busy={busy} className="flex flex-col gap-8">
              <ThreadPrimitive.Messages>{() => <ChatMessage />}</ThreadPrimitive.Messages>
              {busy && !state?.partial && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  Waiting for response…
                </p>
              )}
            </div>
            <ThreadPrimitive.ViewportFooter
              className={cn(
                "relative flex flex-col gap-3 bg-background pb-4 pt-4",
                !empty && "sticky bottom-0 mt-auto",
              )}
            >
              <ThreadPrimitive.ScrollToBottom asChild>
                <TooltipIconButton
                  tooltip="Scroll to bottom"
                  variant="outline"
                  className="absolute -top-10 self-center rounded-full disabled:invisible"
                >
                  <ArrowDownIcon />
                </TooltipIconButton>
              </ThreadPrimitive.ScrollToBottom>
              {(error ?? state?.failure) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {error ?? state?.failure}
                    {retryText !== null && onSend && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!connected || pending}
                        onClick={() => {
                          void retrySubmission();
                        }}
                      >
                        Retry submission
                      </Button>
                    )}
                    {retryAction && onRetry && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!connected || pending}
                        onClick={() => {
                          void onRetry();
                        }}
                      >
                        Retry action
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert>
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}
              {pending && (
                <p
                  aria-live="polite"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Spinner aria-hidden="true" />
                  Awaiting acknowledgement…
                </p>
              )}
              {onSend && (
                <ChatComposer
                  state={state}
                  connected={connected}
                  pending={pending}
                  uncertain={uncertain || retryText !== null}
                  text={text}
                  setText={(next) =>
                    aui.composer.setText(
                      typeof next === "function" ? next(aui.composer.getState().text) : next,
                    )
                  }
                  onSend={onSend}
                  {...(onStop ? { onStop } : {})}
                  {...(onContinue ? { onContinue } : {})}
                  {...(onReset ? { onReset } : {})}
                  {...(onWithdraw ? { onWithdraw } : {})}
                />
              )}
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  );
}

function ChatMessage() {
  const role = useAuiState((s) => s.message.role);
  const interrupted = useAuiState((s) => s.message.metadata.custom["interrupted"] === true);
  return (
    <MessagePrimitive.Root
      data-slot="aui-message"
      data-role={role}
      className={cn("flex min-w-0 flex-col gap-2 text-sm", role === "user" && "items-end")}
    >
      <span className="sr-only">{role === "user" ? "You" : "Assistant"}</span>
      <div
        data-slot="aui-message-content"
        className={cn(
          "min-w-0 max-w-full leading-relaxed wrap-break-word",
          role === "user" && cn(paper, "max-w-[85%] rounded-2xl px-4 py-2"),
        )}
      >
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type !== "text") return <></>;
            if (role === "user")
              return <MessagePartPrimitive.Text className="whitespace-pre-wrap" />;
            return (
              <Suspense fallback={<MessagePartPrimitive.Text className="whitespace-pre-wrap" />}>
                <MarkdownText components={markdownComponents} />
              </Suspense>
            );
          }}
        </MessagePrimitive.Parts>
      </div>
      {interrupted && <Badge variant="outline">Response interrupted.</Badge>}
      {role === "assistant" && (
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="flex gap-1 text-muted-foreground"
        >
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton tooltip="Copy response">
              <AuiIf condition={(s) => s.message.isCopied}>
                <CheckIcon />
              </AuiIf>
              <AuiIf condition={(s) => !s.message.isCopied}>
                <CopyIcon />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.ExportMarkdown asChild>
            <TooltipIconButton tooltip="Export response as Markdown">
              <DownloadIcon />
            </TooltipIconButton>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
