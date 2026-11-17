import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { present } from "../src/server/presentation.ts";
import { ChatStateSchema, SubmissionSchema } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

describe("single durable chat", () => {
  let dataDir: string;
  let provider: ReturnType<typeof testModels>;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cpd-chat-test-"));
    provider = testModels();
    chat = await openChat(dataDir, provider.models);
    app = createApp(chat.conversation);
  });
  afterEach(async () => {
    await chat.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const input = (text: string, requestId = crypto.randomUUID()) =>
    new Request("http://localhost:3000/api/input", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ text, requestId }),
    });

  async function state() {
    const watch = await chat.conversation.watch(BACKGROUND_CONTEXT);
    try {
      return ChatStateSchema.parse(present(watch.value));
    } finally {
      await watch.stop();
    }
  }

  it("submits, streams real SDK state, rejects busy input and deduplicates retries", async () => {
    const id = crypto.randomUUID();
    const admitted = SubmissionSchema.parse(await (await app.request(input("hello", id))).json());
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const call = provider.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("No model call");
    call.partial("Hello");
    await vi.waitFor(async () => expect((await state()).partial).toBe("Hello"));
    expect((await app.request(input("another"))).status).toBe(409);
    const duplicate = SubmissionSchema.parse(await (await app.request(input("hello", id))).json());
    expect(duplicate).toEqual(admitted);
    call.finish("Hello there");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(await state()).toMatchObject({
      busy: false,
      partial: "",
      failure: null,
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "Hello there" },
      ],
    });
    const after = SubmissionSchema.parse(await (await app.request(input("hello", id))).json());
    expect(after).toEqual(admitted);
    expect(provider.calls).toHaveLength(1);
  });

  it("reopens the same conversation and resumes an unfinished run", async () => {
    await app.request(input("keep this"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const conversationId = chat.conversation.id;
    await chat.close();
    provider = testModels();
    chat = await openChat(dataDir, provider.models);
    expect(chat.conversation.id).toBe(conversationId);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]?.finish("Recovered");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await state()).messages.map((message) => message.text)).toEqual([
      "keep this",
      "Recovered",
    ]);
  });

  it("stops explicitly and retains partial output as interrupted", async () => {
    await app.request(input("long response"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]?.partial("Partial answer");
    await vi.waitFor(async () => expect((await state()).partial).toBe("Partial answer"));
    expect((await app.request("http://localhost:3000/api/stop", { method: "POST" })).status).toBe(
      204,
    );
    expect(await state()).toMatchObject({ busy: false, failure: "Response stopped." });
    expect((await state()).messages.at(-1)).toMatchObject({
      text: "Partial answer",
      interrupted: true,
    });
  });

  it("sends initial state and updates over SSE; disconnecting does not stop work", async () => {
    const response = await app.request("http://localhost:3000/api/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing stream");
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain("event: state");
    await app.request(input("continue without browser"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain("continue without browser");
    await reader.cancel();
    provider.calls[0]?.finish("Still completed");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await state()).messages.at(-1)?.text).toBe("Still completed");
    const reconnect = await app.request("http://localhost:3000/api/events");
    const again = reconnect.body?.getReader();
    if (!again) throw new Error("Missing reconnect stream");
    expect(new TextDecoder().decode((await again.read()).value)).toContain("Still completed");
    await again.cancel();
  });

  it("uses the fixed model without tools or extensions", async () => {
    const agent = await chat.conversation.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toMatchObject({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash",
    });
    expect(agent.tools).toEqual([]);
  });

  it("shows SDK failure without exposing provider diagnostics", async () => {
    await app.request(input("fail"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]?.fail();
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const snapshot = await state();
    expect(snapshot.busy).toBe(false);
    expect(snapshot.failure).toContain("model_error");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
  });

  it("validates requests and denies foreign origins and DNS-rebinding hosts", async () => {
    expect((await app.request(input("   "))).status).toBe(400);
    expect(
      (
        await app.request("http://localhost:3000/api/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("http://localhost:3000/api/input", {
          method: "POST",
          body: "hello",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request("http://localhost:3000/api/input", {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect((await app.request("http://attacker.example:3000/api/events")).status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });
});
