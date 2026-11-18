import { useState } from "react";
import {
  ElicitationForm,
  type ElicitationField,
} from "./components/assistant-ui/elements/elicitation-form";
import { AgentStatus } from "./components/assistant-ui/elements/agent-status";
import { ErrorState } from "./components/assistant-ui/elements/error-state";
import {
  normalizeResolution,
  QuestionViewSchema,
  type QuestionView,
  type Resolution,
} from "../shared/questions";

/** Caller must refresh the validated host projection after any resolution; no optimistic receipt. */
export function AgentQuestion({
  question,
  onResolve,
}: {
  question: unknown;
  onResolve: (question: QuestionView, resolution: Resolution) => Promise<void>;
}) {
  const parsed = QuestionViewSchema.safeParse(question);
  if (!parsed.success || parsed.data.cancelled) return null;
  return (
    <QuestionForm
      key={`${parsed.data.questionId}:${parsed.data.revision}`}
      question={parsed.data}
      onResolve={onResolve}
    />
  );
}
function QuestionForm({
  question,
  onResolve,
}: {
  question: QuestionView;
  onResolve: (question: QuestionView, resolution: Resolution) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>(() => {
    const initial: Record<string, string | string[]> = Object.create(null) as Record<
      string,
      string | string[]
    >;
    for (const field of question.spec.fields)
      if (field.default !== undefined) initial[field.id] = field.default;
    if (question.resolution?.kind === "answer") return question.resolution.values;
    return initial;
  });
  const [pending, setPending] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [failed, setFailed] = useState<Resolution | null>(null);
  const fields: ElicitationField[] = question.spec.fields.flatMap((field): ElicitationField[] => {
    const current = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    if (field.kind === "text")
      return [
        {
          name: field.id,
          label: field.label,
          kind: "text",
          value: typeof current === "string" ? current : "",
          required: field.required ?? false,
        },
      ];
    if (field.kind === "choice")
      return [
        {
          name: field.id,
          label: field.label,
          kind: "choice",
          value: field.options.find((o) => o.id === current)
            ? `${field.options.find((o) => o.id === current)!.label} (${current as string})`
            : "",
          options: field.options.map((o) => `${o.label} (${o.id})`),
          required: field.required ?? false,
        },
      ];
    return field.options.map((option) => ({
      name: `${field.id}/${option.id}`,
      label: `${field.label}: ${option.label}`,
      kind: "toggle",
      value: Array.isArray(current) && current.includes(option.id) ? "true" : "false",
    }));
  });
  async function send(resolution: Resolution) {
    setPending(true);
    setFailed(null);
    try {
      await onResolve(question, resolution);
      setAwaitingRefresh(true);
    } catch {
      setFailed(resolution);
    } finally {
      setPending(false);
    }
  }
  function change(name: string, value: string) {
    setInvalid(false);
    const [fieldId, optionId] = name.split("/");
    const field = question.spec.fields.find((item) => item.id === fieldId);
    if (!field || !fieldId) return;
    if (field.kind === "multi" && optionId) {
      setValues((before) => {
        const old = before[fieldId];
        const selected = Array.isArray(old) ? old : [];
        return {
          ...before,
          [fieldId]:
            value === "true"
              ? [...selected, optionId]
              : selected.filter((item) => item !== optionId),
        };
      });
    } else if (field.kind === "choice") {
      const option = field.options.find((o) => `${o.label} (${o.id})` === value);
      if (option) setValues((before) => ({ ...before, [fieldId]: option.id }));
    } else if (field.kind === "text") setValues((before) => ({ ...before, [fieldId]: value }));
  }
  const state =
    question.status === "answered"
      ? "accepted"
      : question.status === "declined"
        ? "declined"
        : "request";
  return (
    <>
      <fieldset disabled={!question.actionable || pending || awaitingRefresh || failed !== null}>
        <ElicitationForm
          server="Assistant"
          message={question.spec.message}
          fields={fields}
          state={state}
          onFieldChange={question.actionable ? change : undefined}
          onAccept={() => {
            try {
              void send(normalizeResolution(question.spec, { kind: "answer", values }));
            } catch {
              setInvalid(true);
            }
          }}
          onDecline={() => {
            void send({ kind: "decline" });
          }}
        />
      </fieldset>
      {invalid && <AgentStatus state="failed" label="Complete required fields" role="alert" />}
      {failed && (
        <ErrorState
          title="Answer not confirmed"
          detail="Retry the same response or refresh the question state."
          retrying={pending}
          onRetry={() => {
            void send(failed);
          }}
        />
      )}
    </>
  );
}
