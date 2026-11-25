import { useEffect, useRef, useState } from "react";
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorContent,
} from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import { supportsThinking, thinkingLabel } from "../shared/configuration.ts";
import {
  ModelPolicySchema,
  ModelPolicyViewSchema,
  type Assignments,
  type ModelPolicy,
  type ModelPolicyView,
} from "../shared/model-policy.ts";

export type ModelTierSettingsApi = {
  read(signal?: AbortSignal): Promise<unknown>;
  save(
    change: { expected: ModelPolicy; assignments: Assignments },
    signal?: AbortSignal,
  ): Promise<unknown>;
};

const roles = [
  ["main", "Main", "Model for all main chats."],
  ["tangent", "Tangent", "Model for all tangents, message threads, and mid-tier workers."],
  ["worker", "Worker", "Model for workers using the economical tier."],
] as const;
const key = (value: { provider: string; modelId: string }) =>
  JSON.stringify([value.provider, value.modelId]);

/** API is injected by the host; saving settings never sends a model request. */
export function ModelTierSettings({ api }: { api: ModelTierSettingsApi }) {
  const [data, setData] = useState<ModelPolicyView>();
  const [draft, setDraft] = useState<Assignments>();
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const request = useRef(0);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const id = ++request.current;
    setLoading(true);
    void api
      .read(controller.signal)
      .then((value) => {
        const next = ModelPolicyViewSchema.parse(value);
        if (request.current === id) {
          setData(next);
          setDraft((previous) => previous ?? next.assignments);
          setError("");
          setLoading(false);
        }
      })
      .catch(() => {
        if (request.current === id) {
          setLoading(false);
          setError("Could not load model settings. Retry without sending a prompt.");
        }
      });
    return () => {
      controller.abort();
      saveController.current?.abort();
      request.current++;
    };
  }, [api, reload]);

  async function save() {
    if (!data || !draft || pending || loading || error) return;
    setPending(true);
    const version = generation.current;
    const id = ++request.current;
    const controller = new AbortController();
    saveController.current = controller;
    try {
      const response = ModelPolicySchema.parse(
        await api.save(
          {
            expected: { revision: data.revision, assignments: data.assignments },
            assignments: draft,
          },
          controller.signal,
        ),
      );
      if (request.current !== id) return;
      if (
        response.revision !== data.revision + 1 ||
        JSON.stringify(response.assignments) !== JSON.stringify(draft)
      )
        throw new Error("Unrecognized save acknowledgement");
      setData({ ...response, choices: data.choices });
      if (generation.current === version) setDraft(response.assignments);
      setNotice("Saved for existing and new chats and workers. In-flight requests are unchanged.");
    } catch {
      if (request.current !== id) return;
      setError(
        "Save unconfirmed or settings changed. Reload and review your choices before saving again.",
      );
    } finally {
      if (request.current === id) setPending(false);
    }
  }
  return (
    <section aria-label="Model tier settings" className="flex flex-col gap-3">
      <h3 className="font-medium">Model tiers</h3>
      <p>
        Assign available models to roles. These labels describe your intent, not a capability
        guarantee. Saving updates existing chats, including any per-chat selections.
      </p>
      {error && (
        <div role="alert">
          {error}{" "}
          <Button
            variant="outline"
            onClick={() => {
              setReload((n) => n + 1);
            }}
          >
            Reload saved settings
          </Button>
        </div>
      )}
      {data &&
        draft &&
        roles.map(([role, label, description]) => {
          const selected = draft[role];
          const choice = data.choices.find((item) => selected && key(item) === key(selected));
          return (
            <div key={role} className="flex flex-col gap-2">
              <h4>{label}</h4>
              <p>{description}</p>
              <p>
                {selected
                  ? `${selected.provider}/${selected.modelId} · thinking: ${thinkingLabel(selected.thinkingLevel)}`
                  : role === "main"
                    ? "Host default until configured."
                    : "Not configured — select a model."}
              </p>
              {selected &&
                (!choice || !supportsThinking(choice.thinkingLevels, selected.thinkingLevel)) && (
                  <p role="status">
                    This model or thinking level is unavailable. Choose an available selection.
                  </p>
                )}
              <ModelSelectorRoot
                models={data.choices.map((item) => ({
                  id: key(item),
                  name: `${item.provider}/${item.modelId}`,
                  description: item.name,
                  efforts: (["default", ...item.thinkingLevels] as const).map((level) => ({
                    id: level,
                    name: thinkingLabel(level),
                    disabled: !supportsThinking(item.thinkingLevels, level),
                  })),
                }))}
                value={selected ? key(selected) : ""}
                {...(selected ? { effort: selected.thinkingLevel } : {})}
                onValueChange={(value) => {
                  const next = data.choices.find((item) => key(item) === value);
                  if (!next) return;
                  if (selected && key(selected) === value) return;
                  generation.current++;
                  setDraft({
                    ...draft,
                    [role]: {
                      provider: next.provider,
                      modelId: next.modelId,
                      thinkingLevel: "default",
                    },
                  });
                }}
                onEffortChange={(level) => {
                  const supported =
                    level === "default"
                      ? level
                      : choice?.thinkingLevels.find((item) => item === level);
                  if (
                    !selected ||
                    !supported ||
                    selected.thinkingLevel === supported ||
                    !supportsThinking(choice?.thinkingLevels ?? [], supported)
                  )
                    return;
                  generation.current++;
                  setDraft({ ...draft, [role]: { ...selected, thinkingLevel: supported } });
                }}
              >
                <ModelSelectorTrigger
                  aria-label={`${label} model`}
                  disabled={!data.choices.length}
                />
                <ModelSelectorContent searchable />
              </ModelSelectorRoot>
            </div>
          );
        })}
      <Button
        variant="outline"
        disabled={
          !data ||
          !draft ||
          pending ||
          loading ||
          !!error ||
          Object.values(draft).some(
            (selection) =>
              selection &&
              !data.choices.some(
                (choice) =>
                  key(choice) === key(selection) &&
                  supportsThinking(choice.thinkingLevels, selection.thinkingLevel),
              ),
          )
        }
        onClick={() => {
          void save();
        }}
      >
        Apply models to all chats
      </Button>
      <Button
        variant="outline"
        disabled={pending || loading}
        onClick={() => setReload((n) => n + 1)}
      >
        Reload saved tiers and model list
      </Button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
