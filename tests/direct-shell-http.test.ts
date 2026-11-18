import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { DirectShellDoc } from "../src/server/direct-shell.ts";
import { testModels } from "./models.ts";

let dir: string;
let chat: Awaited<ReturnType<typeof openChat>>;
let app: ReturnType<typeof createApp>;
let provider: ReturnType<typeof testModels>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cpd-shell-http-"));
  provider = testModels();
  chat = await openChat(join(dir, "data"), provider.models, dir);
  app = createApp(chat);
});
afterEach(async () => {
  await chat.close();
  await rm(dir, { recursive: true, force: true });
});

it("keeps shell and draft-attempt request identities distinct in both directions", async () => {
  const path = `http://localhost:3000/api/chats/${chat.conversation.id}`;
  const json = (suffix: string, method: string, body: unknown) =>
    app.request(path + suffix, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await json("/draft", "PUT", {
        expectedRevision: 0,
        content: { text: "draft", images: [] },
      })
    ).status,
  ).toBe(200);
  const requestId = crypto.randomUUID();
  const attempt = { requestId, draftRevision: 1, text: "draft", images: [], mode: "reject" };
  expect((await json("/draft/attempt", "POST", attempt)).status).toBe(200);
  expect(
    (
      await json("/shell", "POST", {
        requestId,
        command: "printf no",
        includeInContext: true,
      })
    ).status,
  ).toBe(409);
  const shellId = crypto.randomUUID();
  await chat.conversation.commit(async (tx) => {
    (await tx.doc(DirectShellDoc, chat.conversation.id)).requests.push({
      requestId: shellId,
      digest: "synthetic",
      taskId: 1,
    });
  }, BACKGROUND_CONTEXT);
  expect((await json("/draft/attempt", "POST", { ...attempt, requestId: shellId })).status).toBe(
    409,
  );
  expect(provider.calls).toHaveLength(0);
});

it("admits, observes, retries and stops a real configured SDK shell task", async () => {
  const requestId = crypto.randomUUID();
  const body = { requestId, command: "printf observed; sleep 30", includeInContext: false };
  const path = `/api/chats/${chat.conversation.id}`;
  const post = (suffix: string, value: unknown) =>
    app.request(`http://localhost:3000${path}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const first = await post("/shell", body);
  expect(first.status).toBe(202);
  expect((await post("/shell", body)).status).toBe(202);
  expect((await post("/shell", { ...body, command: "printf different" })).status).toBe(409);
  await vi.waitFor(async () => {
    const response = await app.request(`http://localhost:3000${path}/shell?requestId=${requestId}`);
    expect(await response.json()).toMatchObject({
      requestId,
      status: "running",
      output: "observed",
    });
  });
  expect((await post("/compact", { instructions: "" })).status).toBe(409);
  expect((await post("/input", { requestId: crypto.randomUUID(), text: "no" })).status).toBe(409);
  expect((await post("/manage", { action: "archive" })).status).toBe(409);
  expect(
    (await app.request(`http://localhost:3000/api/chats/999999/shell?requestId=${requestId}`))
      .status,
  ).toBe(404);
  expect((await post("/shell/stop", { requestId: crypto.randomUUID() })).status).toBe(404);
  expect((await post("/shell/stop", { requestId })).status).toBe(200);
  await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const response = await app.request(`http://localhost:3000${path}/shell?requestId=${requestId}`);
  expect(await response.json()).toMatchObject({
    status: "cancelled",
    output: "observed",
    outputMayBeIncomplete: true,
  });
  expect(provider.calls).toHaveLength(0);
});

it("fails shell admission closed for an uncertain durable compaction intent", async () => {
  await chat.conversation.commit(async (tx) => {
    (await tx.doc(DirectShellDoc, chat.conversation.id)).compactIntent = {
      id: "synthetic-reservation",
    };
  }, BACKGROUND_CONTEXT);
  const response = await app.request(
    `http://localhost:3000/api/chats/${chat.conversation.id}/shell`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        command: "printf no",
        includeInContext: true,
      }),
    },
  );
  expect(response.status).toBe(409);
  expect(provider.calls).toHaveLength(0);
});

it("serializes a held manual compaction admission against shell and requires explicit recovery", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = chat.conversation.compact.bind(chat.conversation);
  const spy = vi
    .spyOn(chat.conversation, "compact")
    .mockImplementation(async (instructions, context) => {
      entered();
      await waiting;
      return original(instructions, context);
    });
  const path = `/api/chats/${chat.conversation.id}`;
  const post = (suffix: string, body: unknown) =>
    app.request(`http://localhost:3000${path}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const compacting = post("/compact", { instructions: "" });
    await started;
    const status = (await (
      await app.request(`http://localhost:3000${path}/compact/reservation`)
    ).json()) as { id: string };
    expect(
      (
        await post("/shell", {
          requestId: crypto.randomUUID(),
          command: "printf no",
          includeInContext: true,
        })
      ).status,
    ).toBe(409);
    expect((await post("/compact/recover", { id: status.id })).status).toBe(409);
    expect(provider.calls).toHaveLength(0);
    release();
    expect((await compacting).status).toBe(202);
  } finally {
    release();
    spy.mockRestore();
  }
});

it("explicitly releases an unknown prior-host reservation without starting compaction", async () => {
  const id = crypto.randomUUID();
  await chat.conversation.commit(async (tx) => {
    (await tx.doc(DirectShellDoc, chat.conversation.id)).compactIntent = {
      id,
      owner: crypto.randomUUID(),
    };
  }, BACKGROUND_CONTEXT);
  const response = await app.request(
    `http://localhost:3000/api/chats/${chat.conversation.id}/compact/recover`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    },
  );
  expect(await response.json()).toEqual({ status: "released", outcome: "unknown" });
  expect(provider.calls).toHaveLength(0);
});
