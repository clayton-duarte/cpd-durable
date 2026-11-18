import { useEffect, useState } from "react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/assistant-ui/elements/collapsible-root";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ContextSchema,
  CompactResultSchema,
  type ChatContext as ContextData,
} from "../shared/context.ts";
import { useChatHost } from "./chat-host.ts";

export function ChatContext() {
  const host = useChatHost();
  const [data, setData] = useState<ContextData>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [instructions, setInstructions] = useState("");
  const [admission, setAdmission] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const base = host.chatId === undefined ? "/api" : `/api/chats/${host.chatId}`;
  useEffect(() => {
    if (host.active === false) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const response = await fetch(`${base}/context`);
        if (!response.ok) throw new Error();
        const next = ContextSchema.parse(await response.json());
        if (host.chatId !== undefined && next.conversationId !== host.chatId) throw new Error();
        if (active) {
          setData(next);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active)
          timer = setTimeout(() => {
            void read();
          }, 2000);
      }
    }
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [base, host.active, host.chatId, refresh]);
  async function compact() {
    if (admission !== undefined) return;
    setAdmission("Admitting compaction…");
    try {
      const response = await fetch(`${base}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions }),
      });
      if (!response.ok) throw new Error();
      const result = CompactResultSchema.parse(await response.json());
      setAdmission(
        `Task ${result.taskId} admitted, not necessarily placed. Summary placement occurs immediately if idle, otherwise at a boundary.`,
      );
    } catch {
      setAdmission(
        "Admission unconfirmed. It may already be running. Inspect context before deliberately starting another compaction; this action is never automatically retried.",
      );
    }
  }
  return (
    <section aria-label="Active context" className="flex flex-col gap-3">
      <h3 className="font-medium">Active context and compaction</h3>
      <p className="text-xs text-muted-foreground">
        Committed SDK context, not loaded history or the full assembled provider prompt. Token
        occupancy and headroom are unknown; cumulative spend is not context usage. Compaction
        preserves saved history.
      </p>
      {error && (
        <ErrorState
          title="Context unavailable"
          detail="Visible context may be stale. Read refreshes do not compact or send."
          retrying={false}
          onRetry={() => setRefresh((value) => value + 1)}
        />
      )}
      {data && (
        <>
          <AgentStatus
            trailing={null}
            state="waiting"
            label={`${data.entryCount} active entries · ${data.messageCount} model messages · head ${data.headId ?? "transcript start"}`}
          />
          <p className="text-xs text-muted-foreground">
            {data.roles.map(({ role, count }) => `${role}: ${count}`).join(" · ")}
          </p>
          <div className="space-y-2 text-xs">
            <p>
              <strong>Committed context heuristic:</strong>{" "}
              {data.measurements.committed.tokens === null
                ? "Unknown (images or opaque reasoning/signatures cannot be estimated)"
                : `approximately ${data.measurements.committed.tokens.toLocaleString()} tokens`}
              . Method: UTF-8 content bytes ÷ 4, rounded up; not a tokenizer.
            </p>
            <p>
              Selected model:{" "}
              {data.measurements.model
                ? `${data.measurements.model.provider}/${data.measurements.model.modelId}`
                : "unknown"}
              {" · "}Catalog context window:{" "}
              {data.measurements.contextWindow === null
                ? "unknown"
                : `${data.measurements.contextWindow.toLocaleString()} tokens`}
              {" · "}Observed {new Date(data.measurements.observedAt).toLocaleString()}.
            </p>
            <p>
              Excludes assembled system prompts, extension sections and future resources, tool
              schemas and provider framing, provider-specific transforms, queued input and in-flight
              output, and output/reasoning reservations. It does not guarantee the next request
              fits.
            </p>
            <p>
              <strong>Previous assistant request:</strong>{" "}
              {data.measurements.lastRequest
                ? `${data.measurements.lastRequest.model.provider}/${data.measurements.lastRequest.model.modelId} · started ${new Date(data.measurements.lastRequest.requestStartedAt).toLocaleString()} · ${data.measurements.lastRequest.stopReason}`
                : "No durable request observation."}
            </p>
            {data.measurements.lastRequest &&
              (data.measurements.lastRequest.usage ? (
                <p>
                  SDK request usage: input{" "}
                  {data.measurements.lastRequest.usage.input.toLocaleString()}
                  {" · "}cache read {data.measurements.lastRequest.usage.cacheRead.toLocaleString()}
                  {" · "}cache write{" "}
                  {data.measurements.lastRequest.usage.cacheWrite.toLocaleString()}
                  {data.measurements.lastRequest.usage.cacheWrite1h !== undefined &&
                    ` (1h subset ${data.measurements.lastRequest.usage.cacheWrite1h.toLocaleString()})`}
                  {" · "}output {data.measurements.lastRequest.usage.output.toLocaleString()}
                  {" · "}reasoning{" "}
                  {data.measurements.lastRequest.usage.reasoning === undefined
                    ? "unknown"
                    : `${data.measurements.lastRequest.usage.reasoning.toLocaleString()} (subset of output)`}
                  {" · "}total {data.measurements.lastRequest.usage.totalTokens.toLocaleString()}.
                  Cache counters are shown separately; provider conventions may differ.
                </p>
              ) : (
                <p>Request usage unknown; zero defaults cannot establish a provider report.</p>
              ))}
            <p>
              Previous request usage is not current occupancy or directly comparable to the
              committed heuristic: the full assembled request is unavailable and context or model
              may have changed. Token occupancy and headroom are unknown.
            </p>
          </div>
          {data.compactions.map((task) => (
            <AgentStatus
              key={task.taskId}
              trailing={null}
              state="waiting"
              label={`${task.trigger} compaction ${task.taskId} · ${task.blocking ? "blocking" : "nonblocking"} · attempt ${task.attempt}${task.retryAt === null ? "" : ` · retry ${new Date(task.retryAt).toLocaleString()}`}`}
            />
          ))}
          {data.failure && (
            <AgentStatus
              trailing={null}
              state="failed"
              label={`Compaction ${data.failure.taskId} failed (${data.failure.trigger}). Provider diagnostics remain private.`}
            />
          )}
          <CollapsibleRoot>
            <CollapsibleTrigger>Inspect active entry boundaries</CollapsibleTrigger>
            <CollapsibleContent>
              {data.truncated && <p>Showing the newest 200 active entries.</p>}
              <ol className="max-h-48 overflow-y-auto text-xs">
                {data.entries.map((entry) => (
                  <li key={entry.id}>
                    {entry.id} · {entry.kind} · {entry.messages} model messages
                  </li>
                ))}
              </ol>
            </CollapsibleContent>
          </CollapsibleRoot>
        </>
      )}
      {!host.readOnly && host.onSend && (
        <>
          {data?.compactions.some((task) => task.trigger === "manual") && host.onStop && (
            <Button
              variant="outline"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void host.onStop?.().finally(() => setStopping(false));
              }}
            >
              Stop foreground work
            </Button>
          )}
          <label className="text-sm" htmlFor={`compact-${host.chatId ?? "root"}`}>
            Optional summary instructions
          </label>
          <Textarea
            id={`compact-${host.chatId ?? "root"}`}
            maxLength={32_000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={!data || error || admission !== undefined}
            onClick={() => {
              void compact();
            }}
          >
            Compact context
          </Button>
          {admission && (
            <p role="status" className="text-xs">
              {admission}
            </p>
          )}
        </>
      )}
    </section>
  );
}
