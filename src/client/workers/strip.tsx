import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { SearchIcon } from "lucide-react";
import type { HelpersView } from "../../shared/helpers.ts";

/** Presentation only; host owns loading, lifecycle actions and result retrieval. */
export function WorkerStrip({
  workers,
  onInspect,
  onStop,
  stopDisabled,
}: {
  workers: HelpersView["helpers"];
  onInspect: (taskId: string) => void;
  onStop: (taskId: string) => void;
  stopDisabled: boolean;
}) {
  return (
    <section aria-label="Workers" className="flex flex-col gap-2">
      {workers.map((worker) => (
        <div key={worker.taskId} className="flex min-w-0 items-center gap-1">
          <AgentStatus
            trailing={null}
            className="min-w-0 border-0 bg-transparent py-0 ps-2 dark:bg-transparent"
            state={
              worker.status === "success"
                ? "done"
                : worker.status === "failure"
                  ? "failed"
                  : worker.status === "running"
                    ? "working"
                    : "waiting"
            }
            label={`${worker.modelName ?? (worker.model ? `${worker.model.provider}/${worker.model.modelId}` : "model unknown")} · ${worker.status} · ${worker.mode} · ${worker.label ?? "Worker"}${worker.stop === "none" ? "" : ` · stop ${worker.stop}`}`}
          />
          <TooltipIconButton
            tooltip={`Inspect worker ${worker.taskId}`}
            onClick={() => onInspect(worker.taskId)}
          >
            <SearchIcon />
          </TooltipIconButton>
          {(worker.status === "pending" || worker.status === "running") && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop worker ${worker.taskId}`}
              disabled={stopDisabled || worker.stop !== "none"}
              onClick={() => onStop(worker.taskId)}
            >
              Stop
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
