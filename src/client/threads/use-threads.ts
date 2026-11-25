import { useCallback, useEffect, useState } from "react";
import { ThreadListSchema, type ThreadView } from "../../shared/threads.ts";

/**
 * Application thread index for one chat. Reads never fork, admit input or start
 * a run; a failed read keeps the last visible list and reports itself as stale.
 */
export function useThreads(chatId: string | undefined, active: boolean) {
  const [threads, setThreads] = useState<ThreadView[] | null>(null);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!chatId || !active) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const response = await fetch(`/api/chats/${chatId}/threads`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unavailable");
        const result = ThreadListSchema.parse(await response.json());
        if (result.threads.some((thread) => thread.parentId !== chatId)) throw new Error("Scope");
        if (!alive) return;
        setThreads(result.threads);
        setStale(false);
      } catch {
        if (alive) setStale(true);
      } finally {
        if (alive)
          timer = setTimeout(() => {
            void refresh();
          }, 2000);
      }
    }
    void refresh();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [chatId, active, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { threads, stale, refresh };
}
