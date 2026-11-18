import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { Button } from "@/components/ui/button";
import type { HelpersView } from "../../shared/helpers.ts";

/** Presentation only; host owns loading, lifecycle actions and result retrieval. */
export function WorkerStrip({
  workers,
  onInspect,
}: {
  workers: HelpersView["helpers"];
  onInspect: (taskId: string) => void;
}) {
  return (
    <section aria-label="Workers" className="flex flex-col gap-2">
      {workers.map((worker) => (
        <div key={worker.taskId} className="flex items-center gap-2">
          <AgentStatus
            trailing={null}
            state={
              worker.status === "success"
                ? "done"
                : worker.status === "failure"
                  ? "failed"
                  : worker.status === "running"
                    ? "working"
                    : "waiting"
            }
            label={`${worker.status} · ${worker.modelName ?? (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : "model unknown")}${worker.stop === "none" ? "" : ` · stop ${worker.stop}`}`}
          />
          <Button variant="ghost" onClick={() => onInspect(worker.taskId)}>
            Inspect worker {worker.taskId}
          </Button>
        </div>
      ))}
    </section>
  );
}
