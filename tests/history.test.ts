import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry, ConversationTranscript } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { createHistory } from "../src/server/history.ts";
import { ChatStateSchema, type ChatState } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

describe("SDK-owned paged history", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let history: ReturnType<typeof createHistory>;
  const detach: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-history-test-"));
    chat = await openChat(directory, testModels().models, directory);
    history = createHistory(chat.conversation);
  });
  afterEach(async () => {
    await Promise.all(detach.splice(0).map((close) => close()));
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function seed(count: number, start = 0) {
    await chat.conversation.commit(async (tx) => {
      for (let index = start; index < start + count; index++)
        await tx.appendEntry(UserEntry, chat.conversation.id, {
          model: [{ role: "user", content: `Turn ${index}`, timestamp: index }],
        });
    }, BACKGROUND_CONTEXT);
  }
  async function observe(id = crypto.randomUUID(), oldest?: number) {
    let latest: ChatState | undefined;
    const subscription = await history.subscribe(
      id,
      async (state) => {
        latest = ChatStateSchema.parse(state);
      },
      oldest,
    );
    detach.push(subscription.unsubscribe);
    return { id, close: subscription.unsubscribe, state: () => latest! };
  }

  it("loads bounded earlier pages, coalesces duplicate reads and keeps browser views independent", async () => {
    await seed(130);
    const first = await observe();
    const second = await observe();
    expect(first.state().messages).toHaveLength(50);
    expect(first.state().hasEarlier).toBe(true);
    const spy = vi.spyOn(chat.conversation, "entries");
    await Promise.all([history.load(first.id), history.load(first.id)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.state().messages).toHaveLength(100);
    expect(second.state().messages).toHaveLength(50);
    await history.load(first.id);
    expect(first.state().messages.map((message) => message.text)).toEqual(
      Array.from({ length: 130 }, (_, index) => `Turn ${index}`),
    );
    expect(first.state().hasEarlier).toBe(false);
    await history.load(first.id);
    expect(first.state().messages).toHaveLength(130);
  });

  it("pages a large synthetic transcript without treating sparse record IDs as counts", async () => {
    await seed(1200);
    const observer = await observe();
    let requests = 0;
    while (observer.state().hasEarlier && requests < 30) {
      const before = observer.state().messages.length;
      await history.load(observer.id);
      expect(observer.state().messages.length - before).toBeLessThanOrEqual(50);
      requests++;
    }
    expect(observer.state().hasEarlier).toBe(false);
    expect(observer.state().messages).toHaveLength(1200);
    expect(observer.state().messages[0]?.text).toBe("Turn 0");
    expect(observer.state().messages.at(-1)?.text).toBe("Turn 1199");
  });

  it("handles an empty terminal page without dropping the retained window", async () => {
    await seed(130);
    const observer = await observe();
    const before = observer.state().messages;
    vi.spyOn(chat.conversation, "entries").mockResolvedValueOnce({ items: [] });
    await history.load(observer.id);
    expect(observer.state().messages).toEqual(before);
    expect(observer.state().hasEarlier).toBe(false);
  });

  it("retains loaded rows, detects a reconnect gap and fills it without duplicate or missing entries", async () => {
    await seed(130);
    const first = await observe();
    await history.load(first.id);
    const oldest = first.state().messages[0]!.id;
    await first.close();
    await seed(180, 130);
    const resumed = await observe(first.id);
    expect(resumed.state().messages[0]!.id).toBe(oldest);
    expect(resumed.state().history?.gaps).toHaveLength(1);
    for (let page = 0; resumed.state().history!.gaps.length > 0 && page < 10; page++)
      await history.load(first.id, resumed.state().history!.gaps[0]);
    expect(resumed.state().history?.gaps).toHaveLength(0);
    await history.load(first.id);
    const messages = resumed.state().messages;
    expect(messages.map((message) => message.text)).toEqual(
      Array.from({ length: 310 }, (_, index) => `Turn ${index}`),
    );
    expect(new Set(messages.map((message) => message.id)).size).toBe(310);
    expect(resumed.state().hasEarlier).toBe(false);
  });

  it("reconstructs bounded oldest/latest ranges after a lost view and marks the remaining gap", async () => {
    await seed(310);
    const first = await observe();
    while (first.state().hasEarlier) await history.load(first.id);
    const oldest = first.state().history!.oldest!;
    await first.close();
    history = createHistory(chat.conversation);
    const restored = await observe(first.id, oldest);
    expect(restored.state().history!.epoch).not.toBe(first.state().history!.epoch);
    expect(restored.state().messages).toHaveLength(100);
    expect(restored.state().history?.gaps).toHaveLength(1);
    expect(restored.state().messages[0]?.text).toBe("Turn 0");
    expect(restored.state().messages.at(-1)?.text).toBe("Turn 309");
  });

  it("merges live appends during a page load without rolling state back", async () => {
    await seed(130);
    const observer = await observe();
    const entries = chat.conversation.entries.bind(chat.conversation);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(chat.conversation, "entries").mockImplementationOnce(async (...args) => {
      const page = await entries(...args);
      await pending;
      return page;
    });
    const loading = history.load(observer.id);
    await seed(1, 130);
    await vi.waitFor(() => expect(observer.state().messages.at(-1)?.text).toBe("Turn 130"));
    release();
    await loading;
    expect(observer.state().messages.at(-1)?.text).toBe("Turn 130");
    expect(observer.state().messages).toHaveLength(101);
  });

  it("does not publish a loader's stale return value after the watch has advanced", async () => {
    await seed(130);
    const observer = await observe();
    const original = Object.getOwnPropertyDescriptor(
      ConversationTranscript.prototype,
      "loadEarlier",
    )!.value as ConversationTranscript["loadEarlier"];
    const spy = vi
      .spyOn(ConversationTranscript.prototype, "loadEarlier")
      .mockImplementationOnce(async function (this: ConversationTranscript, context) {
        const stale = await original.call(this, context);
        await seed(1, 130);
        await vi.waitFor(() => expect(observer.state().messages.at(-1)?.text).toBe("Turn 130"));
        return stale;
      });
    try {
      await history.load(observer.id);
      expect(observer.state().messages.at(-1)?.text).toBe("Turn 130");
      expect(observer.state().messages).toHaveLength(101);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves state on read failure and retries the same SDK page", async () => {
    await seed(130);
    const observer = await observe();
    const before = observer.state().messages;
    vi.spyOn(chat.conversation, "entries").mockRejectedValueOnce(
      new Error("PRIVATE_STORAGE_DETAIL"),
    );
    await expect(history.load(observer.id)).rejects.toThrow("PRIVATE_STORAGE_DETAIL");
    expect(observer.state().messages).toEqual(before);
    await history.load(observer.id);
    expect(observer.state().messages).toHaveLength(100);
  });

  it("validates history requests and sanitizes HTTP read failures", async () => {
    await seed(130);
    const app = createApp(chat);
    const view = crypto.randomUUID();
    const response = await app.request(`http://localhost:3000/api/events?view=${view}`);
    const reader = response.body!.getReader();
    const post = (body: unknown) =>
      app.request("http://localhost:3000/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain(view);
      expect((await post({ view: "bad" })).status).toBe(400);
      expect((await post({ view, gap: { after: 100, upTo: 20 } })).status).toBe(400);
      expect((await post({ view: crypto.randomUUID() })).status).toBe(410);
      vi.spyOn(chat.conversation, "entries").mockRejectedValueOnce(
        new Error("PRIVATE_STORAGE_DETAIL"),
      );
      const failed = await post({ view });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("PRIVATE_STORAGE_DETAIL");
      const loaded = await post({ view });
      expect(ChatStateSchema.parse(await loaded.json()).messages).toHaveLength(100);
    } finally {
      await reader.cancel();
    }
  });
});
