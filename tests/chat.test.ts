import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { present } from "../src/server/presentation.ts";
import {
  ChatStateSchema,
  SubmissionSchema,
  MODEL_ID,
  PROVIDER_ID,
  type SendMode,
} from "../src/shared/chat.ts";
import { testModels } from "./models.ts";
import { projectAssistantMessages } from "../src/client/assistant-messages.ts";

describe("single durable chat", () => {
  let dataDir: string;
  let provider: ReturnType<typeof testModels>;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cpd-chat-test-"));
    provider = testModels();
    chat = await openChat(dataDir, provider.models);
    app = createApp(chat);
  });
  afterEach(async () => {
    await chat.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const input = (text: string, requestId = crypto.randomUUID(), mode?: SendMode) =>
    new Request("http://localhost:3000/api/input", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ text, requestId, mode }),
    });

  async function state() {
    const watch = await chat.conversation.watch(BACKGROUND_CONTEXT);
    try {
      return ChatStateSchema.parse(present(watch.value));
    } finally {
      await watch.stop();
    }
  }

  const post = (path: string, body: unknown) =>
    app.request(`http://localhost:3000/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  async function observedState() {
    const response = await app.request("http://localhost:3000/api/events");
    const reader = response.body!.getReader();
    try {
      const text = new TextDecoder().decode((await reader.read()).value);
      const line = text.split("\n").find((part) => part.startsWith("data: "));
      if (!line) throw new Error("Missing initial state");
      return ChatStateSchema.parse(JSON.parse(line.slice(6)));
    } finally {
      await reader.cancel();
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
    const streaming = projectAssistantMessages(await state());
    expect(streaming.liveKey).not.toBeNull();
    expect((await app.request(input("another"))).status).toBe(409);
    const duplicate = SubmissionSchema.parse(await (await app.request(input("hello", id))).json());
    expect(duplicate).toEqual(admitted);
    call.finish("Hello there");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const committed = projectAssistantMessages(await state(), streaming);
    expect(committed.messages.at(-1)?.id).toBe(streaming.liveKey);
    expect(committed.messages.at(-1)?.metadata?.custom?.["durableId"]).toBe(
      (await state()).messages.at(-1)?.id,
    );
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

  it("supplies host-configured model identity in real provider contexts for existing and new chats", async () => {
    await app.request(input("Which model?"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    function modelSection(index: number) {
      const sections: Record<string, string | null> = {};
      for (const message of provider.calls[index]!.context.messages)
        if (message.role === "system") Object.assign(sections, message.sections);
      return sections["model"];
    }
    expect(modelSection(0)).toContain(`Host-configured provider: ${PROVIDER_ID}`);
    expect(modelSection(0)).toContain(`Host-configured model: ${MODEL_ID}`);
    provider.calls[0]!.finish("Done");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const created = await chat.chats.create(crypto.randomUUID());
    const scope = await chat.chats.resolve(created.id);
    await scope!.admit({ type: "input", content: "Which model?" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(modelSection(1)).toContain(`Host-configured model: ${MODEL_ID}`);
    provider.calls[1]!.finish("Done");
    await scope!.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("stops explicitly and retains partial output as interrupted", async () => {
    await app.request(input("long response"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]?.partial("Partial answer");
    await vi.waitFor(async () => expect((await state()).partial).toBe("Partial answer"));
    const streaming = projectAssistantMessages(await state());
    expect((await app.request("http://localhost:3000/api/stop", { method: "POST" })).status).toBe(
      204,
    );
    expect(await state()).toMatchObject({ busy: false, failure: "Response stopped." });
    expect((await state()).messages.at(-1)).toMatchObject({
      text: "Partial answer",
      interrupted: true,
      outcome: "interrupted",
    });
    expect(projectAssistantMessages(await state(), streaming).messages.at(-1)?.id).toBe(
      streaming.liveKey,
    );
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

  it("uses the fixed model with native host tools and a home-directory default", async () => {
    const agent = await chat.conversation.agent(BACKGROUND_CONTEXT);
    expect(agent.model).toMatchObject({
      provider: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    });
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "codemode",
      "grep",
      "find",
      "ls",
      "powershell",
      "load_skill",
      "ask_user",
      "create_tangent",
      "launch_worker",
      "stop_worker",
      "inspect_workers",
      "collect_worker",
      "delegate_handoff",
      "update_handoff",
      "escalate_handoff",
      "report_handoff",
      "deliver_handoff",
      "inspect_handoffs",
      "collect_handoff",
      "review_handoff",
    ]);
    expect(agent.cwd).toBe(homedir());
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

  it("queues follow-ups and steering honestly, withdraws a specific item, and rejects idle steering", async () => {
    expect((await app.request(input("too late", crypto.randomUUID(), "steer"))).status).toBe(409);
    const first = SubmissionSchema.parse(await (await app.request(input("first"))).json());
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(await (await post("withdraw", { id: first.id })).json()).toEqual({
      status: "already_placed",
    });
    const queuedRequest = crypto.randomUUID();
    const queued = SubmissionSchema.parse(
      await (await app.request(input("later", queuedRequest, "followUp"))).json(),
    );
    expect(
      SubmissionSchema.parse(
        await (await app.request(input("later", queuedRequest, "followUp"))).json(),
      ),
    ).toEqual(queued);
    await app.request(input("direction", crypto.randomUUID(), "steer"));
    const before = await state();
    expect(before.controls?.queue).toMatchObject([
      { id: queued.id, mode: "followUp", text: "later" },
      { mode: "steer", text: "direction" },
    ]);
    expect(before.messages.map((message) => message.text)).toEqual(["first"]);
    expect(provider.calls).toHaveLength(1);
    expect(await (await post("withdraw", { id: queued.id })).json()).toEqual({ status: "aborted" });
    expect((await state()).controls?.queue).toHaveLength(1);
    provider.calls[0]?.finish("first answer");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(provider.calls[1]?.context.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "direction" }),
    );
    provider.calls[1]?.finish("steered answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await state()).controls?.queue).toEqual([]);
    expect((await state()).messages.map((message) => message.text)).not.toContain("later");
    expect(await (await post("withdraw", { id: queued.id })).json()).toEqual({ status: "settled" });
    expect(await (await post("withdraw", { id: "999999999" })).json()).toEqual({
      status: "not_found",
    });
  });

  it("preserves queued follow-ups across reopen and runs them after the current answer", async () => {
    await app.request(input("active"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await app.request(input("next", crypto.randomUUID(), "followUp"));
    await chat.close();
    provider = testModels();
    chat = await openChat(dataDir, provider.models);
    app = createApp(chat);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await state()).controls?.queue).toMatchObject([{ text: "next", mode: "followUp" }]);
    provider.calls[0]?.finish("recovered answer");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]?.finish("follow-up answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await state()).messages.map((message) => message.text)).toEqual([
      "active",
      "recovered answer",
      "next",
      "follow-up answer",
    ]);
  });

  it("cannot withdraw a submission belonging to another conversation", async () => {
    await app.request(input("root input"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const entries = await chat.conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT);
    const at = entries.items.find((entry) => entry.kind === "pi.user")?.id;
    if (at === undefined) throw new Error("Missing fork point");
    const other = await chat.conversation.fork(
      at,
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await other.submit({ type: "input", content: "other active" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    const queued = await other.submit(
      { type: "input", content: "other queued", whenBusy: "followUp" },
      BACKGROUND_CONTEXT,
    );
    expect(await (await post("withdraw", { id: String(queued.id) })).json()).toEqual({
      status: "not_found",
    });
    expect((await queued.status(BACKGROUND_CONTEXT)).status).toBe("queued");
    await other.abort(BACKGROUND_CONTEXT);
    await chat.conversation.abort(BACKGROUND_CONTEXT);
  });

  it("offers Continue only for unresolved active context and deduplicates its admission", async () => {
    expect((await observedState()).controls?.canContinue).toBe(false);
    await app.request(input("unfinished"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await observedState()).controls?.canContinue).toBe(false);
    provider.calls[0]?.partial("Interrupted visible text");
    await vi.waitFor(async () => expect((await state()).partial).toBe("Interrupted visible text"));
    await app.request("http://localhost:3000/api/stop", { method: "POST" });
    expect((await observedState()).controls?.canContinue).toBe(true);
    const command = { type: "continue", requestId: crypto.randomUUID() };
    const admitted = SubmissionSchema.parse(await (await post("control", command)).json());
    expect(await (await post("control", command)).json()).toEqual(admitted);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]?.finish("continued");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await observedState()).controls?.canContinue).toBe(false);
    expect((await state()).messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("resets context with an optional handoff without deleting history or duplicating retries", async () => {
    await app.request(input("old context"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]?.finish("old answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const reset = {
      type: "reset",
      requestId: crypto.randomUUID(),
      handoff: "Carry only this forward",
    };
    const admitted = SubmissionSchema.parse(await (await post("control", reset)).json());
    expect(await (await post("control", reset)).json()).toEqual(admitted);
    expect(provider.calls).toHaveLength(1);
    expect((await state()).messages.map((message) => message.text)).toEqual([
      "old context",
      "old answer",
      "Carry only this forward",
    ]);
    const context = await chat.conversation.context(BACKGROUND_CONTEXT);
    expect(context.messages.filter((message) => message.role === "user")).toMatchObject([
      { content: "Carry only this forward" },
    ]);
    expect((await observedState()).controls?.canContinue).toBe(true);
    expect(
      (await post("control", { type: "reset", requestId: crypto.randomUUID(), handoff: "" }))
        .status,
    ).toBe(202);
    expect((await observedState()).controls?.canContinue).toBe(false);
    expect((await state()).messages).toHaveLength(3);
  });

  it("queues reset at a boundary and Stop withdraws inputs but not the reset", async () => {
    await app.request(input("active"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await app.request(input("withdraw with Stop", crypto.randomUUID(), "followUp"));
    const reset = { type: "reset", requestId: crypto.randomUUID(), handoff: "" };
    await post("control", reset);
    expect((await state()).controls).toMatchObject({
      resetPending: true,
      queue: [{ text: "withdraw with Stop" }],
    });
    await app.request("http://localhost:3000/api/stop", { method: "POST" });
    expect((await state()).controls?.queue).toEqual([]);
    expect((await observedState()).controls?.canContinue).toBe(false);
    // SDK queued writes survive abort; a later input places them in the new context.
    await app.request(input("after reset"));
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect((await state()).controls?.resetPending).toBe(false);
    const currentUsers = provider.calls[1]?.context.messages.filter(
      (message) => message.role === "user",
    );
    expect(currentUsers).toMatchObject([{ content: "after reset" }]);
    provider.calls[1]?.finish("new answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("validates all control boundaries and applies the same origin protections", async () => {
    expect(
      (
        await post("control", {
          type: "reset",
          requestId: crypto.randomUUID(),
          handoff: "x".repeat(32_001),
        })
      ).status,
    ).toBe(400);
    expect((await post("control", { type: "continue", requestId: "bad" })).status).toBe(400);
    expect((await post("withdraw", { id: "-1" })).status).toBe(400);
    expect((await post("withdraw", { id: "999999999999999999999999" })).status).toBe(400);
    expect(
      (await app.request(input("invalid mode", crypto.randomUUID(), "invalid" as SendMode))).status,
    ).toBe(400);
    for (const path of ["control", "withdraw"]) {
      expect(
        (
          await app.request(`http://localhost:3000/api/${path}`, {
            method: "POST",
            headers: { Origin: "https://attacker.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await app.request(`http://localhost:3000/api/${path}`, { method: "POST" })).status,
      ).toBe(415);
    }
    expect(provider.calls).toHaveLength(0);
  });
});
