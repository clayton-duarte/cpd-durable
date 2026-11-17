import { useRef, useState, type FormEvent } from "react";
import { ArrowUpIcon, ChevronDownIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ChatState, SendMode } from "../shared/chat.ts";

export interface ComposerActions {
  onSend?: (text: string, mode?: SendMode) => Promise<boolean>;
  onStop?: () => Promise<void>;
  onContinue?: () => Promise<boolean>;
  onReset?: (handoff: string) => Promise<boolean>;
  onWithdraw?: (id: string) => Promise<void>;
}

export interface ChatComposerProps extends ComposerActions {
  state: ChatState | null;
  connected: boolean;
  pending: boolean;
  uncertain: boolean;
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
}

export function ChatComposer({
  state,
  connected,
  pending,
  uncertain,
  text,
  setText,
  onSend,
  onStop,
  onContinue,
  onReset,
  onWithdraw,
}: ChatComposerProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<SendMode>("reject");
  const [resetOpen, setResetOpen] = useState(false);
  const [handoff, setHandoff] = useState("");
  const controls = state?.controls;
  const busy = state?.busy ?? false;
  const available = connected && state !== null && !pending && !uncertain;
  const modesEnabled = controls !== undefined;
  const canSend =
    available &&
    !!onSend &&
    text.trim().length > 0 &&
    (mode === "reject" ? !busy : mode === "steer" ? busy : true);
  const modeLabel =
    mode === "steer"
      ? "Steer current work"
      : mode === "followUp"
        ? "Send after current response"
        : "Send now";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    const draft = text;
    if (await onSend?.(draft.trim(), mode))
      setText((current) => (current === draft ? "" : current));
  }

  return (
    <div className="flex flex-col gap-2 p-8 pt-0">
      {controls?.resetPending && (
        <Badge variant="outline" className="whitespace-normal">
          Context reset pending; Stop does not withdraw it
        </Badge>
      )}
      {!!controls?.queue.length && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            Queued inputs <Badge variant="secondary">{controls.queue.length}</Badge>
            <ChevronDownIcon />
          </CollapsibleTrigger>
          <CollapsibleContent className="max-h-48 overflow-y-auto">
            {controls.queue.map((item) => (
              <Item key={item.id} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>
                    {item.mode === "steer" ? "Steer requested" : "Follow-up queued"}
                  </ItemTitle>
                  <ItemDescription className="whitespace-pre-wrap">{item.text}</ItemDescription>
                </ItemContent>
                {onWithdraw && (
                  <ItemActions>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!available}
                      aria-label={`Withdraw queued input ${item.id}`}
                      onClick={() => {
                        void onWithdraw(item.id);
                      }}
                    >
                      Withdraw
                    </Button>
                  </ItemActions>
                )}
              </Item>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-wrap gap-2">
        {onContinue && controls?.canContinue && (
          <Button
            type="button"
            variant="outline"
            disabled={!available || busy}
            onClick={() => {
              void onContinue();
            }}
          >
            Continue response
          </Button>
        )}
        {onReset && controls && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  disabled={!available || controls.resetPending}
                />
              }
            >
              Conversation actions
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setResetOpen(true)}>
                Reset model context…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {onSend && (
        <form
          ref={formRef}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <InputGroup>
            <InputGroupTextarea
              aria-label="Message"
              placeholder="Send a message…"
              value={text}
              maxLength={32_000}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
            />
            <InputGroupAddon align="block-end" className="flex-wrap">
              {modesEnabled && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <InputGroupButton
                        type="button"
                        disabled={pending || uncertain}
                        aria-label="Send mode"
                      />
                    }
                  >
                    {modeLabel}
                    <ChevronDownIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => setMode("reject")}>Send now</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setMode("followUp")}>
                      Send after current response
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!busy} onClick={() => setMode("steer")}>
                      Steer current work
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {busy && onStop && (
                <InputGroupButton
                  type="button"
                  aria-label="Stop response"
                  disabled={!available}
                  onClick={() => {
                    void onStop();
                  }}
                >
                  <SquareIcon />
                  Stop
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit"
                variant="default"
                disabled={!canSend}
                aria-label="Send"
              >
                {pending ? <Spinner aria-hidden="true" /> : <ArrowUpIcon />}{" "}
                {mode === "steer" ? "Steer" : mode === "followUp" && busy ? "Queue" : "Send"}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {mode === "steer" && (
            <p className="text-sm text-muted-foreground">
              Requested steering is applied at an eligible run boundary, not immediately.
            </p>
          )}
          {busy && onStop && (
            <p className="text-sm text-muted-foreground">
              Stop ends current foreground work and withdraws queued inputs.
            </p>
          )}
        </form>
      )}
      {onReset && (
        <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset model context?</AlertDialogTitle>
              <AlertDialogDescription>
                Stored conversation history is retained. The model starts a new context, at the next
                boundary if busy. Stop does not withdraw a queued reset. Queued inputs may run in
                the new context. Optional handoff instructions become a user message; reset alone
                does not request an answer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label>
              Handoff instructions (optional)
              <Textarea
                aria-label="Handoff instructions (optional)"
                value={handoff}
                maxLength={32_000}
                onChange={(event) => setHandoff(event.target.value)}
              />
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!available || !!controls?.resetPending}
                onClick={() => {
                  void onReset(handoff.trim()).then((admitted) => {
                    setResetOpen(false);
                    if (admitted) setHandoff("");
                  });
                }}
              >
                Reset context
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
