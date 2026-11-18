import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { DraftDoc } from "../src/server/drafts.ts";
import { imageRequestDigest } from "../src/server/attachment-catalog.ts";
import { testModels } from "./models.ts";
import { draftInputText } from "../src/shared/draft-intent.ts";

describe("draft attempt HTTP integration", () => {
  it("binds tangent intent to the original draft and admits its deterministic input once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-tangent-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const send = (path: string, method: string, body: unknown) =>
        app.request(base + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const text = "/tangent investigate";
      const intent = { kind: "tangent-handoff-request", version: 1, command: "tangent" } as const;
      const requestId = crypto.randomUUID();
      expect(
        (await send("/draft", "PUT", { expectedRevision: 0, content: { text, images: [] } }))
          .status,
      ).toBe(200);
      const attempt = { requestId, draftRevision: 1, text, images: [], mode: "reject", intent };
      expect((await send("/draft/attempt", "POST", attempt)).status).toBe(200);
      expect(
        (
          await send("/draft/attempt", "POST", {
            ...attempt,
            intent: { ...intent, command: "side" },
          })
        ).status,
      ).toBe(409);
      const input = {
        requestId,
        text: draftInputText(text, intent),
        draft: { revision: 1, text, images: [], attempt: true },
      };
      expect((await send("/input", "POST", { ...input, text: "arbitrary" })).status).toBe(409);
      const admitted = await send("/input", "POST", input);
      expect(admitted.status).toBe(202);
      expect(await admitted.json()).toMatchObject({ clearedDraftRevision: 2 });
      expect((await send("/input", "POST", input)).status).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("admits an escaped leading bang as literal model input with its original draft snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-escaped-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const post = (path: string, method: string, body: unknown) =>
        app.request(base + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const text = "\\!literal";
      const requestId = crypto.randomUUID();
      expect(
        (await post("/draft", "PUT", { expectedRevision: 0, content: { text, images: [] } }))
          .status,
      ).toBe(200);
      expect(
        (
          await post("/draft/attempt", "POST", {
            requestId,
            draftRevision: 1,
            text,
            images: [],
            mode: "reject",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post("/input", "POST", {
            requestId,
            text: "!literal",
            draft: { revision: 1, text, images: [], attempt: true },
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not clear a newer draft on the original first admission", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-late-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const send = (path: string, method: string, body: unknown) =>
        app.request(base + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect(
        (
          await send("/draft", "PUT", {
            expectedRevision: 0,
            content: { text: "original", images: [] },
          })
        ).status,
      ).toBe(200);
      const attempt = {
        requestId: crypto.randomUUID(),
        draftRevision: 1,
        text: "original",
        images: [],
        mode: "reject",
      };
      expect((await send("/draft/attempt", "POST", attempt)).status).toBe(200);
      expect(
        (
          await send("/draft", "PUT", {
            expectedRevision: 1,
            content: { text: "newer", images: [] },
          })
        ).status,
      ).toBe(200);
      const input = {
        requestId: attempt.requestId,
        text: "original",
        draft: { revision: 1, text: "original", images: [], attempt: true },
      };
      const scope = (await host.chats.resolve(String(host.conversation.id)))!;
      await expect(
        scope.admit(
          { type: "input", requestId: attempt.requestId, content: "different", whenBusy: "reject" },
          {
            draft: { ...input.draft, attempt: true },
            digest: imageRequestDigest({ text: "original", images: [], mode: "reject" }),
          },
        ),
      ).rejects.toMatchObject({ status: 409 });
      const admitted = await send("/input", "POST", input);
      expect(admitted.status).toBe(202);
      expect(await admitted.json()).not.toHaveProperty("clearedDraftRevision");
      expect(await (await app.request(base + "/draft")).json()).toEqual({
        revision: 2,
        content: { text: "newer", images: [] },
      });
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reopens unknown, admits once, and preserves a newer draft across retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-http-"));
    const provider = testModels();
    let host = await openChat(dir, provider.models, dir);
    try {
      let app = createApp(host);
      const base = `http://localhost:3000/api/chats/${host.conversation.id}`;
      const request = (path: string, method = "GET", body?: unknown, headers = {}) =>
        app.request(base + path, {
          method,
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const draft = { expectedRevision: 0, content: { text: "  hello  ", images: [] } };
      const attempt = {
        requestId: crypto.randomUUID(),
        draftRevision: 1,
        text: draft.content.text,
        images: [],
        mode: "reject",
      };
      expect((await request("/draft", "PUT", draft)).status).toBe(200);
      expect(
        (await request("/draft/attempt", "POST", { ...attempt, draftRevision: 0 })).status,
      ).toBe(409);
      expect((await request("/draft/attempt", "POST", { ...attempt, extra: "x" })).status).toBe(
        400,
      );
      expect(
        (await request("/draft/attempt", "POST", attempt, { origin: "https://example.invalid" }))
          .status,
      ).toBe(403);
      expect(
        (await request("/draft/attempt", "POST", attempt, { "sec-fetch-site": "cross-site" }))
          .status,
      ).toBe(403);
      expect((await request("/draft/attempt", "POST", attempt)).status).toBe(200);
      await host.close();
      host = await openChat(dir, provider.models, dir);
      app = createApp(host);
      const get = () => request(`/draft/attempt/${attempt.requestId}`);
      expect(await (await get()).json()).toMatchObject({ record: attempt, admission: "unknown" });
      expect((await get()).headers.get("cache-control")).toBe("no-store");
      expect(provider.calls).toHaveLength(0);
      const input = {
        requestId: attempt.requestId,
        text: "hello",
        mode: "reject",
        draft: { revision: 1, text: attempt.text, images: [], attempt: true },
      };
      expect((await request("/input", "POST", { ...input, mode: "followUp" })).status).toBe(409);
      expect(
        (
          await request("/input", "POST", {
            ...input,
            draft: { ...input.draft, text: "hello" },
          })
        ).status,
      ).toBe(409);
      expect((await request("/input", "POST", { ...input, draft: undefined })).status).toBe(409);
      expect(
        (await request("/input", "POST", { ...input, requestId: crypto.randomUUID() })).status,
      ).toBe(409);
      const admitted = await request("/input", "POST", input);
      expect(admitted.status).toBe(202);
      const result = (await admitted.json()) as { id: string };
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      expect(await (await get()).json()).toMatchObject({
        record: attempt,
        admission: "admitted",
        submissionId: result.id,
      });
      expect(
        (
          await request("/draft", "PUT", {
            expectedRevision: 2,
            content: { text: "newer", images: [] },
          })
        ).status,
      ).toBe(200);
      expect((await request("/draft/attempt", "POST", attempt)).status).toBe(200);
      expect(
        (await request("/draft/attempt", "POST", { ...attempt, text: "changed" })).status,
      ).toBe(409);
      expect((await request("/input", "POST", input)).status).toBe(202);
      expect(
        (
          await request("/input", "POST", {
            ...input,
            draft: { ...input.draft, revision: 3, text: "newer" },
            text: "newer",
          })
        ).status,
      ).toBe(409);
      expect(await (await request("/draft")).json()).toEqual({
        revision: 3,
        content: { text: "newer", images: [] },
      });
      expect(provider.calls).toHaveLength(1);
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("checks image ownership and lifecycle in the transaction and accepts image-only intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attempt-image-"));
    const provider = testModels();
    const available = provider.models.getAvailable.bind(provider.models);
    vi.spyOn(provider.models, "getAvailable").mockImplementation(async (id) =>
      (await available(id)).map((model) => ({ ...model, input: ["text", "image"] })),
    );
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const id = String(host.conversation.id);
      const base = (chatId: string) => `http://localhost:3000/api/chats/${chatId}`;
      const json = (chatId: string, path: string, method: string, body: unknown) =>
        app.request(base(chatId) + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
      const upload = await app.request(`${base(id)}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png,
      });
      const image = (await upload.json()) as { id: string; mimeType: string; size: number };
      const content = {
        text: "  ",
        images: [{ id: image.id, mimeType: image.mimeType, size: image.size, name: "a.png" }],
      };
      expect((await json(id, "/draft", "PUT", { expectedRevision: 0, content })).status).toBe(200);
      const attempt = {
        requestId: crypto.randomUUID(),
        draftRevision: 1,
        text: "  ",
        images: [image.id],
        mode: "reject",
      };
      const other = await host.chats.create(crypto.randomUUID());
      const scope = (await host.chats.resolve(other.id))!;
      // Simulate a stale draft reference: admission must check the transaction's pending catalog.
      await scope.conversation.commit(async (tx) => {
        const draft = await tx.doc(DraftDoc, scope.conversation.id);
        draft.revision = 1;
        draft.content = content as typeof draft.content;
      }, BACKGROUND_CONTEXT);
      expect((await json(other.id, "/draft/attempt", "POST", attempt)).status).toBe(409);
      expect((await json(id, "/draft/attempt", "POST", attempt)).status).toBe(200);
      const input = {
        requestId: attempt.requestId,
        text: "",
        images: [image.id],
        draft: { revision: 1, text: "  ", images: [image.id], attempt: true },
      };
      expect((await json(id, "/input", "POST", input)).status).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      expect(
        await (await app.request(`${base(id)}/draft/attempt/${attempt.requestId}`)).json(),
      ).toMatchObject({ admission: "admitted", record: attempt });
      expect((await json(id, "/input", "POST", input)).status).toBe(202);
      expect(provider.calls).toHaveLength(1);
      provider.calls[0]!.finish("done");
      await host.conversation.waitForIdle(BACKGROUND_CONTEXT);
      await host.chats.change(id, "archive");
      expect((await json(id, "/draft/attempt", "POST", attempt)).status).toBe(409);
      expect((await app.request(`${base(id)}/draft/attempt/${attempt.requestId}`)).status).toBe(
        200,
      );
      await host.chats.change(id, "delete");
      expect((await app.request(`${base(id)}/draft/attempt/${attempt.requestId}`)).status).toBe(
        404,
      );
      expect((await json(id, "/draft/attempt", "POST", attempt)).status).toBe(404);
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
