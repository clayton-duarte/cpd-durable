import { useEffect, useRef, useState } from "react";
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorContent,
} from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
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
  ["main", "Main", "High-capability model for new main threads."],
  [
    "tangent",
    "Tangent",
    "Mid-tier model for new tangents and explicitly selected mid-tier workers.",
  ],
  ["worker", "Worker", "Economical model for new workers by default."],
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
  const [needsEffort, setNeedsEffort] = useState<string[]>([]);
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
    if (!data || !draft || pending || loading || error || needsEffort.length) return;
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
      setNotice("Saved for new threads and workers. Existing conversations are unchanged.");
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
        guarantee. Existing conversations are unchanged.
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
                  ? `${selected.provider}/${selected.modelId} · thinking ${selected.thinkingLevel}`
                  : role === "main"
                    ? "Host default until configured."
                    : "Not configured — select a model."}
              </p>
              {selected && (!choice || !choice.thinkingLevels.includes(selected.thinkingLevel)) && (
                <p role="status">
                  This model or thinking level is unavailable. Choose an available selection.
                </p>
              )}
              <ModelSelectorRoot
                models={data.choices.map((item) => ({
                  id: key(item),
                  name: `${item.provider}/${item.modelId}`,
                  description: item.name,
                  efforts: item.thinkingLevels.map((level) => ({ id: level, name: level })),
                }))}
                value={selected ? key(selected) : ""}
                {...(selected ? { effort: selected.thinkingLevel } : {})}
                onValueChange={(value) => {
                  const next = data.choices.find((item) => key(item) === value);
                  if (!next) return;
                  const supported =
                    selected && next.thinkingLevels.includes(selected.thinkingLevel);
                  const level = supported ? selected.thinkingLevel : next.thinkingLevels[0];
                  if (!level) return;
                  generation.current++;
                  setDraft({
                    ...draft,
                    [role]: {
                      provider: next.provider,
                      modelId: next.modelId,
                      thinkingLevel: level,
                    },
                  });
                  setNeedsEffort((old) =>
                    supported ? old.filter((item) => item !== role) : [...new Set([...old, role])],
                  );
                }}
                onEffortChange={(level) => {
                  const supported = choice?.thinkingLevels.find((item) => item === level);
                  if (!selected || !supported) return;
                  generation.current++;
                  setDraft({ ...draft, [role]: { ...selected, thinkingLevel: supported } });
                  setNeedsEffort((old) => old.filter((item) => item !== role));
                }}
              >
                <ModelSelectorTrigger
                  aria-label={`${label} model`}
                  disabled={!data.choices.length}
                />
                <ModelSelectorContent searchable />
              </ModelSelectorRoot>
              {needsEffort.includes(role) && (
                <div>
                  <p role="status">
                    Confirm a supported thinking level for this model before saving.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setNeedsEffort((old) => old.filter((item) => item !== role))}
                  >
                    Confirm thinking {selected?.thinkingLevel}
                  </Button>
                </div>
              )}
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
          !!needsEffort.length ||
          Object.values(draft).some(
            (selection) =>
              selection &&
              !data.choices.some(
                (choice) =>
                  key(choice) === key(selection) &&
                  choice.thinkingLevels.includes(selection.thinkingLevel),
              ),
          )
        }
        onClick={() => {
          void save();
        }}
      >
        Save model tiers
      </Button>
      <Button
        variant="outline"
        disabled={pending || loading}
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh saved settings
      </Button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
