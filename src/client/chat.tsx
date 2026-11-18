import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { parseDirectShell } from "../shared/direct-shell.ts";
export type { ChatProps } from "./chat-host.ts";

const convertMessage = (message: ThreadMessageLike) => message;
const durableCommandNames = ["queue", "steer", "continue", "reset"];
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
  if (!output.success && !showTable) return <ToolFallback {...props} status={status} />;
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

// Application code adapts host behavior; the official Thread owns presentation.
export function Chat(props: ChatProps) {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const revision = useRef(0);
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
    props.connected &&
    props.state !== null &&
    !props.pending &&
    !props.uncertain &&
    props.retryText == null &&
    !props.retryAction;

  const adapter = useMemo(() => {
    if (props.onSend && props.attachmentAdapter) return props.attachmentAdapter;
    const id =
      props.chatId ??
      (props.state?.conversationId ? String(props.state.conversationId) : undefined);
    if (!id || !props.onSend) return undefined;
    return createImageAttachmentAdapter({
      onAddStart: () => {
        revision.current++;
      },
      upload: async (file) => {
        try {
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
  }, [props.chatId, props.state?.conversationId, props.onSend, props.attachmentAdapter]);

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
    async (draft: string, mode: SendMode, nativeSend = false, ids?: string[]) => {
      const composer = runtimeRef.current?.thread.composer;
      setLocalError(null);
      const shell = nativeSend ? parseDirectShell(draft) : undefined;
      if (
        nativeSend &&
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
        (mode === "reject" && props.state?.busy) ||
        (mode === "steer" && !props.state?.busy)
      )
        return false;
      const text = (draft.startsWith("\\!") ? draft.slice(1) : draft).trim();
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
      try {
        const admitted =
          shell && props.onShell
            ? await props.onShell(shell.command, shell.includeInContext)
            : await props.onSend(text, mode, images);
        if (admitted) clearSubmitted();
        return admitted;
      } catch {
        setLocalError(
          "Message delivery could not be confirmed. Check the conversation before sending again.",
        );
        return false;
      }
    },
    [available, props.onSend, props.onShell, props.state, clearSubmitted],
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
          return;
        }
      }
      await admit(
        text,
        "reject",
        true,
        (message.attachments ?? []).map((attachment) => attachment.id),
      );
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
    isDisabled: !props.onSend,
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
    const composer = runtime.thread.composer;
    let lastSubmission: string | undefined;
    let last = JSON.stringify([
      composer.getState().text,
      composer.getState().attachments.map((item) => item.id),
    ]);
    const unsubscribe = composer.subscribe(() => {
      const state = composer.getState();
      const next = JSON.stringify([state.text, state.attachments.map((item) => item.id)]);
      if (next !== last) {
        last = next;
        revision.current++;
      }
      if (state.submission && state.submission.id !== lastSubmission) {
        lastSubmission = state.submission.id;
        detached.current = { revision: revision.current };
      }
    });
    const unsubscribeText = composer.unstable_on("textChange", (event) => {
      if (event.origin === "send" && !detached.current)
        detached.current = { revision: revision.current };
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
      }}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <OfficialThread />
      </AssistantRuntimeProvider>
    </ChatHostContext.Provider>
  );
}
