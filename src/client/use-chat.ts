import { useEffect, useRef, useState } from "react";
import {
  ApiErrorSchema,
  ChatStateSchema,
  SubmissionSchema,
  WithdrawResultSchema,
  type ChatInput,
  type ChatControl,
  type ChatState,
  type SendMode,
} from "../shared/chat.ts";

type Request =
  | { path: "/api/input"; body: ChatInput }
  | { path: "/api/control"; body: ChatControl }
  | { path: "/api/withdraw"; body: { id: string } }
  | { path: "/api/stop"; body?: never };

export function useChat() {
  const [state, setState] = useState<ChatState | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<Request | null>(null);
  const uncertain = useRef<Request | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("state", (event: MessageEvent<string>) => {
      try {
        setState(ChatStateSchema.parse(JSON.parse(event.data)));
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
    source.addEventListener("unavailable", () => setConnected(false));
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  async function perform(request: Request): Promise<boolean> {
    if (inFlight.current || (uncertain.current && uncertain.current !== request)) return false;
    inFlight.current = true;
    uncertain.current = request;
    setPending(true);
    setError(null);
    setNotice(null);
    setRetry(request);
    try {
      const response = await fetch(request.path, {
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
        SubmissionSchema.parse(await response.json());
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

  function send(text: string, mode: SendMode = "reject") {
    const previous = uncertain.current;
    if (previous?.path === "/api/input" && previous.body.text === text) return perform(previous);
    return perform({ path: "/api/input", body: { text, mode, requestId: crypto.randomUUID() } });
  }

  return {
    state,
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
