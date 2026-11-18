import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

describe("SSH loopback HTTP contract", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-ssh-contract-"));
    chat = await openChat(directory, testModels().models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts the documented forwarded host for catalog, events, attachments and chat routes", async () => {
    const app = createApp(chat);
    const base = "http://127.0.0.1:5173";
    const id = String(chat.conversation.id);
    const headers = { Origin: base, "Sec-Fetch-Site": "same-origin" };
    expect((await app.request(`${base}/api/chats`, { headers })).status).toBe(200);
    expect(
      (
        await app.request("http://127.0.0.1:3000/api/chats", {
          headers: { Origin: "http://127.0.0.1:3000", "Sec-Fetch-Site": "same-origin" },
        })
      ).status,
    ).toBe(200);
    expect((await app.request(`${base}/api/chats/${id}/context`, { headers })).status).toBe(200);
    const stream = await app.request(`${base}/api/chats/${id}/events?view=${crypto.randomUUID()}`, {
      headers,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain("event: state");
    } finally {
      await reader.cancel();
    }
    const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
    const upload = await app.request(`${base}/api/chats/${id}/attachments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "image/png" },
      body: Uint8Array.from(png),
    });
    expect(upload.status).toBe(201);
    const ref = (await upload.json()) as { id: string };
    const image = await app.request(`${base}/api/chats/${id}/attachments/${ref.id}`, { headers });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("image/png");
    expect((await app.request(`${base}/api/chats/${id}/questions`, { headers })).status).toBe(200);
    expect((await app.request(`${base}/api/chats/${id}/shell`, { headers })).status).toBe(200);
  });

  it.each([
    ["LAN Host", "http://192.0.2.1:5173", {}],
    ["unallowed port", "http://127.0.0.1:5191", {}],
    ["foreign Origin", "http://127.0.0.1:5173", { Origin: "http://192.0.2.1:5173" }],
    ["cross-site fetch", "http://127.0.0.1:5173", { "Sec-Fetch-Site": "cross-site" }],
  ])("rejects %s before serving API data", async (_label, base, headers) => {
    const response = await createApp(chat).request(`${base}/api/chats`, { headers });
    expect(response.status).toBe(403);
  });
});

it("documents the loopback-only SSH argument vector without starting SSH", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const command = readme.match(
    /^ssh -o ExitOnForwardFailure=yes -L .+ -N user@example\.invalid$/m,
  )?.[0];
  expect(command?.split(" ")).toEqual([
    "ssh",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    "127.0.0.1:5173:127.0.0.1:5173",
    "-N",
    "user@example.invalid",
  ]);
});
