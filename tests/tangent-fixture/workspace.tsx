import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AttachmentAdapter } from "@assistant-ui/react";
import { Chat } from "../../src/client/chat";
import { TangentWorkspace } from "../../src/client/tangents/workspace";
import type { TangentChildView, WorkerChildView } from "../../src/client/tangents/children";
import "../../src/client/index.css";

const tangents: TangentChildView[] = [
  {
    id: "a",
    parentId: "main",
    title: "Running tangent",
    model: "Model Alpha",
    lifecycle: "open",
    activity: "running",
    attention: "none",
  },
  {
    id: "b",
    parentId: "main",
    title: "Idle tangent",
    model: "Model Beta",
    lifecycle: "open",
    activity: "idle",
    attention: "needs-input",
  },
];
const workers: WorkerChildView[] = [
  {
    id: "wm",
    parentId: "main",
    title: "Main worker",
    model: "Worker M",
    lifecycle: "open",
    activity: "running",
    attention: "none",
  },
  {
    id: "wa",
    parentId: "a",
    title: "Alpha worker",
    model: "Worker A",
    lifecycle: "open",
    activity: "waiting",
    attention: "needs-input",
  },
  {
    id: "wb",
    parentId: "b",
    title: "Beta worker",
    model: "Worker B",
    lifecycle: "open",
    activity: "running",
    attention: "none",
  },
];
let next = 0;
const adapter: AttachmentAdapter = {
  accept: "image/png",
  async add({ file }) {
    return {
      id: `fixture-${++next}`,
      type: "image",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async remove() {},
  async send(attachment) {
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{ type: "image", image: `/fixture/${attachment.id}` }],
    };
  },
};
const calls: string[] = [];
Reflect.set(window, "__workspaceCalls", calls);

function FixtureChat({ id, active }: { id: string; active: boolean }) {
  const [partial, setPartial] = useState("");
  useEffect(() => {
    const update = () => setPartial("Synthetic streaming update");
    if (id === "main") window.addEventListener("fixture-stream", update);
    return () => window.removeEventListener("fixture-stream", update);
  }, [id]);
  const conversationId = id === "main" ? 1 : id === "a" ? 2 : 3;
  return (
    <div
      data-testid={`chat-${id}`}
      data-active={String(active)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Chat
        chatId={String(conversationId)}
        title={`Chat ${id}`}
        active={active}
        connected
        state={{
          conversationId,
          messages:
            id === "main"
              ? Array.from({ length: 35 }, (_, index) => ({
                  id: `${index + 1}:0`,
                  role: "user" as const,
                  text: `Main message ${index + 1}`,
                  interrupted: false,
                }))
              : [],
          partial,
          busy: id === "a",
          hasEarlier: false,
          failure: null,
        }}
        attachmentAdapter={adapter}
        onSend={async () => {
          calls.push(`input:${id}`);
          return true;
        }}
        onStop={async () => {
          calls.push(`stop:${id}`);
        }}
      />
    </div>
  );
}
function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="h-screen">
      <TangentWorkspace
        main={{ id: "main", title: "Main thread" }}
        tangents={tangents}
        workers={workers}
        selectedTangentId={selected}
        onSelectTangent={setSelected}
        onCloseTangent={() => setSelected(null)}
        renderMain={(active) => <FixtureChat id="main" active={active} />}
        renderTangent={(tangent, active) => <FixtureChat id={tangent.id} active={active} />}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
