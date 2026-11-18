import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

const handoff = {
  goal: "Synthetic investigation",
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
type Worker = {
  requestId: string;
  taskId: string;
  childId: string | null;
  status: string;
  stop: string;
};
async function fixture(configured = true) {
  const dir = await mkdtemp(join(tmpdir(), "combined-regression-"));
  const provider = testModels();
  const host = await openChat(dir, provider.models, dir);
  const app = createApp(host);
  const main = String(host.conversation.id);
  const base = `http://localhost:3000`;
  const get = (path: string) => app.request(base + path);
  const post = (path: string, data?: unknown) =>
    app.request(base + path, {
      method: "POST",
      ...(data === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
    });
  const policy = await host.modelPolicy.read();
  const choices = policy.choices.filter((c) => c.thinkingLevels.length > 0);
  const select = (index: number) => {
    const c = choices[index % choices.length]!;
    return { provider: c.provider, modelId: c.modelId, thinkingLevel: c.thinkingLevels.at(-1)! };
  };
  const economical = select(0),
    mid = select(1);
  if (configured)
    await host.modelPolicy.save({
      expected: { revision: policy.revision, assignments: policy.assignments },
      assignments: { ...policy.assignments, worker: economical, tangent: mid },
    });
  const create = async (start = false) => {
    const response = await post(`/api/chats/${main}/tangents`, {
      requestId: "tangent",
      parentId: Number(main),
      sourceId: Number(main),
      sourceEntryId: null,
      title: "Child",
      start,
      handoff,
    });
    expect(response.status).toBe(201);
    return String(((await response.json()) as { tangent: { id: number } }).tangent.id);
  };
  const workers = async (id: string): Promise<Worker[]> =>
    ((await (await get(`/api/chats/${id}/workers`)).json()) as { helpers: Worker[] }).helpers;
  const launch = (
    id: string,
    requestId: string,
    mode: "foreground" | "background",
    modelRole = "economical",
  ) =>
    post(`/api/chats/${id}/workers`, {
      requestId,
      mode,
      modelRole,
      delivery: "notify-only",
      assignment: requestId,
      context: "synthetic",
    });
  const done = async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    dir,
    provider,
    host,
    app,
    main,
    get,
    post,
    create,
    workers,
    launch,
    economical,
    mid,
    done,
  };
}

describe("combined production regression", () => {
  it("rejects tangent archive while an owned worker remains unsettled without stopping it", async () => {
    const f = await fixture();
    try {
      const child = await f.create(false);
      expect((await f.launch(child, "archive-blocker", "background")).status).toBe(202);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1));
      const before = await f.workers(child);
      expect(before).toHaveLength(1);
      const response = await f.post(`/api/chats/${f.main}/tangents/${child}/lifecycle`, {
        expected: "open",
        next: "archived",
      });
      expect(response.status).toBe(409);
      expect((await f.workers(child))[0]?.stop).toBe("none");
      expect(f.provider.calls).toHaveLength(1);
      f.provider.calls[0]!.finish("worker complete");
    } finally {
      await f.done();
    }
  });
  it("fails unconfigured launches without creating workers or making provider calls", async () => {
    const f = await fixture(false);
    try {
      expect((await f.launch(f.main, "no-model", "background")).status).toBe(409);
      const response = await f.post(`/api/chats/${f.main}/tangents`, {
        requestId: "no-tangent-model",
        parentId: Number(f.main),
        sourceId: Number(f.main),
        sourceEntryId: null,
        title: "Unavailable",
        start: true,
        handoff,
      });
      expect(response.status).toBe(409);
      expect(await f.workers(f.main)).toEqual([]);
      expect(
        ((await (await f.get(`/api/chats/${f.main}/tangents`)).json()) as { tangents: unknown[] })
          .tangents,
      ).toEqual([]);
      expect(f.provider.calls).toHaveLength(0);
    } finally {
      await f.done();
    }
  });

  it("retains identities for out-of-order worker results without prompting the parent", async () => {
    const f = await fixture();
    try {
      expect((await f.launch(f.main, "first-result", "background")).status).toBe(202);
      expect((await f.launch(f.main, "second-result", "background")).status).toBe(202);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      await vi.waitFor(async () =>
        expect((await f.workers(f.main)).filter((w) => w.childId)).toHaveLength(2),
      );
      const before = await f.workers(f.main);
      const first = before.find((w) => w.requestId === "first-result")!;
      const second = before.find((w) => w.requestId === "second-result")!;
      const firstCall = f.provider.calls.find((call) =>
        JSON.stringify(call.context).includes("first-result"),
      )!;
      const secondCall = f.provider.calls.find((call) =>
        JSON.stringify(call.context).includes("second-result"),
      )!;
      secondCall.finish("second complete");
      await vi.waitFor(async () =>
        expect((await f.workers(f.main)).find((w) => w.taskId === second.taskId)?.status).toBe(
          "success",
        ),
      );
      expect((await f.workers(f.main)).find((w) => w.taskId === first.taskId)?.status).toBe(
        "running",
      );
      firstCall.finish("first complete");
      await vi.waitFor(async () =>
        expect((await f.workers(f.main)).every((w) => w.status === "success")).toBe(true),
      );
      const after = await f.workers(f.main);
      expect(after.map((w) => [w.taskId, w.childId])).toEqual(
        before.map((w) => [w.taskId, w.childId]),
      );
      const result = await f.get(`/api/chats/${f.main}/workers/${second.taskId}/result`);
      expect(result.status).toBe(200);
      expect(((await result.json()) as { text: string }).text).toContain("second complete");
      expect(f.provider.calls).toHaveLength(2);
    } finally {
      await f.done();
    }
  });

  it("executes registered worker tools in main and tangent with configured thinking and cwd", async () => {
    const f = await fixture();
    try {
      const child = await f.create();
      const scope = (await f.host.chats.resolve(child))!;
      const childAgent = await scope.conversation.agent(BACKGROUND_CONTEXT);
      expect(childAgent.model).toEqual({ provider: f.mid.provider, modelId: f.mid.modelId });
      expect(childAgent.thinkingLevel).toBe(f.mid.thinkingLevel);
      expect(childAgent.cwd).toBe(f.dir);
      await f.host.conversation.submit(
        { type: "input", content: "main worker" },
        BACKGROUND_CONTEXT,
      );
      await scope.conversation.submit(
        { type: "input", content: "child worker" },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(2));
      const mainCall = f.provider.calls.find((c) =>
        JSON.stringify(c.context).includes("main worker"),
      )!;
      const childCall = f.provider.calls.find((c) =>
        JSON.stringify(c.context).includes("child worker"),
      )!;
      mainCall.tools([
        {
          id: "main-launch",
          name: "launch_worker",
          arguments: {
            mode: "background",
            delivery: "notify-only",
            assignment: "main tool worker",
            context: "synthetic",
          },
        },
      ]);
      childCall.tools([
        {
          id: "child-launch",
          name: "launch_worker",
          arguments: {
            mode: "background",
            modelRole: "mid",
            delivery: "notify-only",
            assignment: "child tool worker",
            context: "synthetic",
          },
        },
      ]);
      await vi.waitFor(async () => {
        expect((await f.workers(f.main))[0]?.childId).toBeTruthy();
        expect((await f.workers(child))[0]?.childId).toBeTruthy();
      });
      for (const [parent, expected] of [
        [f.main, f.economical],
        [child, f.mid],
      ] as const) {
        const worker = (await f.workers(parent))[0]!;
        const agent = await f.host.conversation.commit(async (tx) => {
          const value = await tx.doc(AgentDoc, Number(worker.childId) as ConversationId);
          return {
            model: value.model
              ? { provider: value.model.provider, modelId: value.model.modelId }
              : null,
            thinkingLevel: value.thinkingLevel,
            cwd: value.cwd,
          };
        }, BACKGROUND_CONTEXT);
        expect(agent.model).toEqual({ provider: expected.provider, modelId: expected.modelId });
        expect(agent.thinkingLevel).toBe(expected.thinkingLevel);
        expect(agent.cwd).toBe(f.dir);
      }
      await vi.waitFor(() => expect(f.provider.calls.length).toBeGreaterThanOrEqual(6));
      for (const call of f.provider.calls.slice(2)) call.finish("done");
    } finally {
      await f.done();
    }
  });

  it("keeps scoped backgrounds and tangent alive on normal Stop and stops only a selected worker", async () => {
    const f = await fixture();
    try {
      const child = await f.create(true);
      await f.host.conversation.submit(
        { type: "input", content: "main active" },
        BACKGROUND_CONTEXT,
      );
      expect((await f.launch(f.main, "main-fg", "foreground")).status).toBe(202);
      expect((await f.launch(f.main, "main-bg", "background")).status).toBe(202);
      expect((await f.launch(child, "child-fg", "foreground")).status).toBe(202);
      expect((await f.launch(child, "child-bg", "background")).status).toBe(202);
      await vi.waitFor(async () => {
        expect((await f.workers(f.main)).filter((w) => w.status === "running")).toHaveLength(2);
        expect((await f.workers(child)).filter((w) => w.status === "running")).toHaveLength(2);
      });
      expect((await f.post(`/api/chats/${f.main}/stop`)).status).toBe(204);
      await vi.waitFor(async () =>
        expect((await f.workers(f.main)).find((w) => w.requestId === "main-fg")?.status).toBe(
          "cancelled",
        ),
      );
      expect((await f.workers(f.main)).find((w) => w.requestId === "main-bg")?.status).toBe(
        "running",
      );
      expect((await f.workers(child)).every((w) => w.status === "running")).toBe(true);
      expect(
        (
          (await (await f.get(`/api/chats/${f.main}/tangents/${child}`)).json()) as {
            tangent: { activity: string };
          }
        ).tangent.activity,
      ).toBe("running");
      expect((await f.post(`/api/chats/${child}/stop`)).status).toBe(204);
      await vi.waitFor(async () =>
        expect((await f.workers(child)).find((w) => w.requestId === "child-fg")?.status).toBe(
          "cancelled",
        ),
      );
      const childBg = (await f.workers(child)).find((w) => w.requestId === "child-bg")!;
      expect(childBg.status).toBe("running");
      expect(
        (
          await f.post(`/api/chats/${child}/workers/${childBg.taskId}/stop`, {
            requestId: "specific-stop",
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(async () =>
        expect((await f.workers(child)).find((w) => w.requestId === "child-bg")?.status).toBe(
          "cancelled",
        ),
      );
      expect((await f.workers(f.main)).find((w) => w.requestId === "main-bg")?.status).toBe(
        "running",
      );
    } finally {
      await f.done();
    }
  });
});
