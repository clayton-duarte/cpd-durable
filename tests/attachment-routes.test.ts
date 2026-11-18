import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createAttachmentBackend, type ImageAdmission } from "../src/server/attachment-routes.ts";
import {
  checkAdmissionRequest,
  checkImageRequest,
  createPendingImageCatalog,
} from "../src/server/attachment-catalog.ts";
import { createAttachmentService } from "../src/server/attachments.ts";
import { CatalogDoc } from "../src/server/chats.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { IMAGE_MAX_BYTES } from "../src/shared/attachments.ts";
import { testModels } from "./models.ts";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const processor = await createNodePhotonImages({ idleMs: 50 });
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cpd-route-test-"));
  roots.push(root);
  const provider = testModels();
  const registry = createRegistry();
  registry.install(createCodingTools({ images: processor }));
  const envs: NodeExecutionEnv[] = [];
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: provider.models,
      registry,
      env: ({ cwd }) => {
        const env = new NodeExecutionEnv({ cwd: cwd! });
        envs.push(env);
        return env;
      },
    },
    BACKGROUND_CONTEXT,
  );
  const model = { provider: PROVIDER_ID, modelId: MODEL_ID };
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: root, model } });
  await harness.commit(async (tx) => {
    (await tx.doc(CatalogDoc)).items.push({
      id: conversation.id,
      title: "root",
      named: true,
      requestId: null,
    });
  }, BACKGROUND_CONTEXT);
  let selected: { key: string; input: string[] } | null = {
    key: "vision",
    input: ["text", "image"],
  };
  const calls: ImageAdmission[] = [];
  const writable = (id: ConversationId) => async (tx: Tx) => {
    const item = (await tx.doc(CatalogDoc)).items.find((item) => item.id === id);
    if (!item || item.status) throw new Error("Not writable");
  };
  const backend = createAttachmentBackend({
    harness,
    root,
    processor,
    resolve: async (id) => {
      const catalog = await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT);
      const item = catalog?.items.find(
        (item) => String(item.id) === id && item.status !== "deleted",
      );
      if (!item) return undefined;
      const conversation = await harness.conversation(
        item.id as ConversationId,
        BACKGROUND_CONTEXT,
      );
      return conversation
        ? {
            conversation,
            archived: item.status === "archived",
            assertWritable: writable(conversation.id),
          }
        : undefined;
    },
    catalog: (host, scope) =>
      createPendingImageCatalog(host, scope.conversation.id, (tx) => scope.assertWritable(tx)),
    model: async () => selected,
    admit: async (scope, draft, key, digest) => {
      calls.push(draft);
      const id = await harness.commit(async (tx) => {
        await scope.assertWritable(tx);
        if ((selected?.key ?? null) !== key) throw new Error("Model changed");
        const record = await checkImageRequest(tx, scope.conversation.id, draft.requestId!, digest);
        const id = await scope.conversation.submit(tx, draft);
        record();
        return id;
      }, BACKGROUND_CONTEXT);
      return { id: String(id) };
    },
  });
  const app = new Hono();
  app.route("/", backend.routes);
  const base = `/api/chats/${conversation.id}`;
  const upload = (bytes: Uint8Array = png, mime = "image/png") =>
    app.request(`${base}/attachments`, {
      method: "POST",
      headers: { "Content-Type": mime },
      body: Uint8Array.from(bytes),
    });
  const mark = async (id: number, status?: "archived" | "deleted") =>
    harness.commit(async (tx) => {
      const item = (await tx.doc(CatalogDoc)).items.find((i) => i.id === id)!;
      if (status) item.status = status;
      else delete item.status;
    }, BACKGROUND_CONTEXT);
  const add = async (id: number) =>
    harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.push({ id, title: "fork", named: true, requestId: null });
    }, BACKGROUND_CONTEXT);
  const close = async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await Promise.all(envs.map((env) => env.cleanup(BACKGROUND_CONTEXT)));
  };
  return {
    root,
    provider,
    harness,
    conversation,
    backend,
    app,
    base,
    upload,
    mark,
    add,
    close,
    calls,
    select: (value: typeof selected) => {
      selected = value;
    },
    writable,
  };
}

describe("attachment HTTP and durable catalog", () => {
  it("detects cross-kind request-ID collisions before SDK admission and rejects unverifiable legacy IDs", async () => {
    const t = await setup();
    try {
      const id = crypto.randomUUID();
      const draft = { type: "input" as const, content: "text", requestId: id };
      const admit = (fingerprint: string) =>
        t.harness.commit(async (tx) => {
          const record = await checkAdmissionRequest(tx, t.conversation.id, id, fingerprint);
          const submission = await t.conversation.submit(tx, draft);
          record();
          return submission;
        }, BACKGROUND_CONTEXT);
      const first = await admit("text-input");
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
      expect(await admit("text-input")).toBe(first);
      await expect(admit("image-input")).rejects.toThrow();
      await expect(admit("control-reset")).rejects.toThrow();
      t.provider.calls[0]!.finish("done");
      await t.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const legacy = crypto.randomUUID();
      await t.conversation.submit(
        { type: "input", content: "legacy", requestId: legacy },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(2));
      await expect(
        t.harness.commit(async (tx) => {
          await checkAdmissionRequest(tx, t.conversation.id, legacy, "image-input");
        }, BACKGROUND_CONTEXT),
      ).rejects.toThrow();
      t.provider.calls[1]!.finish("done");
      await t.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await t.close();
    }
  });
  it("reopens pending SDK document bindings and original files from temporary SQLite storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cpd-attachment-reopen-"));
    roots.push(root);
    const provider = testModels();
    const create = async () =>
      Harness.open(
        await openNodeSqliteStorage(join(root, "test.sqlite")),
        { models: provider.models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
    let harness = await create();
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    const id = conversation.id;
    const catalog = createPendingImageCatalog(harness, id, async () => {});
    const ref = await createAttachmentService(root, catalog.authorization, processor).upload(
      "image/png",
      png,
    );
    await harness.close(BACKGROUND_CONTEXT);
    harness = await create();
    try {
      const reopened = createPendingImageCatalog(harness, id, async () => {});
      expect((await reopened.get(ref.id))?.mimeType).toBe("image/png");
      expect(
        await createAttachmentService(root, reopened.authorization, processor).readPending(ref.id),
      ).toEqual(png);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
  it("uploads and previews within conversation catalog, rejects malformed, archive, deletion and stale refs", async () => {
    const t = await setup();
    try {
      const response = await t.upload();
      expect(response.status).toBe(201);
      const ref = (await response.json()) as { id: string };
      expect(Object.keys(ref).sort()).toEqual(["id", "mimeType", "prepared", "size"]);
      const preview = await t.app.request(`${t.base}/attachments/${ref.id}`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
      expect((await t.app.request(`${t.base}/attachments/..%2Fetc`)).status).toBe(404);
      expect((await t.upload(png, "image/jpeg")).status).toBe(400);
      expect((await t.upload(png, "image/gif")).status).toBe(415);
      expect((await t.upload(new Uint8Array(IMAGE_MAX_BYTES + 1))).status).toBe(413);
      const catalog = createPendingImageCatalog(
        t.harness,
        t.conversation.id,
        t.writable(t.conversation.id),
      );
      await t.mark(t.conversation.id, "archived");
      expect((await t.upload()).status).toBe(409);
      expect((await t.app.request(`${t.base}/attachments/${ref.id}`)).status).toBe(200);
      await expect(catalog.revoke(ref.id)).rejects.toThrow();
      await t.mark(t.conversation.id);
      await catalog.revoke(ref.id);
      expect((await t.app.request(`${t.base}/attachments/${ref.id}`)).status).toBe(404);
      await expect(
        t.backend.admit(String(t.conversation.id), {
          text: "",
          images: [ref.id],
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      // Explicit revoke does not remove the retained original file.
      expect(await readFile(join(t.root, "attachments", ref.id))).toEqual(png);
      await t.mark(t.conversation.id, "deleted");
      expect((await t.app.request(`${t.base}/attachments/${ref.id}`)).status).toBe(404);
      expect((await t.upload()).status).toBe(404);
    } finally {
      await t.close();
    }
  });
  it("passes image-only and image+text to existing admission, rejects unsupported models, and retries unchanged IDs", async () => {
    const t = await setup();
    try {
      const ref = (await (await t.upload()).json()) as { id: string };
      t.select({ key: "text", input: ["text"] });
      await expect(
        t.backend.admit(String(t.conversation.id), {
          text: "",
          images: [ref.id],
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      expect(t.calls).toHaveLength(0);
      t.select({ key: "vision", input: ["text", "image"] });
      const draft = { text: "", images: [ref.id], requestId: crypto.randomUUID() };
      const first = await t.backend.admit(String(t.conversation.id), draft);
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
      expect(await t.backend.admit(String(t.conversation.id), draft)).toEqual(first);
      expect(t.calls[0]?.content).toEqual([
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
      expect(t.calls[1]?.requestId).toBe(draft.requestId);
      await expect(
        t.backend.admit(String(t.conversation.id), { ...draft, text: "changed" }),
      ).rejects.toThrow();
      await expect(
        t.backend.admit(String(t.conversation.id), {
          text: "",
          images: [ref.id, ref.id],
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
      t.provider.calls[0]!.finish("done");
      await t.conversation.waitForIdle(BACKGROUND_CONTEXT);
      await t.backend.admit(String(t.conversation.id), {
        text: "hello",
        images: [ref.id],
        requestId: crypto.randomUUID(),
      });
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(2));
      expect(t.calls.at(-1)?.content).toEqual([
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
      t.provider.calls[1]!.finish("done");
      await t.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await t.close();
    }
  });
  it("resolves actual saved user and orphan tool image parts through inherited SDK history, not source catalog", async () => {
    const t = await setup();
    try {
      await writeFile(join(t.root, "tool.png"), png);
      const ref = (await (await t.upload()).json()) as { id: string };
      await t.backend.admit(String(t.conversation.id), {
        text: "see",
        images: [ref.id],
        requestId: crypto.randomUUID(),
      });
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
      t.provider.calls[0]!.tools([
        { id: "image-read", name: "read", arguments: { path: "tool.png" } },
      ]);
      await vi.waitFor(() => expect(t.provider.calls).toHaveLength(2));
      t.provider.calls[1]!.finish("done");
      await t.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const context = await t.conversation.context(BACKGROUND_CONTEXT);
      const user = context.entries.find((e) => e.kind === "pi.user")!;
      const tool = context.entries.find((e) => e.kind === "pi.tool-result")!;
      expect(user).toBeDefined();
      expect(tool).toBeDefined();
      const fork = await t.conversation.fork(
        tool.id,
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      await t.add(fork.id);
      const other = await t.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      await t.add(other.id);
      const imagePath = (id: number, entry: number, part: number) =>
        `/api/chats/${id}/images/${entry}/0/${part}`;
      const inherited = await t.app.request(imagePath(fork.id, tool.id, 0));
      expect(inherited.status).toBe(200);
      expect(Buffer.from(await inherited.arrayBuffer())).toEqual(png);
      const userImage = await t.app.request(imagePath(fork.id, user.id, 1));
      expect(userImage.status).toBe(200);
      expect(Buffer.from(await userImage.arrayBuffer())).toEqual(png);
      expect((await t.app.request(imagePath(other.id, tool.id, 0))).status).toBe(404);
      expect((await t.app.request(`/api/chats/${fork.id}/attachments/${ref.id}`)).status).toBe(404);
      expect((await t.app.request(imagePath(fork.id, user.id, 0))).status).toBe(404);
      expect((await t.app.request(`/api/chats/${fork.id}/images/${tool.id}/-1/0`)).status).toBe(
        404,
      );
      expect((await t.app.request(`/api/chats/${fork.id}/images/${tool.id}/999999/0`)).status).toBe(
        404,
      );
      await t.mark(t.conversation.id, "deleted");
      expect((await t.app.request(imagePath(fork.id, tool.id, 0))).status).toBe(200);
      expect((await t.app.request(imagePath(t.conversation.id, tool.id, 0))).status).toBe(404);
      await t.mark(fork.id, "archived");
      expect((await t.app.request(imagePath(fork.id, tool.id, 0))).status).toBe(200);
      await t.mark(fork.id, "deleted");
      expect((await t.app.request(imagePath(fork.id, tool.id, 0))).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});
