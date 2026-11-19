import { AgentHandoff } from "@/components/assistant-ui/elements/agent-handoff";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/assistant-ui/elements/collapsible-root";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Handoff } from "../../shared/tangents.ts";

/** Host binding around supplied elements; opening the disclosure has no side effects. */
export function HandoffPreview({
  handoff,
  kind,
  placed,
  original,
  originalLabel = "Original handoff",
}: {
  handoff: Handoff;
  kind: "delegate" | "return";
  placed: boolean | undefined;
  original: string;
  originalLabel?: string;
}) {
  const fields = [
    ["Goal", handoff.goal],
    ["Decisions", handoff.decisions],
    ["Constraints", handoff.constraints],
    ["Exclusions", handoff.exclusions],
    ["References", handoff.references],
    ["Suggested skills", handoff.suggestedSkills],
    ["Discretion", handoff.discretion],
    ["Deliverable", handoff.deliverable],
    ["Evidence", handoff.evidence],
    ["Limits", handoff.limits],
  ] as const;
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-muted-foreground text-xs">
        Selected guidance ·{" "}
        {placed === undefined
          ? "placement unknown"
          : placed
            ? "placed in context"
            : "not yet placed"}
      </p>
      <AgentHandoff
        from={kind === "delegate" ? "Main" : "Tangent"}
        to={kind === "delegate" ? "Tangent" : "Main"}
        reason={handoff.goal.length > 160 ? `${handoff.goal.slice(0, 160)}…` : handoff.goal}
        carried={handoff.constraints
          .slice(0, 1)
          .map((value) => (value.length > 120 ? `${value.slice(0, 120)}…` : value))}
        settled={placed === true}
      />
      <CollapsibleRoot>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          Review full handoff
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 text-sm">
          {fields.map(([key, value]) => (
            <div key={key}>
              <p className="text-muted-foreground font-medium">{key}</p>
              <p className="whitespace-pre-wrap break-words">
                {Array.isArray(value) ? value.join("\n") || "None" : value || "None"}
              </p>
            </div>
          ))}
          <Textarea readOnly aria-label={originalLabel} value={original} />
        </CollapsibleContent>
      </CollapsibleRoot>
    </div>
  );
}
