import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
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

export interface ChatProps {
  title: string;
  description?: ReactNode;
  state: ChatState | null;
  connected: boolean;
  pending?: boolean;
  error?: string | null;
  retryText?: string | null;
  onSend?: (text: string) => Promise<boolean>;
  onStop?: () => Promise<void>;
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
  onSend,
  onStop,
}: ChatProps) {
  const [text, setText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const busy = state?.busy ?? false;
  const canSend =
    !!onSend &&
    connected &&
    state !== null &&
    !busy &&
    !pending &&
    retryText === null &&
    text.trim().length > 0;

  async function submit(draft: string) {
    const currentDraft = text;
    if (await onSend?.(draft.trim())) {
      setText((current) =>
        current === currentDraft && current.trim() === draft.trim() ? "" : current,
      );
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    await submit(text);
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
            </AlertDescription>
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
          <div className="p-8 pt-0">
            <form
              ref={formRef}
              onSubmit={(event) => {
                void onSubmit(event);
              }}
            >
              <InputGroup>
                <InputGroupTextarea
                  aria-label="Message"
                  placeholder="Send a message…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={32_000}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      formRef.current?.requestSubmit();
                    }
                  }}
                />
                <InputGroupAddon align="block-end">
                  {busy && onStop ? (
                    <InputGroupButton
                      type="button"
                      aria-label="Stop response"
                      disabled={!connected || pending}
                      onClick={() => {
                        void onStop();
                      }}
                    >
                      <SquareIcon /> Stop
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton type="submit" variant="default" disabled={!canSend}>
                      {pending ? <Spinner aria-hidden="true" /> : <ArrowUpIcon />} Send
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
            </form>
          </div>
        )}
      </section>
    </MessageScrollerProvider>
  );
}
