import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { assertInteractiveChat } from "../src/server/chats.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const content = {
  version: 1,
  provenance: "native",
  goal: "Explain bounded task",
  context: null,
  decisions: [],
  constraints: [],
  exclusions: [],
  references: ["local artifact"],
  suggestedSkills: [],
  discretion: null,
  deliverable: "Report",
  evidence: null,
  limits: null,
};
const legacy = {
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
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("production handoff routes and SDK tools", () => {
  let directory: string;
  let provider: ReturnType<typeof testModels>;
  let chat: Awaited<ReturnType<typeof openChat>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "handoff-app-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory, {
      tangentPolicy: () => ({
        resolveModel: async () => ({
          selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
          revision: 1,
          assignment: "tangent",
        }),
        assertResolvedModel: async () => {},
      }),
      workers: () => ({
        policy: {
          resolveModelForRole: async () => ({
            selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
            revision: 1,
            assignment: "worker",
          }),
          assertModelPolicy: async () => {},
          assertParentWritable: (tx, id) => assertInteractiveChat(tx, id, true),
          assertInteractiveParent: (tx, id) => assertInteractiveChat(tx, id, false),
        },
        assertReadable: (tx, id) => assertInteractiveChat(tx, id, false),
      }),
    });
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("exposes caller-scoped notify-only records and child report tools for a real tangent", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    const tangentResponse = await app.request(
      `${base}/tangents`,
      post({
        requestId: "tangent-create",
        parentId,
        sourceId: parentId,
        sourceEntryId: null,
        title: "Tangent",
        start: false,
        handoff: legacy,
      }),
    );
    expect(tangentResponse.status).toBe(201);
    const tangent = (await tangentResponse.json()) as { tangent: { id: number } };
    const childId = tangent.tangent.id;
    const record = {
      operationId: "delegate",
      assignmentId: "assignment",
      parentId,
      childId,
      expectedRevision: 0,
      kind: "delegate",
      content,
      delivery: "notify-only",
    };
    expect((await app.request(`${base}/handoffs/record`, post(record))).status).toBe(201);
    expect(provider.calls).toHaveLength(0);
    const sibling = (await chat.chats.create("unrelated")).id;
    expect(
      (
        await app.request(
          `http://localhost:3000/api/chats/${sibling}/handoffs/record`,
          post({ ...record, operationId: "spoof" }),
        )
      ).status,
    ).toBe(409);
    expect((await app.request(`${base}/handoffs/deliver`, post({}))).status).toBe(409);
    expect(provider.calls).toHaveLength(0);
    const tangentScope = await chat.chats.resolve(String(childId));
    expect(tangentScope).toBeDefined();
    await tangentScope!.conversation.submit(
      { type: "input", content: "Report status" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "report-call",
        name: "report_handoff",
        arguments: {
          assignmentId: "assignment",
          expectedRevision: 1,
          content,
        },
      },
    ]);
    const query = `?parentId=${parentId}&childId=${childId}&assignmentId=assignment`;
    await vi.waitFor(async () => {
      const response = await app.request(`${base}/handoffs${query}`);
      const body = (await response.json()) as { records: { kind: string; delivery: string }[] };
      expect(body.records.map((item) => item.kind)).toEqual(["delegate", "return"]);
      expect(body.records[1]?.delivery).toBe("notify-only");
    });
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(2));
    provider.calls.at(-1)!.finish("Tangent answer");
    await tangentScope!.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await chat.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(0);
    expect(
      (
        await app.request(
          `${base}/tangents/${childId}/lifecycle`,
          post({ expected: "open", next: "archived" }),
        )
      ).status,
    ).toBe(200);
    expect((await app.request(`${base}/handoffs${query}`)).status).toBe(200);
    expect(
      (
        await app.request(
          `${base}/handoffs/record`,
          post({ ...record, operationId: "later", kind: "update", expectedRevision: 2 }),
        )
      ).status,
    ).toBe(409);
    await chat.chats.change(String(parentId), "delete");
    expect((await app.request(`${base}/handoffs${query}`)).status).toBe(404);
  });

  it("binds worker escalation to actual SDK ownership without a catalog worker row", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    expect(
      (
        await app.request(
          `${base}/workers`,
          post({
            requestId: "worker-create",
            mode: "background",
            delivery: "notify-only",
            assignment: "Investigate",
            context: "Selected",
          }),
        )
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const workers = (await (await app.request(`${base}/workers`)).json()) as {
      helpers: { childId: string }[];
    };
    const childId = Number(workers.helpers[0]!.childId);
    const record = {
      operationId: "delegate-worker",
      assignmentId: "worker-assignment",
      parentId,
      childId,
      expectedRevision: 0,
      kind: "delegate",
      content,
      delivery: "notify-only",
    };
    expect((await app.request(`${base}/handoffs/record`, post(record))).status).toBe(201);
    provider.calls[0]!.tools([
      {
        id: "escalate-call",
        name: "escalate_handoff",
        arguments: {
          assignmentId: "worker-assignment",
          expectedRevision: 1,
          content,
        },
      },
    ]);
    const query = `?parentId=${parentId}&childId=${childId}&assignmentId=worker-assignment`;
    await vi.waitFor(async () => {
      const result = (await (await app.request(`${base}/handoffs${query}`)).json()) as {
        records: { kind: string }[];
      };
      expect(result.records.map((item) => item.kind)).toEqual(["delegate", "escalate"]);
    });
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(2));
    provider.calls.at(-1)!.finish("Worker answer");
    expect((await chat.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(0);
  });

  it("does not admit delivery after reset while delivery is unsupported", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    await chat.conversation.reset("New context", BACKGROUND_CONTEXT);
    const response = await app.request(
      `${base}/handoffs/deliver`,
      post({
        operationId: "requested-delivery",
        assignmentId: "old-assignment",
        acknowledgeRetired: false,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Handoff delivery is not supported yet; nothing was submitted.",
    });
    expect(provider.calls).toHaveLength(0);
    expect((await chat.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(1);
  });
});
