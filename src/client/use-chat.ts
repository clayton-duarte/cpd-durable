import { useEffect, useState } from "react";
import {
  ApiErrorSchema,
  ChatStateSchema,
  SubmissionSchema,
  type ChatInput,
  type ChatState,
} from "../shared/chat.ts";

export function useChat() {
  const [state, setState] = useState<ChatState | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<ChatInput | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("state", (event: MessageEvent<string>) => {
      try {
        setState(ChatStateSchema.parse(JSON.parse(event.data)));
        setConnected(true);
      } catch {
        setConnected(false);
        setError("Received an invalid conversation update.");
      }
    });
    source.addEventListener("unavailable", () => setConnected(false));
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  async function send(text: string) {
    // Reuse the ID after an ambiguous network failure, not after a definite rejection.
    const input = retry?.text === text ? retry : { text, requestId: crypto.randomUUID() };
    setPending(true);
    setError(null);
    setRetry(input);
    try {
      const response = await fetch("/api/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(ApiErrorSchema.parse(body).error);
        if (response.status < 500) setRetry(null);
        return false;
      }
      SubmissionSchema.parse(body);
      setRetry(null);
      return true;
    } catch {
      setError("Delivery could not be confirmed. Send the same text to retry safely.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function stop() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/stop", { method: "POST" });
      if (!response.ok) setError("Could not stop the response. Try again.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return { state, connected, pending, error, send, stop };
}
