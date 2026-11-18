import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

describe("conversation draft service", () => {
  it("clears a matching image draft on real host admission and preserves later edits on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draft-image-admission-"));
    const provider = testModels();
    const original = provider.models.getAvailable.bind(provider.models);
    vi.spyOn(provider.models, "getAvailable").mockImplementation(async (id) =>
      (await original(id)).map((model) => ({ ...model, input: ["text", "image"] })),
    );
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
      const upload = await app.request(`${base}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png,
      });
      expect(upload.status).toBe(201);
      const ref = (await upload.json()) as { id: string; mimeType: string; size: number };
      const image = { id: ref.id, mimeType: ref.mimeType, size: ref.size, name: "fixture.png" };
      const json = (path: string, method: string, body: unknown) =>
        app.request(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const get = async (): Promise<unknown> => (await app.request(`${base}/draft`)).json();
      expect(
        (
          await json("/draft", "PUT", {
            expectedRevision: 0,
            content: { text: "  image  ", images: [image] },
          })
        ).status,
      ).toBe(200);
      const input = {
        requestId: crypto.randomUUID(),
        text: "image",
        images: [ref.id],
        draft: { revision: 1, text: "  image  ", images: [ref.id] },
      };
      expect((await json("/input", "POST", input)).status).toBe(202);
      expect(await get()).toEqual({ revision: 2, content: { text: "", images: [] } });
      expect(
        (
          await json("/draft", "PUT", {
            expectedRevision: 2,
            content: { text: "image", images: [image] },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await json("/input", "POST", {
            ...input,
            draft: { revision: 3, text: "image", images: [ref.id] },
          })
        ).status,
      ).toBe(202);
      expect(await get()).toEqual({ revision: 3, content: { text: "image", images: [image] } });
      expect(
        (
          await json("/input", "POST", {
            ...input,
            requestId: crypto.randomUUID(),
            mode: "followUp",
          })
        ).status,
      ).toBe(202);
      expect(await get()).toEqual({ revision: 3, content: { text: "image", images: [image] } });
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("clears only the matching revision on first successful admission, never on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draft-admit-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const request = (path: string, method: string, body?: unknown) =>
        app.request(base + path, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
      expect(
        (
          await request("/draft", "PUT", {
            expectedRevision: 0,
            content: { text: "  hello  ", images: [] },
          })
        ).status,
      ).toBe(200);
      const input = {
        requestId: crypto.randomUUID(),
        text: "hello",
        draft: { revision: 1, text: "  hello  ", images: [] },
      };
      expect((await request("/input", "POST", input)).status).toBe(202);
      expect(await (await request("/draft", "GET")).json()).toEqual({
        revision: 2,
        content: { text: "", images: [] },
      });
      expect(
        (
          await request("/draft", "PUT", {
            expectedRevision: 2,
            content: { text: "hello", images: [] },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request("/input", "POST", {
            ...input,
            draft: { revision: 3, text: "hello", images: [] },
          })
        ).status,
      ).toBe(202);
      expect(await (await request("/draft", "GET")).json()).toEqual({
        revision: 3,
        content: { text: "hello", images: [] },
      });
      const busy = {
        requestId: crypto.randomUUID(),
        text: "hello",
        draft: { revision: 3, text: "hello", images: [] },
      };
      expect((await request("/input", "POST", busy)).status).toBe(409);
      expect(
        ((await (await request("/draft", "GET")).json()) as { revision: number }).revision,
      ).toBe(3);
      const followUp = {
        requestId: crypto.randomUUID(),
        text: "hello",
        mode: "followUp",
        draft: { revision: 1, text: "  hello  ", images: [] },
      };
      expect((await request("/input", "POST", followUp)).status).toBe(202);
      expect(await (await request("/draft", "GET")).json()).toEqual({
        revision: 3,
        content: { text: "hello", images: [] },
      });
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("accepts only pending images owned by the same chat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draft-images-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const main = String(host.conversation.id);
      const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
      const upload = await app.request(`http://localhost:3000/api/chats/${main}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png,
      });
      expect(upload.status).toBe(201);
      const ref = (await upload.json()) as { id: string; mimeType: string; size: number };
      const draft = {
        expectedRevision: 0,
        content: { text: "image", images: [{ ...ref, name: "synthetic.png" }] },
      };
      // Upload responses also contain preparation details; only the public reference fields are stored.
      draft.content.images = [
        { id: ref.id, mimeType: ref.mimeType, size: ref.size, name: "synthetic.png" },
      ];
      const put = (id: string) =>
        app.request(`http://localhost:3000/api/chats/${id}/draft`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(draft),
        });
      expect((await put(main)).status).toBe(200);
      const other = await host.chats.create(crypto.randomUUID());
      expect((await put(other.id)).status).toBe(409);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists literal drafts, enforces CAS and lifecycle without provider calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "draft-test-"));
    const provider = testModels();
    let host = await openChat(dir, provider.models, dir);
    try {
      let app = createApp(host);
      const path = `http://localhost:3000/api/chats/${host.conversation.id}/draft`;
      const get = () => app.request(path);
      const put = (body: unknown) =>
        app.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect(await (await get()).json()).toEqual({
        revision: 0,
        content: { text: "", images: [] },
      });
      const draft = { expectedRevision: 0, content: { text: "  synthetic draft\n", images: [] } };
      expect((await put(draft)).status).toBe(200);
      expect((await put(draft)).status).toBe(409);
      expect(
        (
          await put({
            expectedRevision: 1,
            content: {
              text: "bad",
              images: [{ id: crypto.randomUUID(), name: "x.png", mimeType: "image/png", size: 4 }],
            },
          })
        ).status,
      ).toBe(409);
      expect(((await (await get()).json()) as { content: { text: string } }).content.text).toBe(
        "  synthetic draft\n",
      );
      await host.close();
      host = await openChat(dir, provider.models, dir);
      app = createApp(host);
      expect(((await (await get()).json()) as { revision: number }).revision).toBe(1);
      await host.chats.change(String(host.conversation.id), "archive");
      expect((await get()).status).toBe(200);
      expect((await put({ ...draft, expectedRevision: 1 })).status).toBe(409);
      await host.chats.change(String(host.conversation.id), "delete");
      expect((await get()).status).toBe(404);
      expect(provider.calls).toHaveLength(0);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
