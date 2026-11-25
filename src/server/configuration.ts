import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { AgentState } from "@earendil-works/pi-durable";
import { MODEL_ID, PROVIDER_ID } from "../shared/chat.ts";
import type { Selection } from "../shared/configuration.ts";

export function selection(state: Readonly<AgentState> | undefined): Selection {
  return {
    provider: state?.model?.provider ?? PROVIDER_ID,
    modelId: state?.model?.modelId ?? MODEL_ID,
    thinkingLevel: state?.thinkingLevel ?? "default",
  };
}
export async function modelChoices(models: Models) {
  return (await models.getAvailable()).map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model),
  }));
}
export function sameSelection(a: Selection, b: Selection) {
  return (
    a.provider === b.provider && a.modelId === b.modelId && a.thinkingLevel === b.thinkingLevel
  );
}

export function modelChange(value: Selection) {
  return {
    model: { provider: value.provider, modelId: value.modelId },
    thinkingLevel: value.thinkingLevel === "default" ? null : value.thinkingLevel,
  };
}
