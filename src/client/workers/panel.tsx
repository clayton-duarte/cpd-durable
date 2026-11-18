import { useEffect, useRef, useState } from "react";
import { HelpersViewSchema, HelperResultSchema, type HelpersView } from "../../shared/helpers.ts";
import { WorkerStrip } from "./strip.tsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function WorkerPanel({
  chatId,
  active,
  readOnly,
  mutationAllowed,
}: {
  chatId: string;
  active: boolean;
  readOnly: boolean;
  mutationAllowed?: (() => boolean) | undefined;
}) {
  const [view, setView] = useState<HelpersView>();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const intents = useRef(new Map<string, string>());
  const busy = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    if (!active) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/chats/${chatId}/workers`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const next = HelpersViewSchema.parse(await response.json());
        if (alive) {
          setView(next);
          setError(null);
        }
      } catch {
        if (alive) setError("Worker status unavailable. Previous status may be stale.");
      } finally {
        if (alive)
          timer = setTimeout(() => {
            void poll();
          }, 2000);
      }
    }
    void poll();
    return () => {
      alive = false;
      epoch.current++;
      controller.abort();
      clearTimeout(timer);
    };
  }, [chatId, active, reload]);

  async function inspect(taskId: string) {
    const current = epoch.current;
    try {
      const response = await fetch(
        `/api/chats/${chatId}/workers/${encodeURIComponent(taskId)}/result`,
      );
      if (!response.ok) throw new Error();
      const value = HelperResultSchema.parse(await response.json());
      if (value.taskId !== taskId) throw new Error();
      if (current === epoch.current)
        setResult(value.text + (value.truncated ? "\n[Result truncated]" : ""));
    } catch {
      if (current === epoch.current) setError("Worker result unavailable.");
    }
  }
  async function stop(taskId: string) {
    if (
      busy.current ||
      readOnly ||
      mutationAllowed?.() === false ||
      error?.startsWith("Worker status unavailable")
    )
      return;
    busy.current = true;
    const requestId = intents.current.get(taskId) ?? crypto.randomUUID();
    intents.current.set(taskId, requestId);
    try {
      const response = await fetch(
        `/api/chats/${chatId}/workers/${encodeURIComponent(taskId)}/stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId }),
        },
      );
      if (!response.ok) throw new Error();
      setReload((n) => n + 1);
    } catch {
      setError("Worker stop was not confirmed; retry with the same request identity.");
    } finally {
      busy.current = false;
    }
  }
  if (!view?.helpers.length && !error) return null;
  return (
    <section aria-label={`Workers for chat ${chatId}`}>
      {error && <p role="status">{error}</p>}
      {view && (
        <WorkerStrip
          workers={view.helpers}
          onInspect={(id) => {
            void inspect(id);
          }}
        />
      )}
      {view?.helpers
        .filter((worker) => worker.status === "pending" || worker.status === "running")
        .map((worker) => (
          <Button
            key={worker.taskId}
            variant="outline"
            disabled={
              readOnly || !!error?.startsWith("Worker status unavailable") || worker.stop !== "none"
            }
            onClick={() => {
              void stop(worker.taskId);
            }}
          >
            Stop worker {worker.taskId}
          </Button>
        ))}
      {result !== null && (
        <div>
          <Textarea readOnly aria-label="Worker result for review" value={result} />
          <Button variant="ghost" onClick={() => setResult(null)}>
            Close worker result
          </Button>
        </div>
      )}
    </section>
  );
}
