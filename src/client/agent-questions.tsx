import { useCallback, useEffect, useRef, useState } from "react";
import { useChatHost } from "./chat-host.ts";
import { AgentQuestion } from "./agent-question.tsx";
import { ErrorState } from "./components/assistant-ui/elements/error-state";
import {
  QuestionProjectionSchema,
  type QuestionView,
  type Resolution,
} from "../shared/questions.ts";

/** Scoped read-only observation never submits chat input. Each mounted chat retains its own form. */
export function AgentQuestions() {
  const host = useChatHost();
  const [projection, setProjection] = useState<{
    id: string;
    epoch: number;
    questions: QuestionView[];
  }>();
  const [readError, setReadError] = useState(false);
  const current = useRef({
    epoch: 0,
    sequence: 0,
    writing: false,
    controller: undefined as AbortController | undefined,
  });
  const id = host.chatId;
  const enabled = id !== undefined && host.active !== false && host.connected;
  const refresh = useCallback(async () => {
    if (!id || !enabled) throw new Error("Question view unavailable");
    const state = current.current;
    const epoch = state.epoch;
    const sequence = ++state.sequence;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(id)}/questions`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Question read unavailable");
      const projection = QuestionProjectionSchema.parse(await response.json());
      if (projection.conversationId !== id || epoch !== state.epoch || sequence !== state.sequence)
        throw new Error("Stale question view");
      setProjection({ id, epoch, questions: projection.questions });
      setReadError(false);
    } catch (error) {
      if (!controller.signal.aborted && epoch === state.epoch && sequence === state.sequence)
        setReadError(true);
      throw error;
    }
  }, [id, enabled]);
  useEffect(() => {
    const state = current.current;
    state.epoch++;
    state.sequence++;
    state.controller?.abort();
    if (!enabled)
      return () => {
        state.epoch++;
        state.controller?.abort();
      };
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!state.writing) await refresh();
      } catch {
        /* Keep last known state, never infer a decline. */
      }
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      state.epoch++;
      state.sequence++;
      state.controller?.abort();
    };
  }, [enabled, id, refresh]);
  const resolve = useCallback(
    async (question: QuestionView, resolution: Resolution) => {
      if (!id || !enabled || host.readOnly || !host.onSend || readError)
        throw new Error("Question is read-only");
      const state = current.current;
      const epoch = state.epoch;
      state.writing = true;
      state.sequence++;
      state.controller?.abort();
      try {
        const response = await fetch(`/api/chats/${encodeURIComponent(id)}/questions/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            questionId: question.questionId,
            taskId: question.taskId,
            revision: question.revision,
            resolution,
          }),
        });
        if (!response.ok || epoch !== state.epoch) throw new Error("Question answer not confirmed");
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          !["resolved", "already-resolved"].includes(String(Reflect.get(result, "status")))
        )
          throw new Error("Invalid answer confirmation");
        await refresh();
      } finally {
        state.writing = false;
      }
    },
    [id, enabled, host.readOnly, host.onSend, refresh, readError],
  );
  const visible = (projection && projection.id === id ? projection.questions : []).filter(
    (question) => question.status === "pending" && !question.cancelled,
  );
  if (!id || visible.length === 0) return null;
  return (
    <div hidden={host.active === false}>
      {readError && enabled && (
        <ErrorState
          title="Question state unavailable"
          detail="The visible question may be stale. Refresh before answering."
          retrying={false}
          onRetry={() => {
            void refresh().catch(() => {});
          }}
        />
      )}
      {visible.map((question) => (
        <AgentQuestion
          key={question.questionId}
          question={{
            ...question,
            actionable:
              question.actionable &&
              enabled &&
              projection?.epoch === current.current.epoch &&
              !readError &&
              !host.readOnly &&
              !!host.onSend,
          }}
          onResolve={resolve}
          onRefresh={refresh}
        />
      ))}
    </div>
  );
}
