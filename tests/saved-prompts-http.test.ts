import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { testModels } from "./models.ts";

describe("saved prompts HTTP", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-prompt-http-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  it("validates routes, persists retries and enforces revisions without provider calls", async () => {
    const app = createApp(chat);
    const base = "http://127.0.0.1:3000/api/saved-prompts";
    const request = {
      requestId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      title: "Title",
      text: "Literal",
    };
    const send = (method: string, url: string, body: unknown) =>
      app.request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await send("POST", base, request);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await (await send("POST", base, request)).json()).toEqual(await first.json());
    expect((await send("POST", base, { ...request, text: "Changed" })).status).toBe(409);
    expect((await send("POST", base, { ...request, extra: true })).status).toBe(400);
    const update = {
      ...request,
      requestId: crypto.randomUUID(),
      expectedRevision: 1,
      text: "Updated",
    };
    expect((await send("PUT", `${base}/${request.id}`, update)).status).toBe(200);
    expect(
      (await send("PUT", `${base}/${request.id}`, { ...update, requestId: crypto.randomUUID() }))
        .status,
    ).toBe(409);
    expect((await send("PUT", `${base}/${crypto.randomUUID()}`, update)).status).toBe(400);
    const remove = { id: request.id, requestId: crypto.randomUUID(), expectedRevision: 2 };
    expect((await send("DELETE", `${base}/${request.id}`, remove)).status).toBe(200);
    expect((await send("DELETE", `${base}/${request.id}`, remove)).status).toBe(200);
    expect(
      (await send("DELETE", `${base}/${request.id}`, { ...remove, requestId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    expect((await app.request(`${base}?limit=21`)).status).toBe(400);
    expect(
      (await app.request(base, { headers: { origin: "http://example.invalid" } })).status,
    ).toBe(403);
    expect((await app.request(base, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(
      403,
    );
    expect((await app.request("http://192.0.2.1:3000/api/saved-prompts")).status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });
});
