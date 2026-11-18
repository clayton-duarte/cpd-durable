import type { TangentView } from "../../shared/tangents.ts";
import type { TangentChildView } from "./children.tsx";

/** Adapts validated durable data for the existing presentation component. */
export function tangentChildView(tangent: TangentView): TangentChildView {
  return {
    id: String(tangent.id),
    parentId: String(tangent.parentId),
    title: tangent.title,
    model: tangent.model.name ?? `${tangent.model.provider}/${tangent.model.modelId}`,
    lifecycle: tangent.lifecycle,
    activity: tangent.activity,
    attention: tangent.attention === "needs-answer" ? "needs-input" : tangent.attention,
  };
}
