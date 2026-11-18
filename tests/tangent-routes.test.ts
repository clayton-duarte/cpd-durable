import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { TangentViewSchema } from "../src/shared/tangents.ts";
import { testModels } from "./models.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const handoff = {
  goal: "Synthetic goal",
  decisions: [],
  constraints: [],
  exclusions: [],
  references: [],
  suggestedSkills: [],
  discretion: "",
  deliverable: "Result",
  evidence: "",
  limits: "",
};
async function setup(configured = true) {
  const root = await mkdtemp(join(tmpdir(), "tangent-http-"));
  roots.push(root);
  const provider = testModels();
  let stale = false;
  const chat = await openChat(
    join(root, "data"),
    provider.models,
    root,
    configured
      ? {
          tangentPolicy: () => ({
            resolveModel: async () => ({
              selection: { provider: PROVIDER_ID, modelId: MODEL_ID, thinkingLevel: "low" },
              revision: 1,
              assignment: "tangent",
            }),
            assertResolvedModel: async () => {
              if (stale) throw new Error("policy changed");
            },
          }),
        }
      : {},
  );
  const app = createApp(chat);
  const main = String(chat.conversation.id),
    base = `http://localhost:3000/api/chats/${main}/tangents`;
  const get = (url: string) => app.request(url);
  const post = (url: string, data: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const create = (requestId: string, start = false) => ({
    requestId,
    parentId: Number(main),
    sourceId: Number(main),
    sourceEntryId: null,
    title: "Synthetic tangent",
    start,
    handoff,
  });
  return {
    root,
    chat,
    provider,
    app,
    main,
    base,
    get,
    post,
    create,
    stale: () => {
      stale = true;
    },
  };
}
describe("tangent HTTP and catalog composition", () => {
  it("requires explicit retry-safe handoff admission before ordinary tangent input", async () => {
    const f = await setup();
    try {
      const created = TangentViewSchema.parse(
        (
          (await (await f.post(f.base, f.create("create-only-start"))).json()) as {
            tangent: unknown;
          }
        ).tangent,
      );
      const input = { requestId: crypto.randomUUID(), text: "Do not lose context", mode: "reject" };
      const denied = await f.post(`http://localhost:3000/api/chats/${created.id}/input`, input);
      expect(denied.status).toBe(409);
      expect(JSON.stringify(await denied.json())).toContain("Start tangent with its handoff first");
      expect(f.provider.calls).toHaveLength(0);
      const start = { requestId: "explicit-start", expectedHandoffRevision: 1 };
      expect(
        (await f.post(`http://localhost:3000/api/chats/999/tangents/${created.id}/start`, start))
          .status,
      ).not.toBe(202);
      expect(
        (await f.post(`${f.base}/${created.id}/start`, { ...start, expectedHandoffRevision: 2 }))
          .status,
      ).toBe(409);
      const response = await f.post(`${f.base}/${created.id}/start`, start);
      expect(response.status).toBe(202);
      expect(
        TangentViewSchema.parse(((await response.json()) as { tangent: unknown }).tangent)
          .startState,
      ).toBe("admitted");
      expect((await f.post(`${f.base}/${created.id}/start`, start)).status).toBe(202);
      expect(
        (await f.post(`${f.base}/${created.id}/start`, { ...start, requestId: "different-start" }))
          .status,
      ).toBe(409);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1));
      expect(JSON.stringify(f.provider.calls[0]!.context.messages)).toContain("Synthetic goal");
      f.provider.calls[0]!.finish("started");
    } finally {
      await f.chat.close();
    }
  });
  it("reopens a registered tangent without reconfiguring its pinned selection", async () => {
    const f = await setup();
    let reopened: Awaited<ReturnType<typeof openChat>> | undefined;
    try {
      const response = await f.post(f.base, f.create("reopen"));
      const item = TangentViewSchema.parse(
        ((await response.json()) as { tangent: unknown }).tangent,
      );
      await f.chat.close();
      reopened = await openChat(join(f.root, "data"), f.provider.models, f.root);
      const scope = await reopened.chats.resolve(String(item.id));
      expect(scope).toBeDefined();
      expect(
        (
          await scope!.conversation.agent(
            (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
          )
        ).thinkingLevel,
      ).toBe("low");
      expect(
        (await reopened.chats.list()).chats.some((entry) => entry.id === String(item.id)),
      ).toBe(false);
      expect(f.provider.calls).toHaveLength(0);
    } finally {
      if (reopened) await reopened.close();
      await f.chat.close();
    }
  });
  it("records returns without a run and admits them only on explicit delivery", async () => {
    const f = await setup();
    try {
      const created = TangentViewSchema.parse(
        ((await (await f.post(f.base, f.create("return-source"))).json()) as { tangent: unknown })
          .tangent,
      );
      const record = {
        requestId: "return-id",
        tangentId: created.id,
        expectedRevision: 1,
        handoff: { ...handoff, goal: "Synthetic result" },
      };
      expect(
        (await f.post(`http://localhost:3000/api/chats/999/tangents/${created.id}/returns`, record))
          .status,
      ).not.toBe(200);
      expect((await f.post(`${f.base}/${created.id}/returns`, record)).status).toBe(200);
      expect((await f.post(`${f.base}/${created.id}/returns`, record)).status).toBe(200);
      expect(f.provider.calls).toHaveLength(0);
      expect((await f.post(`${f.base}/${created.id}/accept`, { revision: 2 })).status).toBe(409);
      expect((await f.post(`${f.base}/${created.id}/deliver`, { revision: 2 })).status).toBe(200);
      expect((await f.post(`${f.base}/${created.id}/deliver`, { revision: 2 })).status).toBe(200);
      await vi.waitFor(() => expect(f.provider.calls).toHaveLength(1));
      expect((await f.post(`${f.base}/${created.id}/accept`, { revision: 2 })).status).toBe(200);
      f.provider.calls[0]!.finish("reviewed");
      await f.chat.conversation.waitForIdle(
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
      );
    } finally {
      await f.chat.close();
    }
  });
  it("creates once, omits sidebar but resolves child and explicitly authorizes history", async () => {
    const f = await setup();
    try {
      expect((await f.get(f.base)).status).toBe(200);
      expect(f.provider.calls).toHaveLength(0);
      const data = f.create("http-create");
      const first = await f.post(f.base, data);
      expect(first.status).toBe(201);
      const item = TangentViewSchema.parse(((await first.json()) as { tangent: unknown }).tangent);
      expect(item.model.thinkingLevel).toBe("low");
      expect(item.startState).toBe("create-only");
      const retry = await f.post(f.base, data);
      expect(
        TangentViewSchema.parse(((await retry.json()) as { tangent: unknown }).tangent).id,
      ).toBe(item.id);
      expect((await f.post(f.base, { ...data, title: "changed" })).status).toBe(409);
      const catalog = (await (await f.get("http://localhost:3000/api/chats")).json()) as {
        chats: { id: string }[];
      };
      expect(catalog.chats.map((entry) => entry.id)).not.toContain(String(item.id));
      const reused = await f.post("http://localhost:3000/api/chats", {
        requestId: crypto.randomUUID(),
      });
      const emptyMain = ((await reused.json()) as { id: string }).id;
      expect(emptyMain).not.toBe(String(item.id));
      const reusedAgain = await f.post("http://localhost:3000/api/chats", {
        requestId: crypto.randomUUID(),
      });
      expect(((await reusedAgain.json()) as { id: string }).id).toBe(emptyMain);
      expect((await f.get(`http://localhost:3000/api/chats/${item.id}/configuration`)).status).toBe(
        200,
      );
      expect((await f.get(`http://localhost:3000/api/chats/${item.id}/questions`)).status).toBe(
        200,
      );
      expect((await f.get(`${f.base}/${item.id}`)).status).toBe(200);
      expect((await f.get(`http://localhost:3000/api/chats/999/tangents/${item.id}`)).status).toBe(
        404,
      );
      expect(
        (
          await f.post(`http://localhost:3000/api/chats/${item.id}/fork`, {
            requestId: crypto.randomUUID(),
            at: "1",
          })
        ).status,
      ).toBe(409);
      const exported = await f.post("http://localhost:3000/api/history-operations/export", {
        scope: { conversationIds: [String(item.id)], includeArchived: false },
        format: "json",
      });
      expect(exported.status).toBe(200);
      expect(
        (await f.post(`http://localhost:3000/api/chats/${f.main}/manage`, { action: "archive" }))
          .status,
      ).toBe(409);
      expect(
        (await f.post(`http://localhost:3000/api/chats/${f.main}/manage`, { action: "delete" }))
          .status,
      ).toBe(409);
      const lifecycle = await f.post(`${f.base}/${item.id}/lifecycle`, {
        expected: "open",
        next: "concluded",
      });
      expect(lifecycle.status).toBe(200);
      expect(
        (await f.post(`http://localhost:3000/api/chats/${f.main}/manage`, { action: "archive" }))
          .status,
      ).toBe(200);
      const archivedView = await f.get(f.base);
      expect(archivedView.status).toBe(200);
      expect(
        TangentViewSchema.parse(
          ((await archivedView.json()) as { tangents: unknown[] }).tangents[0],
        ).readOnly,
      ).toBe(true);
      expect((await f.post(f.base, f.create("blocked"))).status).toBe(409);
      expect(
        (
          await f.post(`http://localhost:3000/api/chats/${item.id}/input`, {
            text: "blocked",
            requestId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect(f.provider.calls).toHaveLength(0);
    } finally {
      await f.chat.close();
    }
  });
  it("rejects changed policy, missing config and cross-site access; starts only on explicit admission", async () => {
    const f = await setup();
    try {
      f.stale();
      expect((await f.post(f.base, f.create("stale"))).status).toBe(409);
      expect(
        (await f.app.request(f.base, { headers: { origin: "http://evil.invalid" } })).status,
      ).toBe(403);
      expect(f.provider.calls).toHaveLength(0);
    } finally {
      await f.chat.close();
    }
    const g = await setup(false);
    try {
      expect((await g.post(g.base, g.create("unconfigured"))).status).toBe(409);
    } finally {
      await g.chat.close();
    }
    const h = await setup();
    try {
      const response = await h.post(h.base, h.create("start", true));
      expect(response.status).toBe(201);
      const item = TangentViewSchema.parse(
        ((await response.json()) as { tangent: unknown }).tangent,
      );
      expect(item.startState).toBe("admitted");
      await vi.waitFor(() => expect(h.provider.calls).toHaveLength(1));
      const mainStop = await h.app.request(`http://localhost:3000/api/chats/${h.main}/stop`, {
        method: "POST",
      });
      expect(mainStop.status).toBe(204);
      expect(
        TangentViewSchema.parse(
          ((await (await h.get(`${h.base}/${item.id}`)).json()) as { tangent: unknown }).tangent,
        ).activity,
      ).toBe("running");
      expect(
        (await h.app.request(`http://localhost:3000/api/chats/${item.id}/stop`, { method: "POST" }))
          .status,
      ).toBe(204);
    } finally {
      await h.chat.close();
    }
  });
});
