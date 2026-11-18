import { useCallback, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalMessageConverter,
  useExternalStoreRuntime,
  useAssistantDataUI,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import type { SendMode } from "../shared/chat.ts";
import { assistantMessages } from "./assistant-messages.ts";
import { DurableControls } from "./durable-controls.tsx";
import { ChatHostContext, type ChatProps } from "./chat-host.ts";
export type { ChatProps } from "./chat-host.ts";

const convertMessage = (message: ThreadMessageLike) => message;
const durableCommandNames = ["queue", "steer", "continue", "reset"];
const threadComponents = { ComposerFooter: DurableControls };
const interruptionUI = {
  name: "interruption",
  render: () => <AgentStatus state="waiting" label="Response interrupted." />,
};

function OfficialThread() {
  useAssistantDataUI(interruptionUI);
  return <Thread components={threadComponents} autoFocus={false} />;
}

// Application code adapts host behavior; the official Thread owns presentation.
export function Chat(props: ChatProps) {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const projected = useMemo(() => assistantMessages(props.state), [props.state]);
  const messages = useExternalMessageConverter({
    messages: projected,
    callback: convertMessage,
    joinStrategy: "none",
    isRunning: props.state?.busy ?? false,
  });
  const available =
    !!props.onSend &&
    props.connected &&
    props.state !== null &&
    !props.pending &&
    !props.uncertain &&
    props.retryText == null &&
    !props.retryAction;

  const admit = useCallback(
    async (draft: string, mode: SendMode, nativeSend = false) => {
      const composer = runtimeRef.current?.thread.composer;
      // The supplied composer detaches the draft on send. Return it immediately
      // while admission is pending, unless the user has already written a new one.
      if (nativeSend && composer?.getState().text === "") composer.setText(draft);
      setLocalError(null);
      if (
        nativeSend &&
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
      const text = draft.trim();
      if (!text || text.length > 32_000) {
        setLocalError("Messages must contain between 1 and 32,000 characters.");
        return false;
      }
      try {
        const admitted = await props.onSend(text, mode);
        if (admitted && composer?.getState().text === draft) composer.setText("");
        return admitted;
      } catch {
        setLocalError(
          "Message delivery could not be confirmed. Check the conversation before sending again.",
        );
        return false;
      }
    },
    [available, props.onSend, props.state],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (
        message.role !== "user" ||
        (message.attachments?.length ?? 0) > 0 ||
        message.content.some((part) => part.type !== "text")
      ) {
        setLocalError("This conversation accepts text only.");
        return;
      }
      await admit(
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        "reject",
        true,
      );
    },
    [admit],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    onNew,
    isRunning: props.state?.busy ?? false,
    isLoading: props.state === null,
    isDisabled: !props.onSend,
    isSendDisabled: !available || (props.state?.busy ?? false),
    ...(available && props.onStop ? { onCancel: props.onStop } : {}),
  });
  runtimeRef.current = runtime;

  return (
    <ChatHostContext.Provider
      value={{
        ...props,
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
