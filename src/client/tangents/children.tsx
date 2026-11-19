import { AgentStatus, type AgentState } from "@/components/assistant-ui/elements/agent-status";
import { TaskCard, type TaskCardState } from "@/components/assistant-ui/elements/task-card";

// Presentation data only: the integration adapter maps durable records into these views.
export type ChildActivity = "running" | "idle" | "waiting" | "failed" | "interrupted" | "unknown";
export type ChildAttention = "none" | "needs-input" | "unread" | "report-ready";
export type ChildLifecycle = "open" | "concluded" | "archived";

export interface TangentChildView {
  id: string;
  parentId: string;
  title: string;
  model: string;
  lifecycle: ChildLifecycle;
  activity: ChildActivity;
  attention: ChildAttention;
}

export interface WorkerChildView {
  id: string;
  parentId: string;
  title: string;
  model: string;
  lifecycle: ChildLifecycle;
  activity: ChildActivity;
  attention: ChildAttention;
}

export interface TangentChildrenProps {
  parentId: string;
  tangents: readonly TangentChildView[];
  workers: readonly WorkerChildView[];
  selectedTangentId: string | null;
  selectionDisabled?: boolean;
  onSelectTangent: (id: string) => void;
}

function description(item: TangentChildView | WorkerChildView): string {
  return [
    item.model,
    item.lifecycle === "concluded"
      ? "Concluded"
      : item.lifecycle === "archived"
        ? "Archived"
        : "Open",
    item.activity === "running"
      ? "Running"
      : item.activity === "idle"
        ? "Idle"
        : item.activity === "waiting"
          ? "Waiting"
          : item.activity === "failed"
            ? "Failed"
            : item.activity === "interrupted"
              ? "Interrupted"
              : "Activity unknown",
    ...(item.attention === "needs-input"
      ? ["Needs input"]
      : item.attention === "unread"
        ? ["Unread"]
        : item.attention === "report-ready"
          ? ["Report ready"]
          : []),
  ].join(" · ");
}

function visualState(item: TangentChildView | WorkerChildView): TaskCardState & AgentState {
  if (item.lifecycle === "concluded") return "done";
  if (item.activity === "failed") return "failed";
  return item.activity === "running" ? "working" : "waiting";
}

export function TangentChildren({
  parentId,
  tangents,
  workers,
  selectedTangentId,
  selectionDisabled = false,
  onSelectTangent,
}: TangentChildrenProps) {
  const visibleTangents = tangents.filter(
    (item) => item.parentId === parentId && item.lifecycle === "open",
  );
  const visibleWorkers = workers.filter(
    (item) => item.parentId === parentId && item.lifecycle === "open",
  );
  if (!visibleTangents.length && !visibleWorkers.length) return null;

  return (
    <section aria-label="Immediate children">
      {visibleTangents.length > 0 && (
        <div aria-label="Tangents" className="flex flex-wrap gap-2">
          {visibleTangents.map((item) => (
            <TaskCard
              key={item.id}
              label={item.title}
              state={visualState(item)}
              stateLabel={description(item)}
              meta={`${item.attention === "none" ? item.activity : item.attention} · ${item.model}`}
              title={`${item.title} · ${description(item)}`}
              className={selectedTangentId === item.id ? "ring-1 ring-ring" : undefined}
              selected={selectedTangentId === item.id}
              selectionLabel={`${selectedTangentId === item.id ? "Selected tangent" : "Open tangent"}: ${item.title} ${item.attention === "none" ? item.activity : item.attention} · ${item.model}`}
              selectionDisabled={selectionDisabled}
              onSelect={() => onSelectTangent(item.id)}
            />
          ))}
        </div>
      )}
      {visibleWorkers.length > 0 && (
        <div aria-label="Workers" className="flex flex-wrap gap-2">
          {visibleWorkers.map((item) => {
            const label = `${item.title} · ${description(item)}`;
            return (
              <AgentStatus
                key={item.id}
                state={visualState(item)}
                label={label}
                aria-label={label}
                title={label}
                trailing={null}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
