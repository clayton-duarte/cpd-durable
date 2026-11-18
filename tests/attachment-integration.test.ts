import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cpd-attachment-integration-"));
  roots.push(root);
  const provider = testModels();
  const available = await provider.models.getAvailable();
  const models = available.map((model) => ({
    ...model,
    input: [...model.input, ...(model.input.includes("image") ? [] : ["image" as const])],
  }));
  const spy = vi
    .spyOn(provider.models, "getAvailable")
    .mockImplementation(async (id) =>
      id ? models.filter((model) => model.provider === id) : models,
    );
  const chat = await openChat(root, provider.models, root);
  const app = createApp(chat);
  const created = await chat.chats.create(crypto.randomUUID());
  const base = `/api/chats/${created.id}`;
  const post = (path: string, value: unknown) =>
    app.request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const upload = (
    value: Uint8Array = png,
    headers: Record<string, string> = { "Content-Type": "image/png" },
  ) =>
    app.request(`http://localhost:3000${base}/attachments`, {
      method: "POST",
      headers,
      body: Uint8Array.from(value),
    });
  return { root, provider, chat, app, base, created, post, upload, models, spy };
}
it("wires guarded uploads, image admission, queue, retry and fork-aware saved bytes", async () => {
  const t = await setup();
  try {
    expect(
      (await t.upload(png, { "Content-Type": "image/png", Origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await t.upload(new Uint8Array(130_000))).status).toBe(400);
    expect(
      (
        await t.post(`${t.base}/input`, {
          text: "x".repeat(130_000),
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(413);
    const uploaded = await t.upload();
    expect(uploaded.status).toBe(201);
    const ref = (await uploaded.json()) as { id: string };
    const preview = await t.app.request(`http://localhost:3000${t.base}/attachments/${ref.id}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    const request = { text: "", images: [ref.id], requestId: crypto.randomUUID() };
    const response = await t.post(`${t.base}/input`, request);
    expect(response.status).toBe(202);
    const first: unknown = await response.json();
    await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
    expect((await t.chat.chats.list()).chats.find((item) => item.id === t.created.id)?.title).toBe(
      "Image attachment",
    );
    expect(JSON.stringify(t.provider.calls[0]!.context.messages)).toContain(png.toString("base64"));
    expect(await (await t.post(`${t.base}/input`, request)).json()).toEqual(first);
    expect((await t.post(`${t.base}/input`, { ...request, text: "different" })).status).toBe(409);
    expect(
      (await t.post(`${t.base}/input`, { text: "text", requestId: request.requestId })).status,
    ).toBe(409);
    expect(
      (await t.post(`${t.base}/control`, { type: "continue", requestId: request.requestId }))
        .status,
    ).toBe(409);
    const follow = await t.post(`${t.base}/input`, {
      text: "later",
      images: [ref.id],
      mode: "followUp",
      requestId: crypto.randomUUID(),
    });
    expect(follow.status).toBe(202);
    const followId = ((await follow.json()) as { id: string }).id;
    const withdrawn = await t.post(`${t.base}/withdraw`, { id: followId });
    expect(withdrawn.status).toBe(200);
    expect(((await withdrawn.json()) as { status: string }).status).toBe("aborted");
    const steer = await t.post(`${t.base}/input`, {
      text: "steer",
      images: [ref.id],
      mode: "steer",
      requestId: crypto.randomUUID(),
    });
    expect(steer.status).toBe(202);
    const steerId = ((await steer.json()) as { id: string }).id;
    expect(
      ((await (await t.post(`${t.base}/withdraw`, { id: steerId })).json()) as { status: string })
        .status,
    ).toBe("aborted");
    const scope = await t.chat.chats.resolve(t.created.id);
    if (!scope) throw new Error("missing chat");
    const entries = await scope.conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT);
    const user = entries.items.find((entry) => entry.kind === "pi.user");
    expect(user).toBeDefined();
    const fork = await t.chat.chats.fork(t.created.id, crypto.randomUUID(), String(user!.id));
    expect(
      (await t.app.request(`http://localhost:3000/api/chats/${fork.id}/attachments/${ref.id}`))
        .status,
    ).toBe(404);
    const saved = `/api/chats/${fork.id}/images/${user!.id}/0/0`;
    expect((await t.app.request(`http://localhost:3000${saved}`)).status).toBe(200);
    const other = await t.chat.chats.create(crypto.randomUUID());
    expect(
      (await t.app.request(`http://localhost:3000/api/chats/${other.id}/images/${user!.id}/0/0`))
        .status,
    ).toBe(404);
    t.provider.calls[0]!.finish("done");
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await t.chat.chats.change(t.created.id, "archive");
    expect((await t.upload()).status).toBe(409);
    expect(
      (await t.app.request(`http://localhost:3000${t.base}/attachments/${ref.id}`)).status,
    ).toBe(200);
    await t.chat.chats.change(t.created.id, "delete");
    expect((await t.app.request(`http://localhost:3000${saved}`)).status).toBe(200);
    expect(
      (await t.app.request(`http://localhost:3000${t.base}/attachments/${ref.id}`)).status,
    ).toBe(404);
    const summary = (await t.chat.chats.list()).chats.find((item) => item.id === t.created.id);
    expect(summary).toBeUndefined();
  } finally {
    await t.chat.close();
  }
});
it("reopens original files and retries the same image request; legacy IDs fail closed", async () => {
  const t = await setup();
  let reopened: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    const ref = (await (await t.upload()).json()) as { id: string };
    const request = { text: "Look", images: [ref.id], requestId: crypto.randomUUID() };
    const original = await t.post(`${t.base}/input`, request);
    expect(original.status).toBe(202);
    const submitted: unknown = await original.json();
    await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
    t.provider.calls[0]!.finish("done");
    const scope = await t.chat.chats.resolve(t.created.id);
    if (!scope) throw new Error("missing chat");
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await t.chat.close();
    reopened = await openChat(t.root, t.provider.models, t.root);
    const app = createApp(reopened);
    const post = (body: unknown) =>
      app.request(`http://localhost:3000${t.base}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await app.request(`http://localhost:3000${t.base}/attachments/${ref.id}`)).status).toBe(
      200,
    );
    expect(await (await post(request)).json()).toEqual(submitted);
    const reopenedScope = await reopened.chats.resolve(t.created.id);
    if (!reopenedScope) throw new Error("missing reopened chat");
    const legacy = crypto.randomUUID();
    await reopenedScope.conversation.submit(
      { type: "input", content: "legacy", requestId: legacy },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(t.provider.calls).toHaveLength(2));
    expect((await post({ text: "legacy", requestId: legacy })).status).toBe(409);
    t.provider.calls[1]!.finish("done");
    await reopenedScope.conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    if (reopened) await reopened.close();
    else await t.chat.close();
  }
});
it("rejects unsupported server model and model changes between resolution and transaction", async () => {
  const t = await setup();
  try {
    const ref = (await (await t.upload()).json()) as { id: string };
    const spy = t.spy;
    spy.mockImplementation(async () => t.models.map((model) => ({ ...model, input: ["text"] })));
    expect(
      (
        await t.post(`${t.base}/input`, {
          text: "",
          images: [ref.id],
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    const scope = await t.chat.chats.resolve(t.created.id);
    if (!scope) throw new Error("missing chat");
    const original = await scope.configuration();
    const selected = t.models.find(
      (model) =>
        model.id === original.selection.modelId && model.provider === original.selection.provider,
    )!;
    const alternate = { ...selected, id: `${selected.id}-test-alternate` };
    let changed = false;
    spy.mockImplementation(async () => {
      if (!changed) {
        changed = true;
        await scope.configure(original.selection, { ...original.selection, modelId: alternate.id });
      }
      return [...t.models, alternate];
    });
    expect(
      (
        await t.post(`${t.base}/input`, {
          text: "",
          images: [ref.id],
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(t.provider.calls).toHaveLength(0);
  } finally {
    await t.chat.close();
  }
});
it("uses one request identity namespace for control, text and image input", async () => {
  const t = await setup();
  try {
    const ref = (await (await t.upload()).json()) as { id: string };
    const control = { type: "reset", handoff: "", requestId: crypto.randomUUID() };
    const first = await t.post(`${t.base}/control`, control);
    expect(first.status).toBe(202);
    expect(await (await t.post(`${t.base}/control`, control)).json()).toEqual(await first.json());
    expect(
      (
        await t.post(`${t.base}/input`, {
          text: "",
          images: [ref.id],
          requestId: control.requestId,
        })
      ).status,
    ).toBe(409);
    const text = { text: "plain", requestId: crypto.randomUUID() };
    expect((await t.post(`${t.base}/input`, text)).status).toBe(202);
    await vi.waitFor(() => expect(t.provider.calls).toHaveLength(1));
    expect(
      (await t.post(`${t.base}/input`, { text: "", images: [ref.id], requestId: text.requestId }))
        .status,
    ).toBe(409);
    t.provider.calls[0]!.finish("done");
    const scope = await t.chat.chats.resolve(t.created.id);
    if (!scope) throw new Error("missing chat");
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    await t.chat.close();
  }
});
