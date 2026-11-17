import { useRef, useState, type FormEvent } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { MODEL_ID } from "../shared/chat.ts";
import { useChat } from "./use-chat.ts";

// Composition follows shadcn's AI Elements Chat pattern; primitives remain stock.
export function Chat() {
  const { state, connected, pending, error, send, stop } = useChat();
  const [text, setText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const busy = state?.busy ?? false;
  const canSend = connected && state !== null && !busy && !pending && text.trim().length > 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    const submittedDraft = text;
    if (await send(submittedDraft.trim())) {
      setText((current) => (current === submittedDraft ? "" : current));
    }
  }

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex h-dvh w-full flex-col gap-4">
        <div className="flex flex-col gap-1 p-8 pb-4">
          <h1 className="font-medium">CPD Durable</h1>
          <div className="text-sm text-muted-foreground">OpenCode Go · {MODEL_ID}</div>
          <div role="status" className="text-sm text-muted-foreground">
            {!connected ? "Connecting…" : busy ? "Responding…" : "Ready"}
          </div>
        </div>
        {(error ?? state?.failure) && (
          <Alert variant="destructive">
            <AlertDescription>{error ?? state?.failure}</AlertDescription>
          </Alert>
        )}
        <div className="min-h-0 flex-1">
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={busy} className="gap-6 px-8 py-0">
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
                        {message.role === "user" ? (
                          <Bubble align="end" variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">
                              {message.text}
                            </BubbleContent>
                          </Bubble>
                        ) : (
                          <div className="whitespace-pre-wrap">{message.text}</div>
                        )}
                        {message.interrupted && <p>Response interrupted.</p>}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
                {state?.partial && (
                  <MessageScrollerItem messageId="partial">
                    <Message>
                      <MessageContent>
                        <div className="whitespace-pre-wrap">{state.partial}</div>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </div>
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
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
              />
              <InputGroupAddon align="block-end">
                {busy ? (
                  <InputGroupButton
                    type="button"
                    aria-label="Stop response"
                    disabled={!connected || pending}
                    onClick={() => {
                      void stop();
                    }}
                  >
                    <SquareIcon /> Stop
                  </InputGroupButton>
                ) : (
                  <InputGroupButton type="submit" variant="default" disabled={!canSend}>
                    <ArrowUpIcon /> Send
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </div>
      </div>
    </MessageScrollerProvider>
  );
}
