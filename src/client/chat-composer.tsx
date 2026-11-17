import { useRef, useState, type FormEvent } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUpIcon, ChevronDownIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
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
    <div className="flex min-w-0 flex-col gap-3">
      {controls?.resetPending && (
        <Badge variant="outline" className="whitespace-normal">
          Context reset pending; Stop does not withdraw it
        </Badge>
      )}
      {!!controls?.queue.length && (
        <section aria-label="Queued inputs" className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Queued inputs <Badge variant="secondary">{controls.queue.length}</Badge>
          </div>
          <ul
            data-slot="aui-durable-queue"
            className="flex max-h-48 flex-col gap-2 overflow-y-auto"
          >
            {controls.queue.map((item) => (
              <li key={item.id} className={cn(paper, "flex items-start gap-3 rounded-2xl p-3")}>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {item.mode === "steer" ? "Steer requested" : "Follow-up queued"}
                  </p>
                  <p className="line-clamp-3 text-sm whitespace-pre-wrap wrap-break-word">
                    {item.text}
                  </p>
                </div>
                {onWithdraw && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!available}
                    aria-label={`Withdraw queued input ${item.id}`}
                    onClick={() => {
                      void onWithdraw(item.id);
                    }}
                  >
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
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
        <ComposerPrimitive.Root
          ref={formRef}
          data-slot="aui-composer"
          className={cn(
            paper,
            "flex min-w-0 flex-col gap-2 rounded-2xl p-3 focus-within:ring-1 focus-within:ring-ring",
          )}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <ComposerPrimitive.Input
            aria-label="Message"
            placeholder="Send a message…"
            className="max-h-48 min-h-12 w-full resize-none bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground"
            rows={1}
            submitMode="none"
            cancelOnEscape={false}
            addAttachmentOnPaste={false}
            maxLength={32_000}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {modesEnabled && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Stop response"
                disabled={!available}
                onClick={() => {
                  void onStop();
                }}
              >
                <SquareIcon />
                Stop
              </Button>
            )}
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="ml-auto rounded-full"
              disabled={!canSend}
              aria-label="Send"
            >
              {pending ? <Spinner aria-hidden="true" /> : <ArrowUpIcon />}{" "}
              {mode === "steer" ? "Steer" : mode === "followUp" && busy ? "Queue" : "Send"}
            </Button>
          </div>
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
        </ComposerPrimitive.Root>
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
