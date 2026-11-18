import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CostMeter } from "@/components/assistant-ui/elements/cost-meter";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { useChatHost } from "./chat-host.ts";
import { AccountingSchema, type Accounting } from "../shared/accounting.ts";
import { ChatContext } from "./chat-context.tsx";
import { ChatConfiguration } from "./chat-configuration.tsx";

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
export function ChatDetails() {
  const host = useChatHost();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Accounting>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (host.active === false) setOpen(false);
  }, [host.active]);
  useEffect(() => {
    if (!open || host.active === false) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const base = host.chatId === undefined ? "/api" : `/api/chats/${host.chatId}`;
    async function refresh() {
      try {
        const response = await fetch(`${base}/accounting`);
        if (!response.ok) throw new Error("Unavailable");
        const next = AccountingSchema.parse(await response.json());
        if (host.chatId !== undefined && next.conversationId !== host.chatId)
          throw new Error("Wrong chat");
        if (active) {
          setData(next);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active)
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, host.active, host.chatId, retry]);
  return (
    <Dialog open={open && host.active !== false} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Chat details</DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Usage and recovery</DialogTitle>
          <DialogDescription>
            SDK cumulative chat and whole-session totals, including failed/aborted attempts and
            compaction. Input includes cache reads/writes; reasoning is already included in output.
            USD totals may be estimates, not an invoice. Not active-context occupancy.
          </DialogDescription>
        </DialogHeader>
        {open && host.active !== false && <ChatContext />}
        {open && host.active !== false && <ChatConfiguration />}
        {error && (
          <ErrorState
            title="Details unavailable"
            detail="Visible values may be stale. Refreshing details never resends a message."
            retrying={false}
            onRetry={() => setRetry((value) => value + 1)}
          />
        )}
        {!data && !error && <AgentStatus state="waiting" trailing={null} label="Loading details" />}
        {data && (
          <>
            <p className="text-xs text-muted-foreground">
              Observed {new Date(data.observedAt).toLocaleString()} · SDK totals, not a bill
            </p>
            <CostMeter
              totalLabel="this chat"
              inputLabel="in incl. cache"
              runCost={dollars(data.conversation.cost)}
              sessionCost={dollars(data.session.cost)}
              lines={data.conversation.lines.map((line) => ({
                model: line.label,
                inputTokens: line.input + line.cacheRead + line.cacheWrite,
                outputTokens: line.output,
                cost: dollars(line.cost),
                share: data.conversation.cost > 0 ? line.cost / data.conversation.cost : 0,
              }))}
            />
            <AgentStatus
              trailing={null}
              state="waiting"
              label={`SDK phase: ${data.activity.phase}${data.activity.attempt === null ? "" : ` · attempt ${data.activity.attempt}`}${data.activity.toolRounds === null ? "" : ` · tool rounds ${data.activity.toolRounds}`}`}
            />
            {data.activity.retryAt !== null && (
              <AgentStatus
                trailing={null}
                state="waiting"
                label={`Retry scheduled: ${new Date(data.activity.retryAt).toLocaleString()}`}
              />
            )}
            {data.activity.pollAt !== null && (
              <AgentStatus
                trailing={null}
                state="waiting"
                label={`Deferred provider response; next poll: ${new Date(data.activity.pollAt).toLocaleString()}`}
              />
            )}
            {data.activity.failure && (
              <AgentStatus
                trailing={null}
                state={data.activity.failure === "aborted" ? "waiting" : "failed"}
                label={`Last unanswered run: ${data.activity.failure}`}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
