import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { ContextSchema } from "../src/shared/context.ts";
import { testModels } from "./models.ts";
import { estimateCommittedContext, inspectContext } from "../src/server/context.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";

describe("SDK context and compaction", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-context-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function read() {
    const response = await createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/context`,
    );
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    return ContextSchema.parse(raw);
  }
  async function seed() {
    await chat.conversation.configure({ compaction: { keepRecentTokens: 1 } }, BACKGROUND_CONTEXT);
    for (let index = 0; index < 6; index++)
      await chat.conversation.submit(
        {
          type: "write",
          entry: {
            kind: "test.context",
            model: [
              { role: "user", content: `Saved history ${index} `.repeat(100), timestamp: index },
            ],
          },
        },
        BACKGROUND_CONTEXT,
      );
  }
  async function compact() {
    return createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/compact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: "Keep decisions" }),
      },
    );
  }
  it("inspects real committed entries and places idle summaries without erasing history", async () => {
    await seed();
    const before = await read();
    expect(before.entryCount).toBe(6);
    expect(before.headId).toBeNull();
    expect(before.measurements.committed.tokens).toBeGreaterThan(0);
    expect(before.measurements.contextWindow).toBe(
      provider.models.getModel(PROVIDER_ID, MODEL_ID)?.contextWindow,
    );
    expect(before.measurements.headroom.status).toBe("unknown");
    const response = await compact();
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await read()).compactions).toMatchObject([{ trigger: "manual", blocking: false }]);
    await expect(chat.chats.change(String(chat.conversation.id), "archive")).rejects.toThrow();
    expect((await read()).headId).toBeNull();
    provider.calls[0]!.finish("Durable summary");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect((await read()).headId).not.toBeNull());
    const after = await read();
    expect(after.entryCount).toBeLessThan(before.entryCount);
    expect(after.measurements.committed.tokens).toBeLessThan(before.measurements.committed.tokens!);
    const history = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(history.items.filter((entry) => entry.kind === "test.context")).toHaveLength(6);
    expect(after.compactions).toEqual([]);
  });
  it("keeps a request observation separate from changed context and in-flight work", async () => {
    await chat.conversation.submit(
      { type: "input", content: "first question" },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    let measurement = (await read()).measurements;
    expect(measurement.inFlight).toBe(true);
    expect(measurement.comparison.reasons).toContain("in-flight-work");
    provider.calls[0]!.finish("answer", {
      input: 17,
      output: 9,
      cacheRead: 11,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 4,
      totalTokens: 40,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    measurement = (await read()).measurements;
    expect(measurement.lastRequest?.usage).toMatchObject({
      input: 17,
      output: 9,
      cacheRead: 11,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 4,
    });
    expect(measurement.lastRequestScan).toBe("found");
    const saved = await chat.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const assistant = saved.items
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "assistant");
    expect(measurement.lastRequest?.messageTimestamp).toBe(assistant?.timestamp);
    expect(measurement.comparison.valid).toBe(false);
    expect(measurement.comparison.reasons).toContain("response-appended");
    expect(measurement.comparison.reasons).toContain("assembled-request-unavailable");
    await chat.conversation.submit(
      {
        type: "write",
        entry: { kind: "test.context", model: [{ role: "user", content: "next", timestamp: 2 }] },
      },
      BACKGROUND_CONTEXT,
    );
    expect((await read()).measurements.comparison.reasons).toContain("new-entries");
    await chat.conversation.configure(
      { model: { provider: "changed-provider", modelId: "changed-model" } },
      BACKGROUND_CONTEXT,
    );
    expect((await read()).measurements.comparison.reasons).toContain("model-changed");
    await chat.conversation.reset("handoff", BACKGROUND_CONTEXT);
    measurement = (await read()).measurements;
    expect(measurement.comparison.reasons).toContain("context-boundary-changed");
    expect(measurement.lastRequest?.usage?.input).toBe(17);
    expect(measurement.occupancy).toEqual({ status: "unknown", tokens: null });
  });
  async function writeDisplayEntries(count: number) {
    for (let index = 0; index < count; index++)
      await chat.conversation.submit(
        { type: "write", entry: { kind: "test.display", data: { index } } },
        BACKGROUND_CONTEXT,
      );
  }
  it("reports a capped scan rather than claiming no observation in long assistant-free history", async () => {
    expect((await read()).measurements.lastRequestScan).toBe("exhausted");
    await writeDisplayEntries(201);
    const measurement = (await read()).measurements;
    expect(measurement.lastRequest).toBeNull();
    expect(measurement.lastRequestScan).toBe("capped");
    expect(measurement.comparison.reasons).toContain("request-observation-scan-capped");
    expect(measurement.comparison.reasons).not.toContain("no-request-observation");
  });
  it("does not claim an older assistant observation was absent when beyond the scan cap", async () => {
    await chat.conversation.submit({ type: "input", content: "question" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("answer");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read()).measurements.lastRequestScan).toBe("found");
    await writeDisplayEntries(201);
    const measurement = (await read()).measurements;
    expect(measurement.lastRequest).toBeNull();
    expect(measurement.lastRequestScan).toBe("capped");
    expect(measurement.comparison.reasons).toContain("request-observation-scan-capped");
  });
  it("admits while busy but does not claim the summary has been placed", async () => {
    await seed();
    await chat.conversation.submit({ type: "input", content: "Work" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.finish("Queued summary");
    await vi.waitFor(async () => expect((await read()).compactions).toEqual([]));
    expect((await read()).headId).toBeNull();
    provider.calls[0]!.finish("Finished");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read()).headId).not.toBeNull();
  });
  it("sanitizes summary failure and rejects archived, deleted and malformed requests", async () => {
    await seed();
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.fail();
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () => expect((await read()).failure?.trigger).toBe("manual"));
    const id = String(chat.conversation.id);
    await chat.chats.change(id, "archive");
    expect((await compact()).status).toBe(409);
    await chat.chats.change(id, "delete");
    expect((await compact()).status).toBe(404);
  });
  it("aborts summarization without losing committed context and safely no-ops empty context", async () => {
    const malformed = await createApp(chat).request(
      `http://localhost:3000/api/chats/${chat.conversation.id}/compact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: 4 }),
      },
    );
    expect(malformed.status).toBe(400);
    expect((await compact()).status).toBe(202);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(provider.calls).toHaveLength(0);
    await seed();
    expect((await compact()).status).toBe(202);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await chat.conversation.abort(BACKGROUND_CONTEXT);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read()).entryCount).toBe(6);
    expect((await read()).headId).toBeNull();
    expect((await read()).compactions).toEqual([]);
  });
});

it("does not assign a zero cost to unsupported images or opaque reasoning", () => {
  expect(
    estimateCommittedContext([
      {
        role: "user",
        content: [{ type: "image", data: "secret", mimeType: "image/png" }],
        timestamp: 1,
      },
    ]),
  ).toMatchObject({ status: "unknown", tokens: null, unsupported: ["image"] });
  expect(
    estimateCommittedContext([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", redacted: true }],
        api: "openai-completions",
        provider: "test",
        model: "test",
        timestamp: 1,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]),
  ).toMatchObject({ status: "unknown", tokens: null, unsupported: ["opaque-thinking"] });
});

it("projects the selected model's catalog window from a real SDK harness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-context-catalog-"));
  const models = testModels().models;
  const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    await conversation.configure(
      { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      BACKGROUND_CONTEXT,
    );
    const result = await inspectContext(harness, conversation, models);
    expect(result.measurements.contextWindow).toBe(
      models.getModel(PROVIDER_ID, MODEL_ID)?.contextWindow,
    );
    expect(result.measurements.contextWindow).toBeGreaterThan(0);
    expect(result.measurements.contextWindowSource).toBe("model-catalog");
    expect(result.measurements.lastRequest).toBeNull();
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
