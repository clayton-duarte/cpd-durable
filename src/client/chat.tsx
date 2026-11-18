import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalMessageConverter,
  useExternalStoreRuntime,
  useAssistantDataUI,
  useAuiState,
  type ToolCallMessagePartProps,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import {
  ToolFallback,
  ToolFallbackWithResult,
} from "@/components/assistant-ui/elements/tool-fallback.aui";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Image } from "@/components/assistant-ui/elements/image";
import { DataTable } from "@/components/assistant-ui/elements/data-table";
import { TableDetailsSchema } from "../shared/structured-table.ts";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import {
  ToolResultPartSchema,
  ToolStateSchema,
  type SendMode,
  type HistoryGap,
} from "../shared/chat.ts";
import { AttachmentIdSchema } from "../shared/attachments.ts";
import { z } from "zod";
import { createImageAttachmentAdapter, restoreDetachedImages } from "./attachment-adapter.ts";
import { projectAssistantMessages, type AssistantProjection } from "./assistant-messages.ts";
import { DurableControls } from "./durable-controls.tsx";
import { ChatHostContext, useChatHost, type ChatProps } from "./chat-host.ts";
import { EditDiffSchema, parseEditPatch } from "../shared/edit-diff.ts";
import { Button } from "@/components/ui/button";
import {
  CollapsibleRoot,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/assistant-ui/elements/collapsible-root";
import {
  createDraftAutosave,
  useDraftRecovery,
  useDraftRestoration,
} from "./draft-persistence.tsx";
import { parseDirectShell } from "../shared/direct-shell.ts";
import { draftInputText, type DraftIntent } from "../shared/draft-intent.ts";
export type { ChatProps } from "./chat-host.ts";

const convertMessage = (message: ThreadMessageLike) => message;
const durableCommandNames = ["queue", "steer", "continue", "reset", "prompts", "tangent", "side"];
// Adapt authoritative tool status only; the supplied ToolFallback owns presentation.
function DurableToolFallback(props: ToolCallMessagePartProps) {
  const host = useChatHost();
  const states = useAuiState((state) => state.message.metadata.custom["toolStates"]);
  const results = useAuiState((state) => state.message.metadata.custom["toolResultParts"]);
  const tables = useAuiState((state) => state.message.metadata.custom["toolTables"]);
  const table = TableDetailsSchema.safeParse(
    props.toolName === "display_table" && tables && typeof tables === "object"
      ? Reflect.get(tables, props.toolCallId)
      : undefined,
  );
  const editDiffs = useAuiState((state) => state.message.metadata.custom["editDiffs"]);
  const editDiff = EditDiffSchema.safeParse(
    props.toolName === "edit" && editDiffs && typeof editDiffs === "object"
      ? Reflect.get(editDiffs, props.toolCallId)
      : undefined,
  );
  const output = z
    .array(ToolResultPartSchema)
    .safeParse(
      results && typeof results === "object" ? Reflect.get(results, props.toolCallId) : undefined,
    );
  const parsed = ToolStateSchema.safeParse(
    states && typeof states === "object" ? Reflect.get(states, props.toolCallId) : undefined,
  );
  const status = !parsed.success
    ? props.status
    : parsed.data === "pending" || parsed.data === "running"
      ? { type: "running" as const }
      : parsed.data === "cancelled"
        ? { type: "incomplete" as const, reason: "cancelled" as const }
        : parsed.data === "error"
          ? { type: "incomplete" as const, reason: "error" as const }
          : parsed.data === "unavailable"
            ? {
                type: "incomplete" as const,
                reason: "other" as const,
                error: "Result is unavailable in the retained history.",
              }
            : { type: "complete" as const };
  const showTable = table.success && parsed.success && parsed.data === "complete";
  const showEditDiff = editDiff.success && parsed.success && parsed.data === "complete";
  if (!output.success && !showTable && !showEditDiff)
    return <ToolFallback {...props} status={status} />;
  const lines =
    editDiff.success && editDiff.data.kind === "patch"
      ? parseEditPatch(editDiff.data.patch)
      : undefined;
  return (
    <ToolFallbackWithResult
      {...props}
      status={status}
      renderResult={() => (
        <>
          {output.success ? (
            output.data.map((part, index) =>
              part.type === "text" ? (
                <ToolFallback.Result key={index} result={part.text} />
              ) : part.type === "image" && host.state?.conversationId ? (
                <Image
                  key={index}
                  type="image"
                  status={{ type: "complete" }}
                  image={`/api/chats/${host.state.conversationId}/images/${part.source.entryId}/${part.source.modelIndex}/${part.source.partIndex}`}
                />
              ) : (
                <ToolFallback.Result
                  key={index}
                  result="Unsupported tool output is not displayed."
                />
              ),
            )
          ) : (
            <ToolFallback.Result result={props.result as unknown} />
          )}
          {showTable && (
            <>
              {table.data.table.title && <p>{table.data.table.title}</p>}
              {table.data.table.caption && <p>{table.data.table.caption}</p>}
              {table.data.table.source && (
                <p>Source (caller supplied): {table.data.table.source}</p>
              )}
              <DataTable
                className="border-0 bg-transparent"
                columns={table.data.table.columns.map((column) => ({
                  key: column.id,
                  label: column.label,
                }))}
                rows={table.data.table.rows}
                caption={table.data.table.caption}
              />
            </>
          )}
          {showEditDiff &&
            (lines ? (
              <CodeDiff
                className="max-w-full border-0 bg-transparent"
                filename="Applied edit (receipt)"
                additions={lines.filter((line) => line.kind === "added").length}
                deletions={lines.filter((line) => line.kind === "removed").length}
                lines={lines}
                cycle={0}
              />
            ) : (
              <ToolFallback.Result result="Edit diff unavailable." />
            ))}
        </>
      )}
    />
  );
}
const threadComponents = { ComposerFooter: DurableControls, ToolFallback: DurableToolFallback };
const interruptionUI = {
  name: "interruption",
  render: () => <AgentStatus state="waiting" label="Response interrupted." />,
};
const omittedLabels = {
  reasoning: "Reasoning content is not shown in this text-only chat.",
  tool: "Tool content is not shown in this text-only chat.",
  image: "Image content is not shown in this text-only chat.",
  other: "Unsupported content is not shown in this text-only chat.",
};
const omittedUI = {
  name: "omitted",
  render: ({ data }: { data: { kind: keyof typeof omittedLabels } }) =>
    data.kind === "reasoning" ? null : (
      <AgentStatus
        state="waiting"
        label={omittedLabels[data.kind]}
        title={omittedLabels[data.kind]}
      />
    ),
};

function OfficialThread() {
  useAssistantDataUI(interruptionUI);
  useAssistantDataUI(omittedUI);
  useAssistantDataUI(historyGapUI);
  return <Thread components={threadComponents} autoFocus={false} />;
}

const historyGapUI = {
  name: "history-gap",
  render: function HistoryGapNotice({ data }: { data: HistoryGap }) {
    const host = useChatHost();
    const selected = host.historyGap?.after === data.after && host.historyGap.upTo === data.upTo;
    const error = selected ? host.historyError : null;
    if (!host.connected || !host.onFillGap)
      return (
        <AgentStatus state="waiting" label="History gap. Reconnect to load missing messages." />
      );
    return (
      <ErrorState
        title="History gap"
        detail={error ?? "Messages between these entries are not loaded."}
        actionLabel={error ? "Retry" : "Load missing messages"}
        pendingLabel="Loading missing messages"
        retrying={!!host.historyLoading && selected}
        disabled={host.historyLoading}
        onRetry={() => {
          void host.onFillGap?.(data);
        }}
      />
    );
  },
};

type DraftWriter = ReturnType<typeof createDraftAutosave>;
function PersistenceBridge({
  runtime,
  chatId,
  enabled,
  readOnly,
  writer,
  localRevision,
  hasPendingUploads,
  onReady,
  onRetry,
  onUnsavedDraft,
}: {
  runtime: AssistantRuntime;
  chatId: string;
  enabled: boolean;
  readOnly: boolean;
  writer: React.RefObject<DraftWriter | null>;
  localRevision: () => number;
  hasPendingUploads: () => boolean;
  onReady: (ready: boolean) => void;
  onUnsavedDraft?: (chatId: string) => void;
  onRetry: (record: {
    requestId: string;
    draftRevision: number;
    text: string;
    images: string[];
    mode: SendMode;
    intent?: DraftIntent | undefined;
  }) => Promise<boolean>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const unsavedRef = useRef(onUnsavedDraft);
  unsavedRef.current = onUnsavedDraft;
  const conflictHandler = useRef<(saved: import("../shared/drafts.ts").DraftView) => void>(
    () => {},
  );
  const recovery = useDraftRecovery(chatId, enabled);
  const restoration = useDraftRestoration({
    runtime,
    chatId,
    enabled,
    readOnly,
    localRevision,
    onResolved: (saved, choice) => {
      if (readOnly) {
        onReady(true);
        return;
      }
      if (writer.current) {
        if (choice === "mine") writer.current.keepMine(saved);
        else writer.current.useSaved(saved);
      } else {
        writer.current = createDraftAutosave({
          runtime,
          chatId,
          initial: saved,
          onConflict: (remote) => {
            setError(null);
            conflictHandler.current(remote);
          },
          onError: setError,
          onSaved: () => setError(null),
        });
        if (choice !== "saved") void writer.current.flush();
      }
      onReady(true);
    },
  });
  conflictHandler.current = restoration.offerConflict;
  useEffect(() => {
    if (readOnly && restoration.error) onReady(true);
  }, [onReady, readOnly, restoration.error]);
  useEffect(
    () => () => {
      if (
        !readOnly &&
        readOnlyRef.current &&
        (hasPendingUploads() ||
          (writer.current?.hasUnsaved() ??
            (runtime.thread.composer.getState().text !== "" ||
              runtime.thread.composer.getState().attachments.length > 0 ||
              localRevision() > 0)))
      )
        unsavedRef.current?.(chatId);
      writer.current?.stop();
      writer.current = null;
      onReady(false);
    },
    [chatId, enabled, hasPendingUploads, localRevision, onReady, readOnly, runtime, writer],
  );
  return (
    <div
      className="max-h-[35%] shrink-0 overflow-y-auto"
      role="region"
      aria-label="Draft recovery"
      tabIndex={recovery.attempts.length ? 0 : undefined}
    >
      {restoration.conflict && (
        <div role="alert">
          Draft changed in another session.
          <Button type="button" variant="outline" onClick={() => void restoration.useSaved()}>
            Use saved
          </Button>
          <Button type="button" variant="outline" onClick={restoration.keepMine}>
            Keep mine
          </Button>
        </div>
      )}
      {(error || restoration.error || recovery.error) && (
        <AgentStatus state="failed" label={error ?? restoration.error ?? recovery.error ?? ""} />
      )}
      {error && !readOnly && (
        <Button type="button" variant="outline" onClick={() => void writer.current?.retrySave()}>
          Retry saving draft
        </Button>
      )}
      {recovery.attempts.map((attempt) => {
        const { record } = attempt;
        const admitted = attempt.admission === "admitted" || confirmed.includes(record.requestId);
        return (
          <div role="status" key={record.requestId}>
            <p>
              {admitted ? "Admitted" : "Delivery unconfirmed"} — request {record.requestId}
            </p>
            <p>
              Draft revision {record.draftRevision}; mode {record.mode}.
            </p>
            <p>
              {record.text.slice(0, 160)}
              {record.text.length > 160 ? "…" : ""}
            </p>
            {record.text.length > 160 && (
              <CollapsibleRoot>
                <CollapsibleTrigger>View full original text</CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="whitespace-pre-wrap break-words">{record.text}</pre>
                </CollapsibleContent>
              </CollapsibleRoot>
            )}
            <p>{record.images.length ? `Images: ${record.images.join(", ")}` : "No images"}</p>
            {attempt.admission === "admitted" && <p>Submission {attempt.submissionId}</p>}
            {!admitted && !readOnly && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void onRetry(record).then((admitted) => {
                    if (admitted) setConfirmed((previous) => [...previous, record.requestId]);
                  });
                }}
              >
                Retry original
              </Button>
            )}
          </div>
        );
      })}
      {recovery.capped && (
        <Button type="button" variant="outline" onClick={() => void recovery.loadMore()}>
          Load older attempts
        </Button>
      )}
    </div>
  );
}

// Application code adapts host behavior; the official Thread owns presentation.
export function Chat(props: ChatProps) {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const revision = useRef(0);
  const selectionSnapshot = useRef<{ text: string; ids: string[]; after: string } | null>(null);
  const pendingUploads = useRef(0);
  const persistence = useRef<DraftWriter | null>(null);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const localRevision = useCallback(() => revision.current, []);
  const hasPendingUploads = useCallback(() => pendingUploads.current > 0, []);
  const detached = useRef<{ revision: number } | null>(null);
  const submitted = useRef<{ text: string; ids: string[]; revision: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const committedProjection = useRef<AssistantProjection | undefined>(undefined);
  const projection = useMemo(
    () => projectAssistantMessages(props.state, committedProjection.current),
    [props.state],
  );
  // Only committed React renders advance the identity cache.
  useLayoutEffect(() => {
    committedProjection.current = projection;
  }, [projection]);
  const displayMessages = useMemo(() => {
    if (
      !props.shell ||
      props.state?.messages.some(
        (message) =>
          message.source?.taskId === Number(props.shell?.taskId) &&
          message.parts?.some(
            (part) => part.type === "tool-call" && part.name.startsWith("Direct shell"),
          ),
      )
    )
      return projection.messages;
    const partId = `shell:${props.shell.taskId}`;
    return [
      ...projection.messages,
      {
        id: partId,
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: partId,
            toolName: props.shell.includeInContext
              ? "Direct shell"
              : "Direct shell (not in model context)",
            args: { command: props.shell.command },
            argsText: JSON.stringify({ command: props.shell.command }),
            result: `${props.shell.truncated ? "[Earlier output truncated]\n" : ""}${props.shell.output}`,
            isPreliminary: true,
          },
        ],
        metadata: { custom: { toolStates: { [partId]: "running" } } },
        status: { type: "running" as const },
      },
    ];
  }, [projection.messages, props.shell, props.state?.messages]);
  const messages = useExternalMessageConverter({
    messages: displayMessages,
    callback: convertMessage,
    joinStrategy: "none",
    isRunning: projection.streaming || !!props.shell,
  });
  const available =
    !!props.onSend &&
    !props.readOnly &&
    !props.inputBlockedReason &&
    props.connected &&
    props.state !== null &&
    !props.pending &&
    !props.uncertain &&
    props.retryText == null &&
    !props.retryAction &&
    (!props.chatId || persistenceReady);

  const adapter = useMemo(() => {
    if (props.onSend && props.attachmentAdapter) return props.attachmentAdapter;
    const id =
      props.chatId ??
      (props.state?.conversationId ? String(props.state.conversationId) : undefined);
    if (!id || !props.onSend) return undefined;
    return createImageAttachmentAdapter({
      onAddStart: () => {
        revision.current++;
        pendingUploads.current++;
      },
      onAddEnd: () => {
        pendingUploads.current--;
      },
      upload: async (file) => {
        try {
          if (props.mutationAllowed?.() === false) throw new Error("Chat is read-only.");
          const response = await fetch(`/api/chats/${id}/attachments`, {
            method: "POST",
            headers: { "Content-Type": file.type },
            body: file,
          });
          if (!response.ok) throw new Error("Image upload failed.");
          return (await response.json()) as unknown;
        } catch {
          setLocalError("Image upload failed. Choose an image and try again.");
          throw new Error("Image upload failed.");
        }
      },
      previewUrl: (attachmentId) => `/api/chats/${id}/attachments/${attachmentId}`,
    });
  }, [
    props.chatId,
    props.state?.conversationId,
    props.onSend,
    props.attachmentAdapter,
    props.mutationAllowed,
  ]);

  const clearSubmitted = useCallback(() => {
    const composer = runtimeRef.current?.thread.composer;
    const snapshot = submitted.current;
    if (!composer || !snapshot) return;
    const state = composer.getState();
    if (
      revision.current !== snapshot.revision ||
      state.text !== snapshot.text ||
      JSON.stringify(state.attachments.map((item) => item.id)) !== JSON.stringify(snapshot.ids)
    )
      return;
    // In assistant-ui 0.15.36 clearAttachments empties the native array before
    // its promise awaits adapter cleanup. Never call it after a newer add starts.
    const before = revision.current;
    const clearing = composer.clearAttachments();
    const expected = before + (snapshot.ids.length ? 1 : 0);
    const after = composer.getState();
    if (revision.current === expected && after.text === snapshot.text && !after.attachments.length)
      composer.setText("");
    void clearing.catch(() => setLocalError("Attachment removal could not be confirmed."));
    submitted.current = null;
  }, []);

  const admit = useCallback(
    async (
      draft: string,
      mode: SendMode,
      nativeSend = false,
      ids?: string[],
      intent?: DraftIntent,
    ) => {
      const composer = runtimeRef.current?.thread.composer;
      setLocalError(null);
      const shell = nativeSend ? parseDirectShell(draft) : undefined;
      if (intent && !props.canRequestTangent) {
        setLocalError("Choose an available / command from the list; command text was not sent.");
        return false;
      }
      if (
        nativeSend &&
        !intent &&
        !shell &&
        Array.from(draft.matchAll(/(?:^|\s)\/([a-z]*)(?=\s|$)/giu)).some((match) =>
          durableCommandNames.some((name) => name.startsWith(match[1]?.toLowerCase() ?? "")),
        )
      ) {
        setLocalError("Choose an available / command from the list; command text was not sent.");
        return false;
      }
      if (
        !available ||
        !props.onSend ||
        (intent && !props.canRequestTangent) ||
        (mode === "reject" && props.state?.busy) ||
        (mode === "steer" && !props.state?.busy)
      )
        return false;
      const text = draftInputText(draft, intent);
      if (text === undefined) {
        setLocalError("Enter a goal with a single complete tangent command.");
        return false;
      }

      const images = ids ?? composer?.getState().attachments.map((item) => item.id) ?? [];
      if (shell && images.length) {
        setLocalError("Direct shell commands cannot include image attachments.");
        return false;
      }
      if (shell && !props.onShell) {
        setLocalError("Direct shell is unavailable in this chat.");
        return false;
      }
      if (
        (!text && !images.length) ||
        text.length > 32_000 ||
        images.some((id) => !AttachmentIdSchema.safeParse(id).success)
      ) {
        setLocalError("Enter a message or attach a supported image.");
        return false;
      }
      const state = composer?.getState();
      submitted.current =
        state &&
        state.text === draft &&
        JSON.stringify(state.attachments.map((item) => item.id)) === JSON.stringify(images)
          ? { text: draft, ids: [...images], revision: revision.current }
          : null;
      const writer = persistence.current;
      if (props.chatId && !writer) return false;
      writer?.beginSend();
      try {
        if (shell && props.onShell) {
          // Shell execution has its own durable identity; retain the draft on
          // both success and uncertainty until shell-specific clearing exists.
          submitted.current = null;
          return await props.onShell(shell.command, shell.includeInContext);
        }
        const prepared = writer
          ? await writer.prepareSend(draft, images, mode, crypto.randomUUID(), intent)
          : undefined;
        if (props.mutationAllowed?.() === false) return false;
        const admitted = await props.onSend(
          text,
          mode,
          images,
          prepared && writer
            ? {
                ...prepared,
                onClear: (nextRevision) => writer.acknowledgeClear(prepared.draft, nextRevision),
              }
            : undefined,
        );
        if (admitted) clearSubmitted();
        return admitted;
      } catch {
        setLocalError(
          "Draft preparation or delivery could not be confirmed. Inspect the conversation before retrying.",
        );
        return false;
      } finally {
        writer?.endSend();
      }
    },
    [
      available,
      props.onSend,
      props.onShell,
      props.canRequestTangent,
      props.state,
      props.chatId,
      clearSubmitted,
    ],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const conversationId =
        props.chatId ?? (props.state?.conversationId ? String(props.state.conversationId) : "");
      if (
        message.role !== "user" ||
        message.content.some((part) => part.type !== "text") ||
        (message.attachments ?? []).some(
          (attachment) =>
            !AttachmentIdSchema.safeParse(attachment.id).success ||
            attachment.type !== "image" ||
            attachment.content.length !== 1 ||
            attachment.content[0]?.type !== "image" ||
            attachment.content[0].image !==
              `/api/chats/${conversationId}/attachments/${attachment.id}`,
        )
      ) {
        setLocalError("Only PNG and JPEG attachments are supported.");
        persistence.current?.endSend();
        return;
      }
      const composer = runtimeRef.current?.thread.composer;
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const mark = detached.current;
      detached.current = null;
      const expectedRevision = revision.current;
      if (
        composer &&
        (mark ? mark.revision === expectedRevision : text === "") &&
        composer.getState().text === "" &&
        composer.getState().attachments.length === 0
      ) {
        try {
          await restoreDetachedImages(
            composer,
            message.attachments ?? [],
            text,
            expectedRevision,
            () => revision.current,
          );
        } catch {
          setLocalError("Attachment restoration failed. Check the draft before retrying.");
          persistence.current?.endSend();
          return;
        }
      }
      await admit(
        text,
        "reject",
        true,
        (message.attachments ?? []).map((attachment) => attachment.id),
        (() => {
          const match = /(?:^|\s)\/(tangent|side)(?=\s|$)/u.exec(text);
          if (!match) return undefined;
          const intent: DraftIntent = {
            kind: "tangent-handoff-request",
            version: 1,
            command: match[1] === "side" ? "side" : "tangent",
          };
          return draftInputText(text, intent) === undefined ? undefined : intent;
        })(),
      );
      persistence.current?.endSend();
    },
    [admit, props.chatId, props.state?.conversationId],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    onNew,
    ...(props.onEdit
      ? {
          onEdit: async (message: AppendMessage) => {
            const source = projection.messages.find((item) => item.id === message.sourceId);
            const entryId = source?.metadata?.custom?.["sourceEntryId"];
            if (
              typeof entryId !== "number" ||
              !Number.isSafeInteger(entryId) ||
              message.role !== "user" ||
              message.content.some((part) => part.type !== "text") ||
              (message.attachments?.length ?? 0) !== 0
            )
              throw new Error("This message cannot be edited.");
            const text = message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("");
            if (!text.trim() || text.length > 32_000) throw new Error("Enter a valid message.");
            props.onEdit?.(entryId, text);
          },
        }
      : {}),
    isRunning: (props.state?.busy ?? false) || !!props.shell,
    isLoading: props.state === null,
    // Hydration needs native attachment insertion; the read-only thread is inert
    // until restoration finishes, then the runtime itself becomes disabled.
    isDisabled: !props.onSend && (!props.chatId || persistenceReady),
    isSendDisabled: !available || (props.state?.busy ?? false) || !!props.shell,
    ...(adapter ? { adapters: { attachments: adapter } } : {}),
    hasEarlier: !!props.onLoadEarlier && props.connected && (props.state?.hasEarlier ?? false),
    ...(props.onLoadEarlier ? { onLoadEarlier: props.onLoadEarlier } : {}),
    ...(props.shell && props.connected && !props.pending && props.onShellStop
      ? { onCancel: props.onShellStop }
      : available && !props.shell && props.onStop
        ? { onCancel: props.onStop }
        : {}),
  });
  runtimeRef.current = runtime;
  useLayoutEffect(() => {
    const id = props.chatId;
    const guards = props.draftGuards?.current;
    if (!id || !guards) return;
    const guard = async () => {
      const writer = persistence.current;
      if (!writer || pendingUploads.current) return false;
      const version = revision.current;
      const settled = await writer.settleForArchive();
      return (
        settled &&
        persistence.current === writer &&
        pendingUploads.current === 0 &&
        revision.current === version
      );
    };
    guards.set(id, guard);
    return () => {
      if (guards.get(id) === guard) guards.delete(id);
    };
  }, [props.chatId, props.draftGuards]);
  useLayoutEffect(() => {
    const composer = runtime.thread.composer;
    let lastSubmission: string | undefined;
    let previous = {
      text: composer.getState().text,
      ids: composer.getState().attachments.map((item) => item.id),
    };
    let last = JSON.stringify([
      composer.getState().text,
      composer.getState().attachments.map((item) => item.id),
    ]);
    const unsubscribe = composer.subscribe(() => {
      const state = composer.getState();
      const next = JSON.stringify([state.text, state.attachments.map((item) => item.id)]);
      if (next !== last) {
        selectionSnapshot.current = { ...previous, after: state.text };
        previous = { text: state.text, ids: state.attachments.map((item) => item.id) };
        last = next;
        revision.current++;
      }
      if (state.submission && state.submission.id !== lastSubmission) {
        lastSubmission = state.submission.id;
        persistence.current?.beginSend();
        detached.current = { revision: revision.current };
      }
    });
    const unsubscribeText = composer.unstable_on("textChange", (event) => {
      if (event.origin === "send") {
        persistence.current?.beginSend();
        if (!detached.current) detached.current = { revision: revision.current };
      }
    });
    return () => {
      unsubscribe();
      unsubscribeText();
    };
  }, [runtime]);

  return (
    <ChatHostContext.Provider
      value={{
        ...props,
        readDraft: () => runtimeRef.current?.thread.composer.getState().text ?? "",
        draftVersion: () => revision.current,
        applyPrompt: (version, text, mode) => {
          const composer = runtimeRef.current?.thread.composer;
          if (
            !composer ||
            !available ||
            !props.connected ||
            !props.onSend ||
            props.active === false ||
            props.readOnly ||
            props.mutationAllowed?.() === false ||
            revision.current !== version
          )
            return false;
          const current = composer.getState().text;
          composer.setText(mode === "append" && current ? `${current}\n${text}` : text);
          return true;
        },
        ...(props.onRetry
          ? {
              onRetry: async () => {
                const admitted = await props.onRetry!();
                if (admitted && props.retryText != null) clearSubmitted();
                return admitted;
              },
            }
          : {}),
        available,
        localError,
        clearLocalError: () => setLocalError(null),
        submitDraft: (mode) => admit(runtime.thread.composer.getState().text, mode),
        requestTangent: (command) => {
          const snapshot = selectionSnapshot.current;
          selectionSnapshot.current = null;
          const composer = runtime.thread.composer;
          const current = composer.getState();
          const intent: DraftIntent = { kind: "tangent-handoff-request", version: 1, command };
          if (
            !snapshot ||
            current.text !== snapshot.after ||
            JSON.stringify(current.attachments.map((item) => item.id)) !==
              JSON.stringify(snapshot.ids)
          )
            return Promise.resolve(false);
          composer.setText(snapshot.text);
          if (draftInputText(snapshot.text, intent) === undefined) {
            setLocalError(
              "Type the complete /tangent or /side command and a goal before selecting it.",
            );
            return Promise.resolve(false);
          }
          if (props.mutationAllowed?.() === false) return Promise.resolve(false);
          return admit(snapshot.text, "reject", false, snapshot.ids, intent);
        },
      }}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-full min-h-0 flex-col">
          {props.chatId && (
            <PersistenceBridge
              key={props.chatId}
              runtime={runtime}
              chatId={props.chatId}
              enabled
              readOnly={!props.onSend}
              writer={persistence}
              localRevision={localRevision}
              hasPendingUploads={hasPendingUploads}
              onReady={setPersistenceReady}
              {...(props.onUnsavedDraft ? { onUnsavedDraft: props.onUnsavedDraft } : {})}
              onRetry={async (record) => {
                if (!props.connected || props.pending || !props.onSend || !persistence.current)
                  return false;
                const state = runtime.thread.composer.getState();
                const original =
                  !hasPendingUploads() &&
                  state.text === record.text &&
                  JSON.stringify(state.attachments.map((item) => item.id)) ===
                    JSON.stringify(record.images)
                    ? { text: record.text, ids: [...record.images], revision: revision.current }
                    : null;
                const writer = persistence.current;
                const draft = {
                  revision: record.draftRevision,
                  text: record.text,
                  images: [...record.images],
                  attempt: true as const,
                };
                let confirmedClear = false;
                const recoveredText = draftInputText(record.text, record.intent);
                if (recoveredText === undefined || props.mutationAllowed?.() === false)
                  return false;
                const admitted = await props.onSend(recoveredText, record.mode, record.images, {
                  requestId: record.requestId,
                  draft,
                  onClear: (nextRevision) => {
                    if (nextRevision !== draft.revision + 1) return;
                    confirmedClear = writer?.acknowledgeClear(draft, nextRevision) ?? false;
                  },
                });
                if (admitted && confirmedClear && original && !hasPendingUploads()) {
                  writer?.beginSend();
                  submitted.current = original;
                  clearSubmitted();
                  writer?.endSend();
                }
                // The native snapshot may have been retained without emitting a
                // composer event (for example, a pending upload can fail). Save
                // it against the adopted clear revision, after any native clear.
                if (confirmedClear) writer.reconcile();
                return admitted;
              }}
            />
          )}
          <div
            className="min-h-0 flex-1"
            inert={!props.onSend && !!props.chatId && !persistenceReady}
          >
            <OfficialThread />
          </div>
        </div>
      </AssistantRuntimeProvider>
    </ChatHostContext.Provider>
  );
}
