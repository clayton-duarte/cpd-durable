import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  useExternalMessageConverter,
  useAuiState,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { useDraftRestoration } from "../../../src/client/draft-persistence.tsx";

function Adapter({
  runtime,
  chatId,
  readOnly,
}: {
  runtime: AssistantRuntime;
  chatId: string;
  readOnly: boolean;
}) {
  const draft = useDraftRestoration({ runtime, chatId, enabled: true, readOnly });
  return (
    <>
      {draft.conflict && (
        <>
          <button onClick={() => void draft.useSaved()}>Use saved</button>
          <button onClick={draft.keepMine}>Keep mine</button>
        </>
      )}
      {draft.error && <p>{draft.error}</p>}
    </>
  );
}
function Attachments() {
  const attachments = useAuiState((state) => state.composer.attachments);
  return (
    <div>
      {attachments.map((item) => (
        <div key={item.id} data-testid="attachment">
          {item.id}
          <img
            alt={item.name}
            src={item.content?.[0]?.type === "image" ? item.content[0].image : ""}
          />
        </div>
      ))}
    </div>
  );
}
function Fixture() {
  const [chatId, setChatId] = useState("1");
  const [readOnly, setReadOnly] = useState(location.search.includes("readonly"));
  const messages = useExternalMessageConverter({
    isRunning: false,
    messages: [] as { text: string }[],
    callback: (message) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: message.text }],
    }),
  });
  const runtime = useExternalStoreRuntime({ messages, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Adapter runtime={runtime} chatId={chatId} readOnly={readOnly} />
      <button onClick={() => setChatId("2")}>Switch</button>
      <button onClick={() => setReadOnly(true)}>Readonly</button>
      <button
        onClick={() =>
          void runtime.thread.composer.addAttachment({
            id: "22222222-2222-4222-8222-222222222222",
            name: "local.png",
            type: "image",
            contentType: "image/png",
            content: [{ type: "image", image: "/local.png" }],
          })
        }
      >
        Add local
      </button>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="Draft" />
        <Attachments />
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
