// Isolated synthetic fixture. No request is forwarded to a host.
history.replaceState(null, "", "/chats/1?tangent=2");
const handoff = {
  goal: "Investigate",
  decisions: [],
  constraints: [],
  exclusions: [],
  references: [],
  suggestedSkills: [],
  discretion: "",
  deliverable: "",
  evidence: "",
  limits: "",
};
const title = "Long child title investigation investigation investigation investigation end";
const tangent = {
  id: 2,
  parentId: 1,
  sourceId: 1,
  sourceEntryId: null,
  title,
  model: { provider: "test", modelId: "model-2", thinkingLevel: "off", name: "Model 2" },
  lifecycle: "open",
  readOnly: false,
  activity: "idle",
  attention: "none",
  handoffRevision: 1,
  startState: "admitted",
  latestHandoff: {
    revision: 1,
    kind: "delegate",
    handoff,
    delivery: "available",
    submissionId: null,
    accepted: false,
  },
};
const attempts = Array.from({ length: 13 }, (_, i) => ({
  record: {
    requestId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    draftRevision: i + 1,
    text: `Synthetic send ${i}`,
    images: [],
    mode: "reject",
    fingerprint: "a".repeat(64),
  },
  ...(i === 12 ? { admission: "unknown" } : { admission: "admitted", submissionId: String(i + 1) }),
}));
class SyntheticEvents extends EventTarget {
  /** @param {string | URL} url */
  constructor(url) {
    super();
    const id = Number(new URL(url, location.href).pathname.split("/")[3]);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("state", {
          data: JSON.stringify({
            conversationId: id,
            messages: Array.from({ length: 15 }, (_, i) => ({
              id: `${id}:${i}`,
              role: "user",
              text: `Synthetic long transcript ${i} ${"text ".repeat(40)}`,
              interrupted: false,
            })),
            partial: "",
            busy: false,
            hasEarlier: false,
            failure: null,
          }),
        }),
      ),
    );
  }
  close() {}
}
window.EventSource = SyntheticEvents;
window.fetch = async (input, init = {}) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.href)
    .pathname;
  let value;
  if (path === "/api/chats")
    value = { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] };
  else if (path === "/api/chats/1/tangents") value = { tangents: [tangent] };
  else if (path.endsWith("/workers"))
    value = {
      hasUnsettled: true,
      helpers: [
        {
          requestId: "worker-request",
          taskId: "worker-task",
          childId: null,
          mode: "background",
          model: { provider: "test", modelId: "synthetic" },
          modelName: "Synthetic worker",
          stop: "none",
          status: "running",
          answerEntryId: null,
          delivery: "notify-only",
        },
      ],
    };
  else if (path.endsWith("/draft/attempts"))
    value = { attempts: path.includes("/1/") ? attempts : [], capped: false, nextCursor: null };
  else if (path.endsWith("/draft") && (!init.method || init.method === "GET"))
    value = { revision: 0, content: { text: "", images: [] } };
  else return new Response("{}", { status: 404 });
  return Response.json(value);
};
await import("../../src/client/main.tsx");
