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

  it("rejects general delegation to an unstarted tangent before its original handoff", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    const created = await app.request(
      `${base}/tangents`,
      post({
        requestId: "prepared",
        parentId,
        sourceId: parentId,
        sourceEntryId: null,
        title: "Prepared",
        start: false,
        handoff: legacy,
      }),
    );
    const childId = ((await created.json()) as { tangent: { id: number } }).tangent.id;
    const record = {
      assignmentId: "alternate",
      parentId,
      childId,
      content,
      delivery: "notify-only",
    };
    for (const [kind, revision] of [
      ["delegate", 0],
      ["update", 1],
    ] as const) {
      expect(
        (
          await app.request(
            `${base}/handoffs/record`,
            post({
              ...record,
              kind,
              operationId: `record-${kind}`,
              expectedRevision: revision,
            }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await app.request(
            `${base}/handoffs/deliver`,
            post({
              assignmentId: record.assignmentId,
              parentId,
              childId,
              revision: revision + 1,
              operationId: `deliver-${kind}`,
              mode: "reject",
              expectedParentHead: null,
              expectedChildHead: null,
              acknowledgeRetired: false,
            }),
          )
        ).status,
      ).toBe(409);
    }
    const scope = (await chat.chats.resolve(String(childId)))!;
    expect((await scope.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    const view = await app.request(`${base}/tangents/${childId}`);
    expect(((await view.json()) as { tangent: { startState: string } }).tangent.startState).toBe(
      "create-only",
    );
    expect(
      (
        await app.request(
          `${base}/tangents/${childId}/start`,
          post({
            requestId: "start",
            expectedHandoffRevision: 1,
          }),
        )
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(JSON.stringify(provider.calls[0]!.context.messages)).toContain(legacy.goal);
    provider.calls[0]!.finish("done");
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("rejects the registered deliver tool for an unstarted tangent", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    const created = await app.request(
      `${base}/tangents`,
      post({
        requestId: "tool-prepared",
        parentId,
        sourceId: parentId,
        sourceEntryId: null,
        title: "Prepared",
        start: false,
        handoff: legacy,
      }),
    );
    const childId = ((await created.json()) as { tangent: { id: number } }).tangent.id;
    expect(
      (
        await app.request(
          `${base}/handoffs/record`,
          post({
            assignmentId: "tool-delegate",
            parentId,
            childId,
            content,
            delivery: "notify-only",
            operationId: "tool-record",
            expectedRevision: 0,
            kind: "delegate",
          }),
        )
      ).status,
    ).toBe(201);
    await chat.conversation.submit(
      { type: "input", content: "Try the delivery tool" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "deliver-prepared",
        name: "deliver_handoff",
        arguments: {
          childId,
          assignmentId: "tool-delegate",
          revision: 1,
          mode: "reject",
          expectedParentHead: null,
          expectedChildHead: null,
          acknowledgeRetired: false,
        },
      },
    ]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(
      provider.calls[1]!.context.messages.some(
        (message) => message.role === "toolResult" && message.isError,
      ),
    ).toBe(true);
    expect(JSON.stringify(provider.calls[1]!.context.messages)).toContain(
      "Start tangent with its handoff first",
    );
    const scope = (await chat.chats.resolve(String(childId)))!;
    expect((await scope.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(0);
    provider.calls[1]!.finish("Delivery rejected");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(
      (
        await app.request(
          `${base}/tangents/${childId}/start`,
          post({ requestId: "tool-start", expectedHandoffRevision: 1 }),
        )
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
    expect(JSON.stringify(provider.calls[2]!.context.messages)).toContain(legacy.goal);
    provider.calls[2]!.finish("done");
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
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
    expect((await app.request(`${base}/handoffs/deliver`, post({}))).status).toBe(400);
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

  it("requires an explicit current-head choice before delivery after reset", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    const tangentResponse = await app.request(
      `${base}/tangents`,
      post({
        requestId: "reset-tangent",
        parentId,
        sourceId: parentId,
        sourceEntryId: null,
        title: "Tangent",
        start: false,
        handoff: legacy,
      }),
    );
    const tangent = (await tangentResponse.json()) as { tangent: { id: number } };
    const childId = tangent.tangent.id;
    const record = {
      assignmentId: "old-assignment",
      parentId,
      childId,
      content,
      delivery: "notify-only",
    };
    expect(
      (
        await app.request(
          `${base}/handoffs/record`,
          post({
            ...record,
            operationId: "delegate",
            expectedRevision: 0,
            kind: "delegate",
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          `http://localhost:3000/api/chats/${childId}/handoffs/record`,
          post({
            ...record,
            operationId: "return",
            expectedRevision: 1,
            kind: "return",
          }),
        )
      ).status,
    ).toBe(201);
    await chat.conversation.reset("New context", BACKGROUND_CONTEXT);
    const delivery = {
      operationId: "requested-delivery",
      assignmentId: "old-assignment",
      parentId,
      childId,
      revision: 2,
      mode: "reject",
      expectedParentHead: null,
      expectedChildHead: null,
      acknowledgeRetired: false,
    };
    const response = await app.request(`${base}/handoffs/deliver`, post(delivery));
    expect(response.status).toBe(409);
    const changed = (await response.json()) as {
      currentParentHead: string;
      currentChildHead: null;
    };
    expect(changed.currentParentHead).toMatch(/^\d+$/);
    expect(changed.currentChildHead).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect((await chat.conversation.context(BACKGROUND_CONTEXT)).messages).toHaveLength(1);
    expect(
      (
        await app.request(
          `${base}/handoffs/deliver`,
          post({
            ...delivery,
            expectedParentHead: changed.currentParentHead,
          }),
        )
      ).status,
    ).toBe(409);
    const approved = {
      ...delivery,
      expectedParentHead: changed.currentParentHead,
      acknowledgeRetired: true,
    };
    const accepted = await app.request(`${base}/handoffs/deliver`, post(approved));
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { submissionId: string };
    expect(receipt.submissionId).toMatch(/^\d+$/);
    expect((await app.request(`${base}/handoffs/deliver`, post(approved))).status).toBe(202);
    expect(
      (
        await app.request(
          `${base}/handoffs/deliver`,
          post({ ...approved, acknowledgeRetired: false }),
        )
      ).status,
    ).toBe(409);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("Delivered answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
  it("rejects a real parent model delivery tool while its destination is busy", async () => {
    const app = createApp(chat);
    const parentId = chat.conversation.id;
    const base = `http://localhost:3000/api/chats/${parentId}`;
    const tangentResponse = await app.request(
      `${base}/tangents`,
      post({
        requestId: "tool-tangent",
        parentId,
        sourceId: parentId,
        sourceEntryId: null,
        title: "Tangent",
        start: false,
        handoff: legacy,
      }),
    );
    const childId = ((await tangentResponse.json()) as { tangent: { id: number } }).tangent.id;
    const record = {
      assignmentId: "tool-assignment",
      parentId,
      childId,
      content,
      delivery: "notify-only",
    };
    expect(
      (
        await app.request(
          `${base}/handoffs/record`,
          post({ ...record, operationId: "one", expectedRevision: 0, kind: "delegate" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          `http://localhost:3000/api/chats/${childId}/handoffs/record`,
          post({ ...record, operationId: "two", expectedRevision: 1, kind: "return" }),
        )
      ).status,
    ).toBe(201);
    await chat.conversation.submit(
      { type: "input", content: "Try to deliver" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "deliver-call",
        name: "deliver_handoff",
        arguments: {
          childId,
          assignmentId: "tool-assignment",
          revision: 2,
          mode: "reject",
          expectedParentHead: null,
          expectedChildHead: null,
          acknowledgeRetired: false,
        },
      },
    ]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(
      provider.calls[1]!.context.messages.some(
        (message) => message.role === "toolResult" && message.isError,
      ),
    ).toBe(true);
    provider.calls[1]!.finish("No queued delivery");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const messages = (await chat.conversation.context(BACKGROUND_CONTEXT)).messages;
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
  });
});
