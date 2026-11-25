import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { TangentViewSchema, type TangentView } from "../../shared/tangents.ts";
import type { ThreadView } from "../../shared/threads.ts";
import { ChatPage } from "../chat-page.tsx";
import { tangentChildView } from "./adapter.ts";
import { TangentWorkspace } from "./workspace.tsx";
import { WorkerPanel } from "../workers/panel.tsx";
import { ModelPolicyViewSchema } from "../../shared/model-policy.ts";
import { Button } from "@/components/ui/button";
import { HandoffPreview } from "./handoff-preview";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReturnReview } from "./return-review.tsx";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/assistant-ui/elements/collapsible-root";

const ResponseSchema = z.strictObject({ tangents: z.array(TangentViewSchema) });
const StartResponseSchema = z.strictObject({ tangent: TangentViewSchema });

function StartPanel({
  parentId,
  item,
  disabled,
  mutationAllowed,
  onStarted,
}: {
  parentId: string;
  item: TangentView;
  disabled: boolean;
  mutationAllowed: () => boolean;
  onStarted: (item: TangentView) => void;
}) {
  const request = useRef<string | null>(null);
  const pending = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item.startState === "admitted") return null;
  async function start() {
    if (pending.current || disabled || !mutationAllowed() || item.latestHandoff.kind !== "delegate")
      return;
    pending.current = true;
    setWaiting(true);
    request.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/chats/${parentId}/tangents/${item.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.current,
          expectedHandoffRevision: item.latestHandoff.revision,
        }),
      });
      if (!response.ok) throw new Error();
      const result = StartResponseSchema.parse(await response.json()).tangent;
      if (
        result.id !== item.id ||
        String(result.parentId) !== parentId ||
        result.startState !== "admitted"
      )
        throw new Error();
      onStarted(result);
      setError(null);
    } catch {
      setError(
        "Start could not be confirmed. Retry uses the same request identity; check settings or preparation if it remains unavailable.",
      );
    } finally {
      pending.current = false;
      setWaiting(false);
    }
  }
  return (
    <section aria-label="Initial tangent handoff">
      <p>
        Start the tangent with its selected handoff before sending a message. Your draft will remain
        here.
      </p>
      {item.latestHandoff.kind === "delegate" && (
        <HandoffPreview
          handoff={item.latestHandoff.handoff}
          kind="delegate"
          placed={false}
          original={JSON.stringify(item.latestHandoff.handoff, null, 2)}
          originalLabel="Initial handoff"
        />
      )}
      {error && <p role="alert">{error}</p>}
      <Button
        type="button"
        disabled={disabled || waiting || item.latestHandoff.kind !== "delegate"}
        onClick={() => {
          void start();
        }}
      >
        {waiting ? "Starting…" : "Start tangent"}
      </Button>
    </section>
  );
}

export function MainThreadView({
  mainId,
  title,
  focusComposer,
  active,
  readOnly,
  settingsTarget,
  threads,
  highlightsEntryId,
  onReplyInThread,
  selectedTangent,
  onSelectTangent,
  onCloseTangent,
  onFork,
  onRegenerate,
  onEdit,
  draftGuards,
  onUnsavedDraft,
}: {
  mainId: string;
  title: string;
  focusComposer?: number | undefined;
  active: boolean;
  readOnly: boolean;
  settingsTarget: HTMLElement | null;
  threads: readonly ThreadView[] | null | undefined;
  highlightsEntryId: string | undefined;
  onReplyInThread: (entryId: number, quote?: string) => void;
  selectedTangent: string | undefined;
  onSelectTangent: (id: string) => void;
  onCloseTangent: () => void;
  onFork: (entryId: number) => void;
  onRegenerate: (entryId: number) => void;
  onEdit: (entryId: number, text: string) => void;
  draftGuards: React.RefObject<Map<string, () => Promise<boolean>>>;
  onUnsavedDraft: (chatId: string) => void;
}) {
  const [items, setItems] = useState<TangentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const stale = useRef(false);
  const parentReadOnly = useRef(readOnly);
  const childWritable = useRef(new Map<string, boolean>());
  parentReadOnly.current = readOnly;
  const childMutationAllowed = (id: string) =>
    !stale.current && !parentReadOnly.current && childWritable.current.get(id) === true;
  const [retry, setRetry] = useState(0);
  const [configured, setConfigured] = useState(false);
  const mutationVersion = useRef(0);
  const mutationPending = useRef(false);
  const [changing, setChanging] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || readOnly) {
      setConfigured(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    async function refreshPolicy() {
      try {
        const response = await fetch("/api/model-policy", { signal: controller.signal });
        if (!response.ok) throw new Error();
        const policy = ModelPolicyViewSchema.parse(await response.json());
        if (alive) setConfigured(policy.assignments.tangent !== null);
      } catch {
        if (alive) setConfigured(false);
      } finally {
        if (alive)
          timer = setTimeout(() => {
            void refreshPolicy();
          }, 2000);
      }
    }
    void refreshPolicy();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, readOnly]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      const version = mutationVersion.current;
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
        if (alive && version === mutationVersion.current) {
          childWritable.current = new Map(
            result.tangents.map((item) => [String(item.id), !item.readOnly]),
          );
          setItems((current) =>
            result.tangents.map((item) =>
              current.some((prior) => prior.id === item.id && prior.startState === "admitted")
                ? { ...item, startState: "admitted" }
                : item,
            ),
          );
          setLoaded(true);
          stale.current = false;
          setError(false);
        }
      } catch {
        if (alive && version === mutationVersion.current) {
          stale.current = true;
          setError(true);
        }
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
  const selected = validId ? items.find((item) => String(item.id) === selectedTangent) : undefined;
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
          detail="This tangent is not a child of this main chat."
          actionLabel="Close tangent"
          retrying={false}
          onRetry={onCloseTangent}
        />
      )}
      {items.some((item) => item.lifecycle !== "open") && (
        <CollapsibleRoot>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            Completed and archived tangents
          </CollapsibleTrigger>
          <CollapsibleContent>
            {items
              .filter((item) => item.lifecycle !== "open")
              .map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  disabled={error}
                  onClick={() => onSelectTangent(String(item.id))}
                >
                  {item.title} · {item.lifecycle === "concluded" ? "Concluded" : "Archived"} ·{" "}
                  {item.model.name ?? `${item.model.provider}/${item.model.modelId}`}
                </Button>
              ))}
          </CollapsibleContent>
        </CollapsibleRoot>
      )}
      {lifecycleError && <p role="alert">{lifecycleError}</p>}
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
              modelRole="main"
              focusComposer={focusComposer}
              active={active && visible}
              readOnly={readOnly}
              settingsTarget={settingsTarget}
              settingsIncludeDefaults
              canRequestTangent={configured}
              threads={threads}
              highlightsEntryId={highlightsEntryId}
              onReplyInThread={onReplyInThread}
              onFork={onFork}
              onRegenerate={onRegenerate}
              onEdit={onEdit}
              draftGuards={draftGuards}
              onUnsavedDraft={onUnsavedDraft}
            />
          </div>
        )}
        renderTangent={(tangent, visible) => (
          <div className="flex min-h-0 flex-1 flex-col">
            {items
              .filter((item) => String(item.id) === tangent.id)
              .map((item) =>
                item.latestHandoff.kind === "return" ? (
                  <ReturnReview
                    key={`return-${item.id}-${item.latestHandoff.revision}`}
                    parentId={mainId}
                    item={item}
                    active={active && visible}
                    readOnly={readOnly || item.lifecycle === "archived" || error}
                    mutationAllowed={() => !stale.current && !parentReadOnly.current}
                  />
                ) : null,
              )}
            {items
              .filter((item) => String(item.id) === tangent.id)
              .map((item) => (
                <StartPanel
                  key={item.id}
                  parentId={mainId}
                  item={item}
                  disabled={readOnly || item.readOnly || error}
                  mutationAllowed={() => childMutationAllowed(tangent.id)}
                  onStarted={(started) => {
                    childWritable.current.set(String(started.id), !started.readOnly);
                    setItems((current) =>
                      current.map((entry) => (entry.id === started.id ? started : entry)),
                    );
                  }}
                />
              ))}
            {items
              .filter((item) => String(item.id) === tangent.id)
              .map((item) => (
                <div key={`lifecycle-${item.id}`}>
                  <span className="text-muted-foreground text-xs">Tangent · {item.lifecycle}</span>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                      Tangent actions
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {(item.lifecycle === "open"
                        ? (["concluded", "archived"] as const)
                        : item.lifecycle === "concluded"
                          ? (["open", "archived"] as const)
                          : (["open"] as const)
                      ).map((next) => (
                        <DropdownMenuItem
                          key={next}
                          disabled={
                            readOnly ||
                            (item.lifecycle === "open" && item.readOnly) ||
                            error ||
                            changing
                          }
                          onClick={() => {
                            if (
                              mutationPending.current ||
                              stale.current ||
                              parentReadOnly.current ||
                              (item.lifecycle === "open" && !childMutationAllowed(tangent.id))
                            )
                              return;
                            mutationPending.current = true;
                            mutationVersion.current++;
                            setChanging(true);
                            setLifecycleError(null);
                            void (async () => {
                              try {
                                if (
                                  next !== "open" &&
                                  !((await draftGuards.current.get(tangent.id)?.()) ?? true)
                                ) {
                                  onUnsavedDraft(tangent.id);
                                  return;
                                }
                                if (
                                  stale.current ||
                                  parentReadOnly.current ||
                                  (item.lifecycle === "open" && !childMutationAllowed(tangent.id))
                                )
                                  return;
                                const response = await fetch(
                                  `/api/chats/${mainId}/tangents/${item.id}/lifecycle`,
                                  {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ expected: item.lifecycle, next }),
                                  },
                                );
                                if (!response.ok)
                                  throw new Error(
                                    response.status === 409
                                      ? "Tangent lifecycle changed or work is still active. Refresh and try again explicitly."
                                      : "Lifecycle change could not be confirmed.",
                                  );
                                const result = StartResponseSchema.parse(
                                  await response.json(),
                                ).tangent;
                                if (
                                  result.id !== item.id ||
                                  String(result.parentId) !== mainId ||
                                  result.lifecycle !== next
                                )
                                  throw new Error("Lifecycle response could not be confirmed.");
                                childWritable.current.set(String(result.id), !result.readOnly);
                                setItems((current) =>
                                  current.map((entry) => (entry.id === result.id ? result : entry)),
                                );
                              } catch (err) {
                                setLifecycleError(
                                  err instanceof Error
                                    ? err.message
                                    : "Lifecycle change could not be confirmed.",
                                );
                              } finally {
                                mutationVersion.current++;
                                mutationPending.current = false;
                                setChanging(false);
                                setRetry((value) => value + 1);
                              }
                            })();
                          }}
                        >
                          {next === "concluded"
                            ? "Conclude tangent"
                            : next === "archived"
                              ? "Archive tangent"
                              : "Reopen tangent"}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            <WorkerPanel
              chatId={tangent.id}
              active={active && visible}
              readOnly={
                readOnly ||
                error ||
                (items.find((item) => String(item.id) === tangent.id)?.readOnly ?? true)
              }
              mutationAllowed={() => childMutationAllowed(tangent.id)}
            />
            <ChatPage
              chatId={tangent.id}
              modelRole="tangent"
              draftGuards={draftGuards}
              onUnsavedDraft={onUnsavedDraft}
              active={active && visible}
              readOnly={
                readOnly ||
                error ||
                (items.find((item) => String(item.id) === tangent.id)?.readOnly ?? true)
              }
              mutationAllowed={() => childMutationAllowed(tangent.id)}
              inputBlockedReason={
                items.find((item) => String(item.id) === tangent.id)?.startState === "admitted"
                  ? undefined
                  : "Start tangent with its handoff first."
              }
            />
          </div>
        )}
      />
    </div>
  );
}
