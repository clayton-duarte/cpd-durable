import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  HelpersExtension,
  requestWorkerStop,
  type WorkerDependencies,
} from "../src/server/helpers.ts";
import { createWorkerRoutes } from "../src/server/worker-routes.ts";
import { createWorkerTools } from "../src/server/worker-tools.ts";
import { CatalogDoc } from "../src/server/chats.ts";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const input = {
  requestId: "same-id",
  mode: "background",
  delivery: "notify-only",
  assignment: "Investigate scoped work",
  context: "Only supplied context",
} as const;

describe("worker route and tool factories", () => {
  let directory: string;
  let harness: Awaited<ReturnType<typeof Harness.open>>;
  let provider: ReturnType<typeof testModels>;
  let parentId: ConversationId;
  let otherId: ConversationId;
  let app: Hono;
  const guard = async (tx: Tx, id: ConversationId, write: boolean) => {
    const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === id);
    if (!item || item.status === "deleted")
      throw Object.assign(new Error("not found"), { status: 404 });
    if (write && item.status === "archived")
      throw Object.assign(new Error("archived"), { status: 409 });
  };
  const policy: WorkerDependencies = {
    resolveModelForRole: async () => ({
      selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "off" },
      revision: 1,
      assignment: "worker",
    }),
    assertModelPolicy: async () => {},
    assertParentWritable: (tx, id) => guard(tx, id, true),
    assertInteractiveParent: async (tx, id) => {
      const record = await tx.conversation(id);
      if (!record || record.owner) throw new Error("not an interactive parent");
    },
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-worker-route-"));
    provider = testModels();
    const registry = createRegistry();
    registry.install(HelpersExtension);
    registry.install(
      createWorkerTools({
        harness: () => harness,
        policy,
        assertReadable: (tx, id) => guard(tx, id, false),
      }),
    );
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      {
        models: provider.models,
        registry,
        settings: { retry: { maxRetries: 0 } },
      },
      BACKGROUND_CONTEXT,
    );
    const parent = await harness.root(BACKGROUND_CONTEXT);
    await parent.configure(
      { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      BACKGROUND_CONTEXT,
    );
    const other = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      },
      BACKGROUND_CONTEXT,
    );
    parentId = parent.id;
    otherId = other.id;
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.push(
        { id: parentId, title: "Parent", named: true, requestId: null },
        { id: otherId, title: "Other", named: true, requestId: null },
      );
    }, BACKGROUND_CONTEXT);
    app = new Hono().route(
      "/",
      createWorkerRoutes({
        harness,
        resolve: async (id) => {
          const conversation = await harness.conversation(
            Number(id) as ConversationId,
            BACKGROUND_CONTEXT,
          );
          return conversation ? { conversation, policy } : undefined;
        },
        assertReadable: (tx, id) => guard(tx, id, false),
        modelName: (providerId, modelId) => provider.models.getModel(providerId, modelId)?.name,
      }),
    );
    harness.resume();
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("admits idempotently, scopes results, and honors archived/deleted catalog guards", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    const [one, two] = await Promise.all([
      app.request(url, post(input)),
      app.request(url, post(input)),
    ]);
    expect(one.status).toBe(202);
    expect(two.status).toBe(202);
    const first = (await one.json()) as { taskId: string };
    expect(await two.json()).toEqual({ taskId: first.taskId, status: "admitted" });
    expect((await app.request(url, post({ ...input, assignment: "different" }))).status).toBe(409);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const list = (await (await app.request(url)).json()) as {
      helpers: { childId: string; modelName: string | null }[];
    };
    expect(list.helpers[0]?.modelName).toBe(provider.models.getModel(PROVIDER_ID, MODEL_ID)?.name);
    expect(
      (
        await app.request(
          `http://localhost/api/chats/${list.helpers[0]!.childId}/workers`,
          post({ ...input, requestId: "recursive" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`http://localhost/api/chats/${otherId}/workers/${first.taskId}/result`))
        .status,
    ).toBe(404);
    expect((await app.request(`${url}/${first.taskId}/result`)).status).toBe(404);
    provider.calls[0]!.finish("safe result");
    await vi.waitFor(async () =>
      expect((await app.request(`${url}/${first.taskId}/result`)).status).toBe(200),
    );
    expect(await (await app.request(`${url}/${first.taskId}/result`)).json()).toMatchObject({
      text: "safe result",
      review: "unreviewed",
    });
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find((item) => item.id === parentId)!.status = "archived";
    }, BACKGROUND_CONTEXT);
    expect((await app.request(url)).status).toBe(200);
    expect((await app.request(url, post({ ...input, requestId: "new" }))).status).toBe(409);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find((item) => item.id === parentId)!.status = "deleted";
    }, BACKGROUND_CONTEXT);
    expect((await app.request(url)).status).toBe(404);
  });

  it("executes launch_worker as an actual SDK model tool bound to its caller", async () => {
    const parent = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    await parent.submit({ type: "input", content: "Delegate this task" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "tool-1",
        name: "launch_worker",
        arguments: {
          mode: "background",
          delivery: "notify-only",
          assignment: "worker tool assignment",
          context: "tool context",
        },
      },
    ]);
    const isChild = (call: (typeof provider.calls)[number]) =>
      call.context.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("worker tool assignment"),
      );
    await vi.waitFor(() => expect(provider.calls.some(isChild)).toBe(true));
    const viewResponse = await app.request(`http://localhost/api/chats/${parentId}/workers`);
    const body = (await viewResponse.json()) as {
      helpers: { taskId: string; model: { modelId: string } }[];
    };
    expect(body.helpers).toHaveLength(1);
    expect(body.helpers[0]?.model.modelId).toBe(MODEL_ID);
    const childCall = provider.calls.find(isChild)!;
    childCall.finish("tool child result");
    await vi.waitFor(async () =>
      expect(
        (
          await app.request(
            `http://localhost/api/chats/${parentId}/workers/${body.helpers[0]!.taskId}/result`,
          )
        ).status,
      ).toBe(200),
    );
    const remaining = provider.calls.find(
      (call) => call !== provider.calls[0] && call !== childCall,
    );
    remaining?.finish("parent answer");
    await parent.abort(BACKGROUND_CONTEXT);
  });

  it("rejects a worker attempting to launch another worker", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    expect((await app.request(url, post(input))).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.tools([
      {
        id: "recursive",
        name: "launch_worker",
        arguments: {
          mode: "background",
          delivery: "notify-only",
          assignment: "nested attempt",
          context: "",
        },
      },
    ]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    const followup = provider.calls[1]!;
    expect(
      followup.context.messages.some((message) => message.role === "toolResult" && message.isError),
    ).toBe(true);
    const listing = (await (await app.request(url)).json()) as { helpers: unknown[] };
    expect(listing.helpers).toHaveLength(1);
    followup.finish("No nested worker");
  });

  it("persists stop identity before abort and retries the same target after interruption", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    const created = (await (await app.request(url, post(input))).json()) as { taskId: string };
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const parent = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    await expect(
      requestWorkerStop(
        {
          abortTask: async () => {
            throw new Error("simulated interruption");
          },
        },
        parent,
        created.taskId,
        { requestId: "stop-one" },
        policy,
      ),
    ).rejects.toThrow("simulated interruption");
    const before = (await (await app.request(url)).json()) as {
      helpers: { stop: string; status: string }[];
    };
    expect(before.helpers[0]).toMatchObject({ stop: "requested", status: "running" });
    expect(
      (
        await app.request(
          `http://localhost/api/chats/${otherId}/workers/${created.taskId}/stop`,
          post({ requestId: "stop-one" }),
        )
      ).status,
    ).toBe(404);
    const stopped = await app.request(
      `${url}/${created.taskId}/stop`,
      post({ requestId: "stop-one" }),
    );
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ taskId: created.taskId, status: "admitted" });
    await vi.waitFor(async () => {
      const view = (await (await app.request(url)).json()) as { helpers: { stop: string }[] };
      expect(view.helpers[0]?.stop).toBe("cancelled");
    });
    expect(
      await (
        await app.request(`${url}/${created.taskId}/stop`, post({ requestId: "stop-one" }))
      ).json(),
    ).toMatchObject({ status: "already-settled" });
    const another = (await (
      await app.request(url, post({ ...input, requestId: "other-worker" }))
    ).json()) as { taskId: string };
    expect(
      (await app.request(`${url}/${another.taskId}/stop`, post({ requestId: "stop-one" }))).status,
    ).toBe(409);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find((item) => item.id === parentId)!.status = "archived";
    }, BACKGROUND_CONTEXT);
    expect(
      (await app.request(`${url}/${another.taskId}/stop`, post({ requestId: "archived-stop" })))
        .status,
    ).toBe(409);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find((item) => item.id === parentId)!.status = "deleted";
    }, BACKGROUND_CONTEXT);
    expect(
      (await app.request(`${url}/${another.taskId}/stop`, post({ requestId: "deleted-stop" })))
        .status,
    ).toBe(404);
  });

  it("retries a persisted stop intent after reopening without creating another worker", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    const created = (await (await app.request(url, post(input))).json()) as { taskId: string };
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const parent = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    await expect(
      requestWorkerStop(
        {
          abortTask: async () => {
            throw new Error("between phases");
          },
        },
        parent,
        created.taskId,
        { requestId: "reopen-stop" },
        policy,
      ),
    ).rejects.toThrow("between phases");
    await harness.close(BACKGROUND_CONTEXT);
    const registry = createRegistry();
    registry.install(HelpersExtension);
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      { models: provider.models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT,
    );
    harness.resume();
    const reopened = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    const result = await requestWorkerStop(
      harness,
      reopened,
      created.taskId,
      { requestId: "reopen-stop" },
      policy,
    );
    expect(["admitted", "already-settled"]).toContain(result.status);
    await vi.waitFor(async () => {
      const task = await harness.getTask(
        Number(created.taskId) as import("@earendil-works/pi-durable").TaskId,
        BACKGROUND_CONTEXT,
      );
      expect(task?.state.status).toBe("terminal");
    });
  });

  it("reports completion racing with Stop as already settled, not cancelled", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    const created = (await (await app.request(url, post(input))).json()) as { taskId: string };
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const parent = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    const result = await requestWorkerStop(
      {
        abortTask: async (id, context) => {
          provider.calls[0]!.finish("completed before stop");
          await harness.waitForTask(id, context);
          return harness.abortTask(id, context);
        },
      },
      parent,
      created.taskId,
      { requestId: "race-stop" },
      policy,
    );
    expect(result.status).toBe("already-settled");
    const body = (await (await app.request(url)).json()) as {
      helpers: { status: string; stop: string }[];
    };
    expect(body.helpers[0]).toMatchObject({ status: "success", stop: "settled" });
    expect(
      (await app.request(`${url}/999999/stop`, post({ requestId: "missing-stop" }))).status,
    ).toBe(404);
  });

  it("mounts workers on the production app when the host injects policy", async () => {
    const chat = await openChat(join(directory, "host"), provider.models, directory, {
      workers: () => ({ policy, assertReadable: (tx, id) => guard(tx, id, false) }),
    });
    try {
      const host = createApp(chat);
      const url = `http://localhost:3000/api/chats/${chat.conversation.id}/workers`;
      const response = await host.request(url, post(input));
      expect(response.status).toBe(202);
      const result = (await response.json()) as { taskId: string };
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      expect(
        (await host.request(`${url}/${result.taskId}/stop`, post({ requestId: "host-stop" })))
          .status,
      ).toBe(202);
      await vi.waitFor(async () => {
        const body = (await (await host.request(url)).json()) as { helpers: { stop: string }[] };
        expect(body.helpers[0]?.stop).toBe("cancelled");
      });
    } finally {
      await chat.close();
    }
  });

  it("uses stop_worker as an SDK tool without stopping its parent conversation", async () => {
    const url = `http://localhost/api/chats/${parentId}/workers`;
    const created = (await (await app.request(url, post(input))).json()) as { taskId: string };
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const parent = (await harness.conversation(parentId, BACKGROUND_CONTEXT))!;
    await parent.submit({ type: "input", content: "Stop that worker" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.tools([
      { id: "stop-call", name: "stop_worker", arguments: { taskId: created.taskId } },
    ]);
    await vi.waitFor(async () => {
      const body = (await (await app.request(url)).json()) as { helpers: { stop: string }[] };
      expect(body.helpers[0]?.stop).toBe("cancelled");
    });
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(3));
    provider.calls.at(-1)!.finish("Parent continues");
    await parent.waitForIdle(BACKGROUND_CONTEXT);
    expect(JSON.stringify((await parent.context(BACKGROUND_CONTEXT)).messages)).toContain(
      "Parent continues",
    );
  });
});
