import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Message, MessageContent, MessageHeader, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { ChatState } from "../shared/chat.ts";
import { ChatComposer, type ComposerActions } from "./chat-composer.tsx";

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

// Instance-local presentation; the host owns transport, provider, routing and dimensions.
// Remount with a conversation key when changing the represented conversation.
export function Chat({
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
  const [text, setText] = useState("");
  const busy = state?.busy ?? false;

  async function submit(draft: string) {
    const currentDraft = text;
    if (await (onRetry ? onRetry() : onSend?.(draft.trim()))) {
      setText((current) =>
        current === currentDraft && current.trim() === draft.trim() ? "" : current,
      );
    }
  }

  return (
    <MessageScrollerProvider autoScroll>
      <section aria-label={title} className="flex h-full min-h-0 w-full flex-col gap-4">
        <div className="flex flex-col gap-1 p-8 pb-4">
          <h1 className="font-medium">{title}</h1>
          {description && <div className="text-sm text-muted-foreground">{description}</div>}
          {!onSend && <Badge variant="outline">Read-only</Badge>}
          <div role="status" className="text-sm text-muted-foreground">
            {!connected
              ? state
                ? "Reconnecting…"
                : "Connecting…"
              : busy
                ? "Responding…"
                : "Ready"}
          </div>
        </div>
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
                    void submit(retryText);
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
        <div className="min-h-0 flex-1">
          <MessageScroller>
            <MessageScrollerViewport preserveScrollOnPrepend>
              <MessageScrollerContent aria-busy={busy} className="gap-6 px-8 py-0">
                {state === null ? (
                  <div aria-label="Loading conversation" aria-busy="true">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ) : state.messages.length === 0 && !state.partial && !busy && !state.hasEarlier ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No messages yet</EmptyTitle>
                      <EmptyDescription>
                        {onSend
                          ? "Send a message to start the conversation."
                          : "This conversation is read-only."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {state?.hasEarlier && (
                  <p>Showing recent messages. Earlier history remains in session storage.</p>
                )}
                {state?.messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <Message align={message.role === "user" ? "end" : "start"}>
                      <MessageContent>
                        <MessageHeader>
                          {message.role === "user" ? "You" : "Assistant"}
                        </MessageHeader>
                        {message.role === "user" ? (
                          <Bubble align="end" variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">
                              {message.text}
                            </BubbleContent>
                          </Bubble>
                        ) : (
                          <div className="whitespace-pre-wrap">{message.text}</div>
                        )}
                        {message.interrupted && (
                          <MessageFooter>
                            <Badge variant="outline">Response interrupted.</Badge>
                          </MessageFooter>
                        )}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
                {state?.partial && (
                  <MessageScrollerItem messageId="partial">
                    <Message>
                      <MessageContent>
                        <MessageHeader>Assistant</MessageHeader>
                        <div className="whitespace-pre-wrap">{state.partial}</div>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )}
                {busy && !state?.partial && (
                  <Message>
                    <MessageContent>
                      <MessageFooter>
                        <Spinner aria-hidden="true" />
                        Waiting for response…
                      </MessageFooter>
                    </MessageContent>
                  </Message>
                )}
                {pending && !busy && onSend && (
                  <Message align="end">
                    <MessageContent>
                      <MessageFooter>
                        <Spinner aria-hidden="true" />
                        Awaiting acknowledgement…
                      </MessageFooter>
                    </MessageContent>
                  </Message>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </div>
        {onSend && (
          <ChatComposer
            state={state}
            connected={connected}
            pending={pending}
            uncertain={uncertain || retryText !== null}
            text={text}
            setText={setText}
            onSend={onSend}
            {...(onStop ? { onStop } : {})}
            {...(onContinue ? { onContinue } : {})}
            {...(onReset ? { onReset } : {})}
            {...(onWithdraw ? { onWithdraw } : {})}
          />
        )}
      </section>
    </MessageScrollerProvider>
  );
}
