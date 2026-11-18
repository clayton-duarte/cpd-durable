import { useEffect, useRef, useState } from "react";
import {
  ApiErrorSchema,
  ChatStateSchema,
  SubmissionSchema,
  WithdrawResultSchema,
  type HistoryGap,
  type ChatInput,
  type ChatControl,
  type ChatState,
  type SendMode,
} from "../shared/chat.ts";
import type { DraftAdmission } from "../shared/drafts.ts";

type Request =
  | { path: "/api/input"; body: ChatInput; onClear?: (revision: number) => void }
  | { path: "/api/control"; body: ChatControl }
  | { path: "/api/withdraw"; body: { id: string } }
  | { path: "/api/stop"; body?: never };

export function useChat(chatId?: string, observing = true) {
  const base = chatId === undefined ? "/api" : `/api/chats/${chatId}`;
  const [state, setState] = useState<ChatState | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<Request | null>(null);
  const uncertain = useRef<Request | null>(null);
  const inFlight = useRef(false);
  const [view] = useState(() => crypto.randomUUID());
  const [oldest, setOldest] = useState<number>();
  const accepted = useRef<ChatState | null>(null);
  const retired = useRef(new Set<string>());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyInFlight = useRef(false);
  const historyRetry = useRef<HistoryGap | undefined>(undefined);
  const [historyGap, setHistoryGap] = useState<HistoryGap>();

  function accept(next: ChatState) {
    if (chatId !== undefined && String(next.conversationId) !== chatId)
      throw new Error("Mismatched conversation");
    const previous = accepted.current?.history;
    if (next.history) {
      if (next.history.view !== view) throw new Error("Mismatched history view");
      if (retired.current.has(next.history.epoch)) return;
      if (previous?.epoch === next.history.epoch && next.history.revision <= previous.revision)
        return;
      if (previous && previous.epoch !== next.history.epoch) retired.current.add(previous.epoch);
      setOldest(next.history.oldest);
    }
    accepted.current = next;
    setState(next);
  }

  useEffect(() => {
    if (!observing) {
      setConnected(false);
      return;
    }
    let active = true;
    const source = new EventSource(
      `${base}/events?view=${view}${oldest === undefined ? "" : `&oldest=${oldest}`}`,
    );
    source.addEventListener("state", (event: MessageEvent<string>) => {
      if (!active) return;
      try {
        accept(ChatStateSchema.parse(JSON.parse(event.data)));
        setConnected(true);
        // Recover a rejected frame without erasing an uncertain operation's retry.
        setError((current) =>
          current === "Received an invalid conversation update." ? null : current,
        );
      } catch {
        setConnected(false);
        setError("Received an invalid conversation update.");
      }
    });
    source.addEventListener("unavailable", () => {
      if (active) setConnected(false);
    });
    source.onerror = () => {
      if (active) setConnected(false);
    };
    return () => {
      active = false;
      source.close();
    };
  }, [base, observing, view, oldest]);

  async function loadHistory(gap?: HistoryGap) {
    if (historyInFlight.current || !connected || !accepted.current?.history) return;
    historyInFlight.current = true;
    setHistoryLoading(true);
    setHistoryGap(gap);
    historyRetry.current = gap;
    setHistoryError(null);
    try {
      const response = await fetch(`${base}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view, ...(gap ? { gap } : {}) }),
      });
      if (!response.ok) throw new Error("History unavailable");
      accept(ChatStateSchema.parse(await response.json()));
    } catch {
      const current = accepted.current;
      const gapStillMissing =
        !gap ||
        current?.history?.gaps.some((item) => item.after < gap.upTo && gap.after < item.upTo);
      if (gapStillMissing)
        setHistoryError("History could not be loaded. Retry without resending any message.");
    } finally {
      historyInFlight.current = false;
      setHistoryLoading(false);
    }
  }

  async function perform(request: Request): Promise<boolean> {
    if (inFlight.current || (uncertain.current && uncertain.current !== request)) return false;
    inFlight.current = true;
    uncertain.current = request;
    setPending(true);
    setError(null);
    setNotice(null);
    setRetry(request);
    try {
      const response = await fetch(`${base}${request.path.slice(4)}`, {
        method: "POST",
        ...(request.body
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) }
          : {}),
      });
      if (!response.ok) {
        const body: unknown = await response.json();
        setError(
          request.path === "/api/stop"
            ? "Stop could not be confirmed. Check current state before using Stop again."
            : ApiErrorSchema.parse(body).error,
        );
        if (response.status < 500 || request.path === "/api/stop") {
          uncertain.current = null;
          setRetry(null);
        }
        return false;
      }
      if (request.path === "/api/withdraw") {
        const { status } = WithdrawResultSchema.parse(await response.json());
        setNotice(
          status === "aborted"
            ? "Queued input withdrawn."
            : status === "already_placed"
              ? "Input was already placed; it was not withdrawn."
              : status === "settled"
                ? "Input has already settled."
                : "Queued input was not found.",
        );
      } else if (request.path !== "/api/stop") {
        const submission = SubmissionSchema.parse(await response.json());
        if (request.path === "/api/input" && submission.clearedDraftRevision !== undefined)
          request.onClear?.(submission.clearedDraftRevision);
        if (request.path === "/api/control") {
          setNotice(
            request.body.type === "reset"
              ? "Context reset admitted. If busy, it takes effect at the next boundary. Stored history is retained."
              : "Continue admitted; waiting for the conversation update.",
          );
        } else if (request.body.mode === "steer") {
          setNotice(
            "Steering input admitted. It takes effect at an eligible boundary, not immediately.",
          );
        } else if (request.body.mode === "followUp") {
          setNotice("Follow-up input admitted. If busy, it waits for the current response.");
        }
      }
      uncertain.current = null;
      setRetry(null);
      return true;
    } catch {
      if (request.path === "/api/stop") {
        // Abort targets current scope, not a request ID: retrying later could stop newer work.
        uncertain.current = null;
        setRetry(null);
        setError("Stop could not be confirmed. Check current state before using Stop again.");
      } else {
        setError("Delivery could not be confirmed. Retry the original action safely.");
      }
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function send(
    text: string,
    mode: SendMode = "reject",
    images: string[] = [],
    prepared?: { requestId: string; draft: DraftAdmission; onClear?: (revision: number) => void },
  ) {
    const previous = uncertain.current;
    if (previous?.path === "/api/input") {
      if (prepared && previous.body.requestId !== prepared.requestId) return Promise.resolve(false);
      return perform(previous);
    }
    return perform({
      path: "/api/input",
      body: {
        text,
        mode,
        ...(images.length ? { images } : {}),
        requestId: prepared?.requestId ?? crypto.randomUUID(),
        ...(prepared ? { draft: prepared.draft } : {}),
      },
      ...(prepared?.onClear ? { onClear: prepared.onClear } : {}),
    });
  }

  return {
    state,
    historyLoading,
    historyError,
    historyGap,
    retryHistory: () => loadHistory(historyRetry.current),
    loadEarlier: () => loadHistory(),
    fillGap: (gap: HistoryGap) => loadHistory(gap),
    connected,
    pending,
    error,
    notice,
    uncertain: retry !== null,
    retryText: retry?.path === "/api/input" ? retry.body.text : null,
    retryAction: retry !== null && retry.path !== "/api/input",
    retryRequest: () => (uncertain.current ? perform(uncertain.current) : Promise.resolve(false)),
    send,
    stop: async () => {
      await perform({ path: "/api/stop" });
    },
    continueRun: () =>
      perform({ path: "/api/control", body: { type: "continue", requestId: crypto.randomUUID() } }),
    reset: (handoff: string) =>
      perform({
        path: "/api/control",
        body: { type: "reset", handoff, requestId: crypto.randomUUID() },
      }),
    withdraw: async (id: string) => {
      await perform({ path: "/api/withdraw", body: { id } });
    },
  };
}
