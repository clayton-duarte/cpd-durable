import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { AccountingSchema } from "../src/shared/accounting.ts";
import { testModels } from "./models.ts";
import { usageTotals } from "../src/server/accounting.ts";

describe("SDK accounting and recovery projection", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-accounting-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 37,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1, total: 0.5 },
  };
  it("keeps tool spend separate and does not double-count reasoning or cached tokens", () => {
    const total = usageTotals({
      models: { model: { ...usage, reasoning: 7 } },
      tools: { bash: usage },
    });
    expect(total.cost).toBe(1);
    expect(total.totalTokens).toBe(74);
    expect(total.lines[0]?.reasoning).toBe(7);
    expect(total.lines[1]?.label).toBe("Tool: bash");
  });
  async function read(id: string) {
    const response = await createApp(chat).request(
      `http://localhost:3000/api/chats/${id}/accounting`,
    );
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    return AccountingSchema.parse(raw);
  }
  it("uses SDK whole-chat/session ledgers, includes failures, preserves unknown reasoning and restores totals", async () => {
    const rootId = String(chat.conversation.id);
    await chat.conversation.submit({ type: "input", content: "First" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect((await read(rootId)).activity.phase).toBe("generating");
    provider.calls[0]!.finish("Done", usage);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const second = await chat.chats.create(crypto.randomUUID());
    const scope = (await chat.chats.resolve(second.id))!;
    await scope.admit({ type: "input", content: "Second" });
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.fail(usage);
    await scope.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const own = await read(second.id);
    expect(own.activity).toMatchObject({ phase: "failed", failure: "model_error" });
    expect(own.conversation.cost).toBe(0.5);
    expect(own.conversation.totalTokens).toBe(37);
    expect(own.conversation.lines[0]).not.toHaveProperty("reasoning");
    expect(own.session.cost).toBe(1);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect((await read(rootId)).session).toEqual(own.session);
  });
  it("distinguishes stopped from failed without inventing an attempt or duration", async () => {
    const rootId = String(chat.conversation.id);
    const idle = await read(rootId);
    expect(idle.activity).toMatchObject({ phase: "idle", attempt: null, toolRounds: null });
    await chat.conversation.submit({ type: "input", content: "Stop" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await chat.conversation.abort(BACKGROUND_CONTEXT);
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect((await read(rootId)).activity).toMatchObject({ phase: "stopped", failure: "aborted" });
  });
});
