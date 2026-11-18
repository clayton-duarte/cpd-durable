import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createDraftAutosave, useDraftRecovery } from "../../../src/client/draft-persistence.tsx";
import type { DraftView } from "../../../src/shared/drafts.ts";

function Fixture() {
  const recovery = useDraftRecovery("1", location.search.includes("recovery"));
  const [conflict, setConflict] = useState<DraftView>();
  const [error, setError] = useState("");
  const writer = useRef<ReturnType<typeof createDraftAutosave>>(undefined);
  const messages = useExternalMessageConverter({
    isRunning: false,
    messages: [] as { text: string }[],
    callback: (message) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: message.text }],
    }),
  });
  const runtime = useExternalStoreRuntime({ messages, onNew: async () => {} });
  useEffect(() => {
    const image = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "saved.png",
      mimeType: "image/png" as const,
      size: 5,
    };
    const withImage = location.search.includes("image");
    if (withImage)
      void runtime.thread.composer.addAttachment({
        id: image.id,
        name: image.name,
        type: "image",
        contentType: image.mimeType,
        content: [{ type: "image", image: `/api/chats/1/attachments/${image.id}` }],
      });
    const current = createDraftAutosave({
      runtime,
      chatId: "1",
      initial: { revision: 0, content: { text: "", images: withImage ? [image] : [] } },
      onConflict: setConflict,
      onError: setError,
    });
    writer.current = current;
    return () => {
      current.stop();
      writer.current = undefined;
    };
  }, [runtime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="Draft" />
      </ComposerPrimitive.Root>
      <button onClick={() => writer.current?.beginSend()}>Begin send</button>
      <button onClick={() => writer.current?.endSend()}>End send</button>
      <button onClick={() => runtime.thread.composer.setText("")}>Detach</button>
      {conflict && (
        <button
          onClick={() => {
            writer.current?.keepMine(conflict);
            setConflict(undefined);
          }}
        >
          Keep mine
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {recovery.attempts.map((attempt) => (
        <p key={attempt.record.requestId}>
          {attempt.admission}: {attempt.record.requestId}
        </p>
      ))}
      {recovery.capped && (
        <button onClick={() => void recovery.loadMore()}>Load older attempts</button>
      )}
      {recovery.error && <p role="alert">{recovery.error}</p>}
    </AssistantRuntimeProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
