import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorSearch,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorEffort,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import { supportsThinking, thinkingLabel, type Selection } from "../shared/configuration.ts";
import {
  ModelPolicySchema,
  ModelPolicyViewSchema,
  type ModelPolicyView,
  type ModelRole,
} from "../shared/model-policy.ts";
import { useChatHost } from "./chat-host.ts";

const idFor = (selection: { provider: string; modelId: string }) =>
  JSON.stringify([selection.provider, selection.modelId]);
const roleLabel: Record<ModelRole, string> = { main: "Main", tangent: "Tangent", worker: "Worker" };
const roleScope: Record<ModelRole, string> = {
  main: "Main covers main chats.",
  tangent: "Tangent covers message threads, tangents and mid-tier workers.",
  worker: "Worker covers economical workers.",
};

/** Standalone selector: Pi's role-wide policy remains the execution authority. */
export function ComposerModelSelector() {
  const host = useChatHost();
  const role = host.modelRole;
  const [open, setOpen] = useState(false);
  const selectingModel = useRef(false);
  const [data, setData] = useState<ModelPolicyView>();
  const [draft, setDraft] = useState<Selection | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);
  const visible = useRef(host.active !== false);
  visible.current = host.active !== false;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (!role || saveInFlight.current) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const response = await fetch("/api/model-policy");
      if (!response.ok) throw new Error("Unavailable");
      const next = ModelPolicyViewSchema.parse(await response.json());
      if (!mounted.current || !visible.current || sequence.current !== request) return;
      setData(next);
      setDraft(next.assignments[role]);
      setError("");
    } catch {
      if (mounted.current && visible.current && sequence.current === request)
        setError("Could not load saved models. Retry before making a selection.");
    } finally {
      if (mounted.current && sequence.current === request) setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    if (host.active !== false) void read();
    return () => {
      if (!saveInFlight.current) {
        sequence.current++;
        setLoading(false);
      }
    };
  }, [host.active, read]);

  const models = useMemo<ModelOption[]>(
    () =>
      (data?.choices ?? []).map((choice) => ({
        id: idFor(choice),
        name: choice.modelId,
        ...(choice.name !== choice.modelId ? { description: choice.name } : {}),
        keywords: [choice.provider, choice.name],
        efforts: (["default", ...choice.thinkingLevels] as const).map((level) => ({
          id: level,
          name: thinkingLabel(level),
          disabled: !supportsThinking(choice.thinkingLevels, level),
        })),
      })),
    [data],
  );
  const groups = useMemo(() => {
    const result = new Map<string, ModelOption[]>();
    for (const [index, choice] of (data?.choices ?? []).entries()) {
      const group = result.get(choice.provider) ?? [];
      const model = models[index];
      if (model) group.push(model);
      result.set(choice.provider, group);
    }
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, models]);

  if (!role || host.active === false || host.readOnly || !host.onSend) return null;
  const selected = draft && data?.choices.find((choice) => idFor(choice) === idFor(draft));
  const unchanged = JSON.stringify(draft) === JSON.stringify(data?.assignments[role]);
  const allValid =
    data &&
    Object.entries(data.assignments).every(([key, saved]) => {
      const selection = key === role ? draft : saved;
      return (
        !selection ||
        data.choices.some(
          (choice) =>
            idFor(choice) === idFor(selection) &&
            supportsThinking(choice.thinkingLevels, selection.thinkingLevel),
        )
      );
    });

  async function save() {
    if (
      !data ||
      !draft ||
      !role ||
      unchanged ||
      !allValid ||
      error ||
      saving ||
      saveInFlight.current ||
      host.mutationAllowed?.() === false
    )
      return;
    const request = ++sequence.current;
    const assignments = { ...data.assignments, [role]: draft };
    saveInFlight.current = true;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/model-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected: { revision: data.revision, assignments: data.assignments },
          assignments,
        }),
      });
      if (!response.ok) throw new Error("Not confirmed");
      const next = ModelPolicySchema.parse(await response.json());
      if (
        next.revision !== data.revision + 1 ||
        JSON.stringify(next.assignments) !== JSON.stringify(assignments)
      )
        throw new Error("Invalid acknowledgement");
      if (!mounted.current || sequence.current !== request) return;
      setData({ ...next, choices: data.choices });
      setDraft(next.assignments[role]);
      setNotice(
        `Saved ${roleLabel[role]} model for existing and new chats. In-flight requests are unchanged.`,
      );
      setOpen(false);
    } catch {
      if (mounted.current && sequence.current === request)
        setError("Save unconfirmed or settings changed. Reload saved models before trying again.");
    } finally {
      saveInFlight.current = false;
      if (mounted.current && sequence.current === request) setSaving(false);
    }
  }

  return (
    <div className="min-w-0" data-slot="composer-model-selector">
      <ModelSelectorRoot
        models={models}
        value={draft ? idFor(draft) : ""}
        effort={draft?.thinkingLevel ?? "default"}
        open={open}
        onOpenChange={(next) => {
          if (!next && selectingModel.current) {
            selectingModel.current = false;
            return;
          }
          setOpen(next);
          if (next) {
            setProvider(null);
            setNotice("");
            void read();
          }
        }}
        onValueChange={(value) => {
          if (saving || loading || error) return;
          const choice = data?.choices.find((item) => idFor(item) === value);
          if (choice && (!draft || idFor(draft) !== value))
            setDraft({
              provider: choice.provider,
              modelId: choice.modelId,
              thinkingLevel: "default",
            });
          // ModelSelectorItem closes by default; keep the chooser open for review and Apply.
          selectingModel.current = true;
        }}
        onEffortChange={(level) => {
          if (!draft || !selected || saving || loading || error) return;
          const supported =
            level === "default" ? level : selected.thinkingLevels.find((item) => item === level);
          if (supported && supportsThinking(selected.thinkingLevels, supported))
            setDraft({ ...draft, thinkingLevel: supported });
        }}
      >
        <ModelSelectorTrigger
          aria-label={`${roleLabel[role]} role model`}
          variant="ghost"
          size="sm"
          className="max-w-[min(15rem,45vw)] text-muted-foreground"
        >
          <span className="truncate">
            {data?.assignments[role]
              ? `${data.assignments[role].provider}/${data.assignments[role].modelId}`
              : loading
                ? "Loading model…"
                : data
                  ? "Host default"
                  : "Model unavailable"}
          </span>
        </ModelSelectorTrigger>
        <ModelSelectorContent side="top" className="w-[26rem] max-w-[calc(100vw-2rem)]" searchable>
          <div className="border-b px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{roleLabel[role]} role model</p>
            <p>{roleScope[role]}</p>
            <p>
              Configured:{" "}
              {data?.assignments[role]
                ? `${data.assignments[role].provider}/${data.assignments[role].modelId} · ${thinkingLabel(data.assignments[role].thinkingLevel)}`
                : "Host default"}
            </p>
            <p>
              Apply updates configured roles across existing and new chats and workers. In-flight
              requests are unchanged.
            </p>
          </div>
          <ModelSelectorSearch aria-label="Search models" />
          {groups.length > 1 && (
            <div
              className="flex max-w-full gap-1 overflow-x-auto border-b px-3 py-2"
              role="group"
              aria-label="Filter by provider"
            >
              <Button
                type="button"
                size="sm"
                variant={provider === null ? "secondary" : "ghost"}
                aria-pressed={provider === null}
                onClick={() => setProvider(null)}
              >
                All
              </Button>
              {groups.map(([name]) => (
                <Button
                  key={name}
                  type="button"
                  size="sm"
                  variant={provider === name ? "secondary" : "ghost"}
                  aria-pressed={provider === name}
                  onClick={() => setProvider(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
          <ModelSelectorList>
            <ModelSelectorEmpty>
              {loading ? "Loading models…" : "No matching models."}
            </ModelSelectorEmpty>
            {groups
              .filter(([name]) => provider === null || provider === name)
              .map(([name, options]) => (
                <ModelSelectorGroup key={name} heading={name}>
                  {options.map((option) => (
                    <ModelSelectorItem key={option.id} model={option} />
                  ))}
                </ModelSelectorGroup>
              ))}
          </ModelSelectorList>
          <ModelSelectorEffort />
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {data && draft && !selected && (
            <p role="status" className="px-3 py-2 text-xs">
              This model is unavailable. Choose an available model.
            </p>
          )}
          {data && !allValid && (
            <p role="status" className="px-3 py-2 text-xs">
              A saved role is unavailable. Review all model tiers in settings.
            </p>
          )}
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || saving}
              onClick={() => {
                void read();
              }}
            >
              Reload
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={
                !data ||
                !draft ||
                unchanged ||
                !allValid ||
                !!error ||
                loading ||
                saving ||
                host.mutationAllowed?.() === false
              }
              onClick={() => {
                void save();
              }}
            >
              {saving ? "Applying…" : "Apply role model"}
            </Button>
          </div>
        </ModelSelectorContent>
      </ModelSelectorRoot>
      {notice && (
        <span className="sr-only" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}
