import { useEffect, useState } from "react";
import { z } from "zod";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { TangentViewSchema, type TangentView } from "../../shared/tangents.ts";
import { ChatPage } from "../chat-page.tsx";
import { tangentChildView } from "./adapter.ts";
import { TangentWorkspace } from "./workspace.tsx";
import { WorkerPanel } from "../workers/panel.tsx";

const ResponseSchema = z.strictObject({ tangents: z.array(TangentViewSchema) });

export function MainThreadView({
  mainId,
  title,
  active,
  readOnly,
  selectedTangent,
  onSelectTangent,
  onCloseTangent,
  onFork,
}: {
  mainId: string;
  title: string;
  active: boolean;
  readOnly: boolean;
  selectedTangent: string | undefined;
  onSelectTangent: (id: string) => void;
  onCloseTangent: () => void;
  onFork: (entryId: number) => void;
}) {
  const [items, setItems] = useState<TangentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const response = await fetch(`/api/chats/${mainId}/tangents`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unavailable");
        const result = ResponseSchema.parse(await response.json());
        if (
          result.tangents.some((item) => String(item.parentId) !== mainId) ||
          new Set(result.tangents.map((item) => item.id)).size !== result.tangents.length
        )
          throw new Error("Invalid ownership");
        if (alive) {
          setItems(result.tangents);
          setLoaded(true);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
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
  }, [mainId, active, retry]);

  const validId =
    selectedTangent !== undefined &&
    /^[1-9][0-9]*$/.test(selectedTangent) &&
    Number.isSafeInteger(Number(selectedTangent));
  const selected = validId
    ? items.find((item) => String(item.id) === selectedTangent && item.lifecycle === "open")
    : undefined;
  const invalidSelection =
    active && selectedTangent !== undefined && (!validId || (loaded && !error && !selected));
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && active && (
        <ErrorState
          title="Tangents unavailable"
          detail="The child list could not be refreshed. Existing views are retained; selection is disabled until it reconnects."
          retrying={false}
          onRetry={() => setRetry((value) => value + 1)}
        />
      )}
      {invalidSelection && (
        <ErrorState
          title="Tangent not found"
          detail="This tangent is not an open child of this main chat."
          actionLabel="Close tangent"
          retrying={false}
          onRetry={onCloseTangent}
        />
      )}
      <TangentWorkspace
        main={{ id: mainId, title }}
        tangents={items.map(tangentChildView)}
        workers={[]}
        selectedTangentId={active && selected ? String(selected.id) : null}
        navigationDisabled={error}
        onSelectTangent={onSelectTangent}
        onCloseTangent={onCloseTangent}
        renderMain={(visible) => (
          <div className="flex min-h-0 flex-1 flex-col">
            <WorkerPanel chatId={mainId} active={active && visible} readOnly={readOnly} />
            <ChatPage
              chatId={mainId}
              active={active && visible}
              readOnly={readOnly}
              onFork={onFork}
            />
          </div>
        )}
        renderTangent={(tangent, visible) => (
          <div className="flex min-h-0 flex-1 flex-col">
            <WorkerPanel
              chatId={tangent.id}
              active={active && visible}
              readOnly={
                readOnly || (items.find((item) => String(item.id) === tangent.id)?.readOnly ?? true)
              }
            />
            <ChatPage
              chatId={tangent.id}
              active={active && visible}
              readOnly={
                readOnly || (items.find((item) => String(item.id) === tangent.id)?.readOnly ?? true)
              }
            />
          </div>
        )}
      />
    </div>
  );
}
