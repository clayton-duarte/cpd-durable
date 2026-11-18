import { test, expect, type Page, type Locator } from "@playwright/test";
import { HistoryLoadSchema, type ChatState, type HistoryGap } from "../src/shared/chat.ts";
import { ConfigurationChangeSchema } from "../src/shared/configuration.ts";
import type { ContextMeasurements } from "../src/shared/context.ts";

const empty = { messages: [], partial: "", busy: false, hasEarlier: false, failure: null };
const controls = { canContinue: false, resetPending: false, queue: [] };
const measurements: ContextMeasurements = {
  observedAt: 1000,
  model: { provider: "test", modelId: "one" },
  contextWindow: 32000,
  contextWindowSource: "model-catalog",
  committed: {
    status: "approximate",
    tokens: 123,
    method: "committed-content-utf8-bytes-divided-by-4-v1",
    scope: "committed-context-only",
    exclusions: ["system-prompt-and-extension-resource-assembly"],
    unsupported: [],
  },
  lastRequest: {
    source: "durable-assistant-message",
    scope: "conversation-generation",
    entryId: "2",
    model: { provider: "test", modelId: "previous" },
    messageTimestamp: 500,
    stopReason: "stop",
    usageStatus: "reported",
    usage: {
      input: 17,
      output: 9,
      cacheRead: 11,
      cacheWrite: 3,
      cacheWrite1h: 1,
      reasoning: 4,
      totalTokens: 40,
    },
  },
  lastRequestScan: "found",
  comparison: { valid: false, reasons: ["assembled-request-unavailable", "model-changed"] },
  occupancy: { status: "unknown", tokens: null },
  headroom: { status: "unknown", tokens: null, reason: "assembled-request-unavailable" },
  inFlight: false,
  queued: false,
};
function textLive(
  taskId: number,
  afterEntryId: number,
  text: string,
): NonNullable<ChatState["live"]> {
  const id = `generation:1:${taskId}:1`;
  return { id, taskId, afterEntryId, text, parts: [{ id: `${id}:0`, type: "text", text }] };
}
async function connect(page: Page, state: ChatState = { ...empty, controls }) {
  await page.addInitScript((initial) => {
    class TestEventSource extends EventTarget {
      view: string;
      frame = (raw: string) => {
        const state = JSON.parse(raw) as { history?: { view: string }; conversationId?: number };
        state.conversationId ??= 1;
        if (state.history) state.history.view = this.view;
        return JSON.stringify(state);
      };
      onerror: (() => void) | null = null;
      disconnect = () => this.onerror?.();
      update = (event: Event) => {
        if (event instanceof CustomEvent)
          this.dispatchEvent(
            new MessageEvent("state", { data: this.frame(JSON.stringify(event.detail)) }),
          );
      };
      constructor(url: string) {
        super();
        this.view = new URL(url, location.href).searchParams.get("view")!;
        window.addEventListener("synthetic-chat-state", this.update);
        window.addEventListener("synthetic-chat-disconnect", this.disconnect);
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("state", { data: this.frame(initial) })),
        );
      }
      close() {
        window.removeEventListener("synthetic-chat-state", this.update);
        window.removeEventListener("synthetic-chat-disconnect", this.disconnect);
      }
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  }, JSON.stringify(state));
}
async function update(page: Page, state: ChatState) {
  await page.evaluate(
    (detail) =>
      window.dispatchEvent(
        new CustomEvent("synthetic-chat-state", { detail: JSON.parse(detail) as unknown }),
      ),
    JSON.stringify(state),
  );
}
async function actions(page: Page, scope?: Locator) {
  const root = scope ?? page;
  const draft = root.getByRole("textbox", { name: "Message input", exact: true });
  const text = await draft.inputValue();
  // Invoke the real slash picker before an existing draft; selecting strips only
  // the command and separator, leaving the draft unchanged.
  await draft.fill(`/ ${text}`);
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft.press("ArrowLeft");
  await draft.press("ArrowRight");
  return root.locator('[data-slot="composer-trigger-popover"]');
}

function historyState(
  first: number,
  last: number,
  revision: number,
  hasEarlier = true,
  gaps: HistoryGap[] = [],
): ChatState {
  const messages: ChatState["messages"] = Array.from({ length: last - first + 1 }, (_, index) => {
    const id = first + index;
    return {
      id: `${id}:0`,
      role: id % 2 ? "user" : "assistant",
      text: `Turn ${id}\nHistory content for turn ${id}.`,
      interrupted: false,
      source: { entryId: id },
    };
  });
  return {
    ...empty,
    controls,
    messages,
    live: null,
    conversationId: 1,
    hasEarlier,
    window: { entryIds: messages.slice(-30).map((message) => message.source!.entryId) },
    history: {
      view: "22222222-2222-4222-8222-222222222222",
      epoch: "11111111-1111-4111-8111-111111111111",
      revision,
      oldest: first,
      gaps,
    },
  };
}

test.beforeEach(async ({ page }) => {
  // Never let synthetic tests reach the user's live conversation.
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
});

test("native earlier loading prepends history while preserving draft, row identity and scroll anchor", async ({
  page,
}) => {
  await connect(page, historyState(61, 90, 1));
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    requests.push(request);
    const next = historyState(31, 90, 2);
    next.history!.view = request.view;
    await route.fulfill({ status: 200, json: next });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep this unsent draft");
  const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await load.scrollIntoViewIfNeeded();
  const row = page.locator('[data-durable-id="61:0"]');
  await row.evaluate((element) => element.setAttribute("data-history-probe", "original"));
  const before = (await row.boundingBox())!.y;
  await load.click();
  await expect(page.locator("[data-durable-id]")).toHaveCount(60);
  await expect(row).toHaveAttribute("data-history-probe", "original");
  await expect(draft).toHaveValue("Keep this unsent draft");
  await expect.poll(async () => Math.abs((await row.boundingBox())!.y - before)).toBeLessThan(6);
  expect(requests).toHaveLength(1);
});

test("loaded-history search steps and wraps real text hits without searching hidden reasoning", async ({
  page,
}) => {
  const initial = historyState(1, 40, 1);
  initial.messages[0]!.text = "Needle first and needle again";
  initial.messages[1]!.text = "Needle second";
  initial.messages[3]!.parts = [{ id: "4:0:0", type: "reasoning", text: "private needle" }];
  initial.messages[3]!.text = "";
  await connect(page, initial);
  await page.goto("/");
  await page.getByRole("button", { name: "Find in loaded history" }).click();
  const search = page.locator('[data-slot="conversation-search"]');
  await search.getByRole("textbox", { name: "Find in conversation" }).fill("needle");
  await expect(search).toContainText("1/3");
  await search.getByRole("button", { name: "Next match" }).click();
  await expect(search).toContainText("2/3");
  await search.getByRole("textbox").press("Enter");
  await expect(search).toContainText("3/3");
  await search.getByRole("textbox").press("Enter");
  await expect(search).toContainText("1/3");
  await search.getByRole("textbox").press("Shift+Enter");
  await expect(search).toContainText("3/3");
  await search.getByRole("textbox").fill("not loaded");
  await search.getByRole("button", { name: "Next match" }).click();
  await expect(search).toContainText("0");
  await expect(search).toHaveAttribute("aria-label", /unloaded messages are not searched/);
});

test("conversation map selects actual loaded turns and preserves the native draft", async ({
  page,
}) => {
  await connect(page, historyState(1, 50, 1));
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep navigation draft");
  const map = page.getByRole("navigation", { name: "Conversation map" });
  await expect(map.getByRole("button")).toHaveCount(25);
  await map.getByRole("button", { name: "Turn 1", exact: true }).click();
  const row = page.locator('[data-durable-id="1:0"]');
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const viewport = element.closest('[data-slot="aui_thread-viewport"]')!;
        return Math.abs(element.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
      }),
    )
    .toBeLessThan(5);
  await expect(draft).toHaveValue("Keep navigation draft");
});

test("details use chat/session SDK scopes and read retries never resend the draft", async ({
  page,
}) => {
  await connect(page);
  let reads = 0;
  await page.route("**/api/chats/1/configuration", (route) =>
    route.fulfill({
      json: {
        conversationId: "1",
        selection: { provider: "test", modelId: "one", thinkingLevel: "off" },
        choices: [],
      },
    }),
  );
  await page.route("**/api/chats/1/context", (route) =>
    route.fulfill({
      json: {
        conversationId: "1",
        observedAt: 1000,
        measurements,
        headId: null,
        entryCount: 0,
        messageCount: 0,
        roles: [],
        entries: [],
        truncated: false,
        compactions: [],
        failure: null,
      },
    }),
  );
  await page.route("**/api/chats/1/accounting", async (route) => {
    if (++reads === 1) return route.abort();
    return route.fulfill({
      json: {
        conversationId: "1",
        observedAt: 1000,
        conversation: {
          cost: 0.5,
          totalTokens: 37,
          lines: [
            {
              label: "test/model",
              input: 10,
              output: 20,
              cacheRead: 3,
              cacheWrite: 4,
              totalTokens: 37,
              cost: 0.5,
              billed: false,
            },
          ],
        },
        session: { cost: 1, totalTokens: 74, lines: [] },
        activity: {
          phase: "retrying",
          attempt: 2,
          retryAt: 2000,
          pollAt: null,
          toolRounds: 1,
          failure: null,
        },
      },
    });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Unsent accounting draft");
  await page.getByRole("button", { name: "Chat details", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Details unavailable");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator('[data-slot="cost-meter"]')).toContainText("this chat");
  await expect(dialog).toContainText("$1.00 session");
  await expect(dialog).toContainText("SDK phase: retrying");
  await expect(dialog).not.toContainText("this run");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft).toHaveValue("Unsent accounting draft");
});

test("context compaction reports admission rather than placement and never retries uncertain writes", async ({
  page,
}) => {
  await connect(page);
  const posts: unknown[] = [];
  await page.route("**/api/chats/1/context", (route) =>
    route.fulfill({
      json: {
        conversationId: "1",
        observedAt: 1000,
        headId: "3",
        measurements,
        entryCount: 2,
        messageCount: 2,
        roles: [
          { role: "user", count: 1 },
          { role: "assistant", count: 1 },
        ],
        entries: [{ id: "3", kind: "pi.compaction", messages: 1 }],
        truncated: false,
        compactions: [
          { taskId: "5", trigger: "threshold", blocking: false, attempt: 1, retryAt: null },
        ],
        failure: null,
      },
    }),
  );
  await page.route("**/api/chats/1/compact", (route) => {
    posts.push(route.request().postDataJSON());
    return route.abort();
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Preserve compact draft");
  await page.getByRole("button", { name: "Chat details", exact: true }).click();
  const context = page.getByRole("region", { name: "Active context" });
  await expect(context).toContainText("Token occupancy and headroom are unknown");
  await expect(context).toContainText("threshold compaction 5");
  await expect(context).toContainText("Committed context heuristic: approximately 123 tokens");
  await expect(context).toContainText("UTF-8 content bytes ÷ 4");
  await expect(context).toContainText("test/one");
  await expect(context).toContainText("32,000 tokens");
  await expect(context).toContainText("future resources");
  await expect(context).toContainText("tool schemas");
  await expect(context).toContainText("does not guarantee the next request fits");
  await expect(context).toContainText("Previous assistant request: test/previous");
  await expect(context).toContainText("message timestamp");
  await expect(context).toContainText("cache read 11");
  await expect(context).toContainText("1h subset 1");
  await expect(context).toContainText("reasoning 4 (subset of output)");
  await expect(context).toContainText("not current occupancy or directly comparable");
  await context
    .getByRole("textbox", { name: "Optional summary instructions" })
    .fill("Keep decisions");
  await context.getByRole("button", { name: "Compact context", exact: true }).click();
  await expect(context).toContainText("Admission unconfirmed");
  await expect(
    context.getByRole("button", { name: "Compact context", exact: true }),
  ).toBeDisabled();
  expect(posts).toEqual([{ instructions: "Keep decisions" }]);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft).toHaveValue("Preserve compact draft");
});

test("context inspector reports unsupported estimates and missing counters as unknown", async ({
  page,
}) => {
  await connect(page);
  await page.route("**/api/chats/1/context", (route) =>
    route.fulfill({
      json: {
        conversationId: "1",
        observedAt: 1000,
        measurements: {
          ...measurements,
          model: null,
          contextWindow: null,
          committed: {
            ...measurements.committed,
            status: "unknown",
            tokens: null,
            unsupported: ["image", "opaque-thinking"],
          },
          lastRequest: { ...measurements.lastRequest!, usageStatus: "unknown", usage: null },
        },
        headId: null,
        entryCount: 0,
        messageCount: 0,
        roles: [],
        entries: [],
        truncated: false,
        compactions: [],
        failure: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Chat details", exact: true }).click();
  const context = page.getByRole("region", { name: "Active context" });
  await expect(context).toContainText("Unknown (images or opaque reasoning/signatures");
  await expect(context).toContainText("Selected model: unknown");
  await expect(context).toContainText("Catalog context window: unknown");
  await expect(context).toContainText("Request usage unknown");
  await expect(context).not.toContainText("approximately 0 tokens");
});

test("context inspector distinguishes a capped request scan from an absent observation", async ({
  page,
}) => {
  await connect(page);
  await page.route("**/api/chats/1/context", (route) =>
    route.fulfill({
      json: {
        conversationId: "1",
        observedAt: 1000,
        measurements: {
          ...measurements,
          lastRequest: null,
          lastRequestScan: "capped",
          comparison: {
            valid: false,
            reasons: ["assembled-request-unavailable", "request-observation-scan-capped"],
          },
        },
        headId: null,
        entryCount: 0,
        messageCount: 0,
        roles: [],
        entries: [],
        truncated: false,
        compactions: [],
        failure: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Chat details", exact: true }).click();
  const context = page.getByRole("region", { name: "Active context" });
  await expect(context).toContainText("Observation unknown: the scan stopped after 200 entries.");
  await expect(context).not.toContainText("No durable request observation found");
});

test("supplied model picker saves scoped choices and supported thinking without submitting the draft", async ({
  page,
}) => {
  await connect(page);
  let selection = { provider: "test", modelId: "one", thinkingLevel: "off" };
  const posts: unknown[] = [];
  const choices = [
    { provider: "test", modelId: "one", name: "First model", thinkingLevels: ["off", "low"] },
    { provider: "test", modelId: "two", name: "Second model", thinkingLevels: ["off", "high"] },
  ];
  await page.route("**/api/chats/1/configuration", async (route) => {
    if (route.request().method() === "POST") {
      const body = ConfigurationChangeSchema.parse(route.request().postDataJSON());
      posts.push(body);
      selection = body.selection;
    }
    return route.fulfill({ json: { conversationId: "1", selection, choices } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep model draft");
  await page.getByRole("button", { name: "Chat details", exact: true }).click();
  const config = page.getByRole("region", { name: "Model configuration" });
  await config.getByRole("combobox").click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await config.getByRole("combobox").click();
  await page.getByRole("radio", { name: "high", exact: true }).click();
  await page.keyboard.press("Escape");
  await config.getByRole("button", { name: "Save model settings" }).click();
  await expect(config).toContainText("Saved: test/two · thinking high");
  expect(posts).toEqual([
    {
      expected: { provider: "test", modelId: "one", thinkingLevel: "off" },
      selection: { provider: "test", modelId: "two", thinkingLevel: "high" },
    },
  ]);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft).toHaveValue("Keep model draft");
});

test("a stale history response cannot roll back a newer loaded/live snapshot", async ({ page }) => {
  await connect(page, historyState(61, 90, 1));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    started = true;
    await blocked;
    const stale = historyState(31, 90, 2);
    stale.history!.view = request.view;
    await route.fulfill({ status: 200, json: stale });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await update(page, historyState(31, 91, 3));
  release();
  await expect(page.locator("[data-durable-id]")).toHaveCount(61);
  await expect(page.getByText("Turn 91", { exact: false }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Loading earlier messages", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-durable-id="91:0"]')).toHaveCount(1);
});

test("mobile keyboard loading reaches the first page without losing focus or the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await connect(page, historyState(61, 90, 1));
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    const next = historyState(1, 90, 2, false);
    next.history!.view = request.view;
    await route.fulfill({ status: 200, json: next });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Mobile draft");
  const load = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await load.focus();
  await load.press("Enter");
  await expect(load).toHaveCount(0);
  await expect(page.locator("[data-durable-id]")).toHaveCount(90);
  await expect(draft).toHaveValue("Mobile draft");
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("history errors retry independently of uncertain message delivery", async ({ page }) => {
  await connect(page, historyState(61, 90, 1));
  let inputRequests = 0;
  let historyRequests = 0;
  await page.route("**/api/chats/1/input", async (route) => {
    inputRequests++;
    await route.abort();
  });
  await page.route("**/api/chats/1/history", async (route) => {
    historyRequests++;
    if (historyRequests === 1) {
      await route.abort();
      return;
    }
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    const next = historyState(1, 90, 2, false);
    next.history!.view = request.view;
    await route.fulfill({ status: 200, json: next });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Uncertain input");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Delivery");
  await draft.fill("Newer draft");
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  const error = page
    .locator('[data-slot="error-state"]')
    .filter({ hasText: "History unavailable" });
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("[data-durable-id]")).toHaveCount(90);
  await expect(error).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load earlier messages", exact: true }),
  ).toHaveCount(0);
  await expect(draft).toHaveValue("Newer draft");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
  expect(inputRequests).toBe(1);
  expect(historyRequests).toBe(2);
});

test("explicit gap recovery is ordered and never exposes message actions for a gap", async ({
  page,
}) => {
  const initial = historyState(1, 10, 1, false, [{ after: 10, upTo: 100 }]);
  initial.messages.push(...historyState(100, 110, 1).messages);
  await connect(page, initial);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    requests.push(request);
    const next = historyState(1, 110, 2, false);
    next.history!.view = request.view;
    await route.fulfill({ status: 200, json: next });
  });
  await page.goto("/");
  const marker = page.locator('[data-message-id="history-gap:10:100"]');
  await expect(marker).toHaveCount(1);
  await expect(marker.locator('[data-slot="aui_assistant-message-footer"]')).toHaveCount(0);
  await marker.getByRole("button", { name: "Load missing messages", exact: true }).click();
  await expect(marker).toHaveCount(0);
  await expect(page.locator("[data-durable-id]")).toHaveCount(110);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ gap: { after: 10, upTo: 100 } });
});

test("a delayed response from a retired history epoch cannot replace the restarted view", async ({
  page,
}) => {
  await connect(page, historyState(61, 90, 1));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    started = true;
    await blocked;
    const stale = historyState(1, 90, 100, false);
    stale.history!.view = request.view;
    await route.fulfill({ status: 200, json: stale });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  const restarted = historyState(31, 91, 1);
  restarted.history!.epoch = "33333333-3333-4333-8333-333333333333";
  await update(page, restarted);
  release();
  await expect(
    page.getByRole("button", { name: "Loading earlier messages", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[data-durable-id]")).toHaveCount(61);
  await expect(page.locator('[data-durable-id="91:0"]')).toHaveCount(1);
  await expect(page.locator('[data-durable-id="1:0"]')).toHaveCount(0);
});

test("failed gap reads retry their original bounds without adding a second recovery banner", async ({
  page,
}) => {
  const initial = historyState(1, 10, 1, false, [{ after: 10, upTo: 100 }]);
  initial.messages.push(...historyState(100, 110, 1).messages);
  await connect(page, initial);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/history", async (route) => {
    const request = HistoryLoadSchema.parse(route.request().postDataJSON());
    requests.push(request);
    if (requests.length === 1) {
      await route.abort();
      return;
    }
    const next = historyState(1, 110, 2, false);
    next.history!.view = request.view;
    await route.fulfill({ status: 200, json: next });
  });
  await page.goto("/");
  const marker = page.locator('[data-message-id="history-gap:10:100"]');
  await marker.getByRole("button", { name: "Load missing messages", exact: true }).click();
  await expect(marker).toContainText("History could not be loaded");
  await expect(page.locator('[data-slot="error-state"]')).toHaveCount(1);
  await marker.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(marker).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("idle composer is one surface with discoverable commands and no inert controls", async ({
  page,
}) => {
  await connect(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveAttribute(
    "placeholder",
    /Type \/ for commands/,
  );
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Conversation actions|Add Attachment|Refresh/ }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-slot="command-palette"], [data-slot="composer-menu"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-slot="aui_composer-shell"]')).toHaveCount(1);
  const picker = await actions(page);
  await expect(picker.getByRole("option", { name: /\/reset/ })).toBeVisible();
  await expect(
    picker.getByRole("option", { name: /\/queue|\/steer|\/continue|Close/ }),
  ).toHaveCount(0);
});

test("keyboard slash selection strips command text and steers only the actual draft", async ({
  page,
}) => {
  await connect(page, { ...empty, busy: true, controls });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "keyboard-steer" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Change direction\n  preserve indentation");
  await actions(page);
  await draft.pressSequentially("steer");
  await expect(page.getByRole("option", { name: /\/steer/ })).toBeVisible();
  await draft.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    mode: "steer",
    text: "Change direction\n  preserve indentation",
  });
  await expect(draft).toHaveValue("");
});

test("stale or escaped reserved commands never become ordinary user messages", async ({ page }) => {
  await connect(page, { ...empty, busy: true, controls });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "must-not-send" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("/steer");
  await expect(page.getByRole("option", { name: /\/steer/ })).toBeVisible();
  await update(page, { ...empty, controls });
  await draft.press("Escape");
  await draft.press("Enter");
  await expect(page.getByRole("alert")).toContainText("command text was not sent");
  await expect(draft).toHaveValue("/steer");
  expect(requests).toEqual([]);
  await draft.fill("/cont");
  await draft.press("Escape");
  await draft.press("Enter");
  await expect(draft).toHaveValue("/cont");
  expect(requests).toEqual([]);
});

test("reset keyboard focus, Escape and field Enter preserve the unsent draft", async ({ page }) => {
  await connect(page);
  const requests: string[] = [];
  const controlsSent: unknown[] = [];
  await page.route("**/api/chats/1/control", async (route) => {
    controlsSent.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "keyboard-reset" } });
  });
  await page.route("**/api/chats/1/input", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/");
  // The modal correctly removes the background composer from the accessibility tree.
  const draft = page.locator('textarea[aria-label="Message input"]');
  await draft.fill("Keep this draft");
  await actions(page);
  await draft.pressSequentially("reset");
  await draft.press("Enter");
  const form = page.getByRole("alertdialog", { name: "Reset model context?", exact: true });
  const handoff = form.getByRole("textbox", { name: "Handoff instructions (optional)" });
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await handoff.fill("Keep this handoff");
  await handoff.press("Enter");
  await expect(form).toBeVisible();
  await expect(draft).toHaveValue("Keep this draft");
  expect(requests).toEqual([]);
  await handoff.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Keep this draft");
  await (await actions(page)).getByRole("option", { name: /\/reset/ }).click();
  await expect(handoff).toHaveValue("Keep this handoff\n");
  await handoff.focus();
  await handoff.press("Tab");
  await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button", { name: "Reset context", exact: true })).toBeFocused();
  await form.getByRole("button", { name: "Reset context", exact: true }).press("Enter");
  await expect(form).toHaveCount(0);
  expect(controlsSent).toHaveLength(1);
  expect(controlsSent[0]).toMatchObject({ type: "reset", handoff: "Keep this handoff" });
  expect(requests).toEqual([]);
  await expect(draft).toHaveValue("Keep this draft");
});

test("IME Enter does not submit and Shift Enter preserves multiline input", async ({ page }) => {
  await connect(page);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "ime-input" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("入力中");
  await draft.dispatchEvent("compositionstart");
  await draft.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(requests).toEqual([]);
  await draft.dispatchEvent("compositionend", { data: "入力中" });
  await draft.press("Shift+Enter");
  await draft.pressSequentially("Second line");
  await expect(draft).toHaveValue("入力中\nSecond line");
  await draft.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ text: "入力中\nSecond line", mode: "reject" });
});

test("mobile durable queue is visible, honest after failure, and bounded to the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page, {
    ...empty,
    controls: {
      ...controls,
      queue: [
        { id: "steering", mode: "steer", text: "A long pending direction ".repeat(8) },
        { id: "follow-up", mode: "followUp", text: "Next response" },
      ],
    },
  });
  await page.goto("/");
  const queue = page.locator('[data-slot="message-queue"]');
  await expect(queue).toContainText("2 queued");
  await expect(queue).toContainText("Pending placement; not yet delivered");
  await expect(queue).not.toContainText("sends when this finishes");
  await expect(queue.getByRole("button", { name: /Remove/ })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await actions(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("official Thread distinguishes history loading from its welcome", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/chats\/1\/events(?:\?.*)?$/, async (route) => {
    await gate;
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: state\ndata: ${JSON.stringify({ ...empty, conversationId: 1 })}\n\n`,
    });
  });
  await page.goto("/");
  await expect(page.locator('[data-slot="aui_thread-history-skeleton"]')).toBeVisible();
  await expect(page.getByText("How can I help you today?")).toHaveCount(0);
  release();
  await expect(page.getByText("How can I help you today?")).toBeVisible();
  await expect(page.locator('[data-slot="aui_thread-history-skeleton"]')).toHaveCount(0);
});

test("native Send retains the submitted draft until acknowledgement and preserves later edits", async ({
  page,
}) => {
  await connect(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await gate;
    await route.fulfill({ status: 202, json: { id: "test-admission" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Original draft");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(draft).toHaveValue("Original draft");
  await draft.fill("Newer unsent draft");
  release();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(draft).toHaveValue("Newer unsent draft");
});

test("official ErrorState retries the original identity without consuming a newer draft", async ({
  page,
}) => {
  await connect(page);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-retry" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Original submission");
  await draft.press("Enter");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await update(page, { ...empty, controls });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await draft.fill("Newer unsent draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue("Newer unsent draft");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("slash command queues a draft while busy without erasing newer edits", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page, { ...empty, busy: true, controls });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await gate;
    await route.fulfill({ status: 202, json: { id: "test-queue" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Follow-up\n  with indentation");
  const palette = await actions(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await palette.getByRole("option", { name: /\/queue/ }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(draft).toHaveValue("Follow-up\n  with indentation");
  await draft.fill("Another draft");
  release();
  await expect(page.getByRole("note")).toContainText("Follow-up input admitted.");
  await expect(draft).toHaveValue("Another draft");
  expect(requests[0]).toMatchObject({ mode: "followUp", text: "Follow-up\n  with indentation" });
});

test("steering disappears rather than silently becoming ordinary input after a run ends", async ({
  page,
}) => {
  await connect(page, { ...empty, busy: true, controls });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Change direction");
  const palette = await actions(page);
  await expect(palette.getByRole("option", { name: /\/steer/ })).toBeVisible();
  await update(page, { ...empty, controls });
  await expect(palette.getByRole("option", { name: /\/steer/ })).toHaveCount(0);
  await expect(draft).toHaveValue("/ Change direction");
  await draft.press("Escape");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("queued input stays separate from messages and withdrawal reports a placement race", async ({
  page,
}) => {
  await connect(page, {
    ...empty,
    busy: true,
    controls: {
      ...controls,
      queue: [{ id: "123", mode: "steer", text: "Queued synthetic direction" }],
    },
  });
  await page.route("**/api/chats/1/withdraw", (route) =>
    route.fulfill({ json: { status: "already_placed" } }),
  );
  await page.goto("/");
  await expect(
    page.locator('[data-slot="aui_assistant-message-root"]', {
      hasText: "Queued synthetic direction",
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: 'Remove "Steer at boundary: Queued synthetic direction" from the queue',
      exact: true,
    })
    .click();
  await expect(page.getByRole("note")).toContainText(
    "Input was already placed; it was not withdrawn.",
  );
});

test("Continue retries the same control without consuming the composer draft", async ({ page }) => {
  await connect(page, { ...empty, controls: { ...controls, canContinue: true } });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/control", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-continue" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Unsent draft");
  await (await actions(page)).getByRole("option", { name: /\/continue/ }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("Continue admitted;");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(draft).toHaveValue("Unsent draft");
});

test("native Stop retains the draft and does not advertise an unsafe request-ID retry", async ({
  page,
}) => {
  await connect(page, { ...empty, busy: true, controls });
  await page.route("**/api/chats/1/stop", (route) => route.abort());
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep this draft");
  await page.getByRole("button", { name: "Stop generating", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Check current state before using Stop again.",
  );
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this draft");
});

test("compact AlertDialog confirms reset, preserves drafts and retries the original payload", async ({
  page,
}) => {
  await connect(page);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/control", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-reset" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep this draft");
  await (await actions(page)).getByRole("option", { name: /\/reset/ }).click();
  let form = page.getByRole("alertdialog", { name: "Reset model context?", exact: true });
  await expect(form).toContainText("Stored history is retained.");
  await expect(form.getByRole("button", { name: "Reset context", exact: true })).toBeEnabled();
  await expect(form.getByRole("button")).toHaveCount(2);
  await expect(form).not.toContainText("needs input");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(requests).toHaveLength(0);
  await (await actions(page)).getByRole("option", { name: /\/reset/ }).click();
  form = page.getByRole("alertdialog", { name: "Reset model context?", exact: true });
  await form
    .getByRole("textbox", { name: "Handoff instructions (optional)", exact: true })
    .fill("Keep the approved direction");
  await form.getByRole("button", { name: "Reset context", exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("Context reset admitted.");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ type: "reset", handoff: "Keep the approved direction" });
  await expect(draft).toHaveValue("Keep this draft");
});

test("reset dialog stays compact on mobile, traps focus and accepts an empty handoff", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await connect(page, { ...empty, busy: true, controls });
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/control", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "empty-handoff-reset" } });
  });
  await page.goto("/");
  await (await actions(page)).getByRole("option", { name: /\/reset/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Reset model context?", exact: true });
  const handoff = dialog.getByRole("textbox", { name: "Handoff instructions (optional)" });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", { name: "Reset context", exact: true });
  await expect(dialog).toContainText(
    "While busy, reset waits for a boundary; Stop does not cancel it.",
  );
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(handoff).toBeFocused();
  await handoff.fill("A long optional handoff.\n".repeat(100));
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(667);
  await handoff.fill("");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ type: "reset", handoff: "" });
});

test("reset confirmation rechecks pending state before admitting an action", async ({ page }) => {
  await connect(page);
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/control", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "must-not-reset" } });
  });
  await page.goto("/");
  await (await actions(page)).getByRole("option", { name: /\/reset/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Reset model context?", exact: true });
  await update(page, { ...empty, controls: { ...controls, resetPending: true } });
  await expect(dialog.getByRole("button", { name: "Reset context", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("official messages render safe Markdown, code copy and native export", async ({ page }) => {
  const markdown =
    "## Summary\n\n**Formatted reply**\n\n| Name | Value |\n| --- | --- |\n| Test | 1 |\n\n```ts\n    const value = 1;\n```\n\n<script>window.PWNED=true</script>\n\n[Unsafe](javascript:alert(1))\n\n![tracking](https://example.invalid/tracker.png)";
  await connect(page, {
    ...empty,
    controls,
    messages: [
      { id: "1:0", role: "user", text: "**Literal text**\n    indentation", interrupted: false },
      { id: "2:0", role: "assistant", text: markdown, interrupted: false },
    ],
  });
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("http") && new URL(request.url()).hostname !== "127.0.0.1")
      external.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
  const user = page.locator(".aui-user-message-content");
  await expect(user).toHaveText("**Literal text**\n    indentation", { useInnerText: true });
  await expect(user.locator("strong")).toHaveCount(0);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator("pre code")).toHaveText("    const value = 1;\n");
  await expect(page.locator('img[src*="tracker"], a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, "PWNED"))).toBe(false);
  expect(external).toEqual([]);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          document.body.dataset["copied"] = text;
        },
      },
    }),
  );
  await page
    .locator(".aui-code-header-root")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  expect(await page.locator("body").getAttribute("data-copied")).toBe("    const value = 1;\n");
  const footer = page.locator('[data-slot="aui_assistant-message-footer"]');
  await footer.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.locator("body").getAttribute("data-copied")).toBe(markdown);
  await footer.getByRole("button", { name: "More", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  await expect(page.getByRole("button", { name: "Add Attachment", exact: true })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Voice|Helpful/ })).toHaveCount(0);
});

test("official runtime keeps separate messages and interrupted receipts through streaming", async ({
  page,
}) => {
  const committed = [
    { id: "1:0", role: "assistant" as const, text: "First assistant entry", interrupted: true },
    { id: "2:0", role: "assistant" as const, text: "Second assistant entry", interrupted: false },
  ];
  await connect(page, { ...empty, controls, messages: committed, busy: true, partial: "Incoming" });
  await page.goto("/");
  const messages = page.locator('[data-slot="aui_assistant-message-root"]');
  await expect(messages).toHaveCount(3);
  await update(page, {
    ...empty,
    controls,
    messages: committed,
    busy: true,
    partial: "Incoming more",
  });
  await expect(page.getByText("Incoming more", { exact: true })).toBeVisible();
  await expect(messages).toHaveCount(3);
  await update(page, {
    ...empty,
    controls,
    messages: [
      ...committed,
      { id: "3:0", role: "assistant", text: "Incoming more", interrupted: false },
    ],
  });
  await expect(messages).toHaveCount(3);
  await expect(page.getByText("Incoming more", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Response interrupted.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Assistant is working", { exact: true })).toHaveCount(0);
});

function sourcedStream(): ChatState {
  return {
    ...empty,
    controls,
    conversationId: 1,
    busy: true,
    window: { entryIds: [1] },
    messages: [
      { id: "1:0", role: "user", text: "Request", interrupted: false, source: { entryId: 1 } },
    ],
    partial: "First chunk",
    live: {
      id: "generation:1:9:1",
      taskId: 9,
      afterEntryId: 1,
      text: "First chunk",
      parts: [{ id: "generation:1:9:1:0", type: "text", text: "First chunk" }],
    },
  };
}

for (const outcome of ["complete", "interrupted", "error"] as const) {
  test(`source-backed ${outcome} keeps the same DOM row and part through reconnect`, async ({
    page,
  }) => {
    const initial = sourcedStream();
    await connect(page, initial);
    await page.goto("/");
    const row = page.locator('[data-slot="aui_assistant-message-root"]');
    await expect(row).toHaveText("First chunk");
    const key = await row.getAttribute("data-message-id");
    await row.evaluate((element) => element.setAttribute("data-identity-probe", "original"));
    await row
      .locator(".aui-md")
      .evaluate((element) => element.setAttribute("data-part-probe", "original"));
    await update(page, {
      ...initial,
      partial: "Growing response",
      live: {
        ...initial.live!,
        text: "Growing response",
        parts: [{ id: "generation:1:9:1:0", type: "text", text: "Growing response" }],
      },
    });
    await expect(row).toContainText("Growing response");
    await expect(row).toHaveAttribute("data-message-id", key!);
    await expect(row).toHaveAttribute("data-identity-probe", "original");
    await page.evaluate(() => window.dispatchEvent(new Event("synthetic-chat-disconnect")));
    await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
    const done: ChatState = {
      ...initial,
      busy: false,
      partial: "",
      live: null,
      window: { entryIds: [1, 2] },
      messages: [
        ...initial.messages,
        {
          id: "2:0",
          role: "assistant",
          text: "Corrected final answer",
          interrupted: outcome === "interrupted",
          outcome,
          source: { entryId: 2, taskId: 9 },
          parts: [{ id: "2:0:0", type: "text", text: "Corrected final answer" }],
        },
      ],
    };
    await update(page, done);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Corrected final answer");
    await expect(row).toHaveAttribute("data-message-id", key!);
    await expect(row).toHaveAttribute("data-durable-id", "2:0");
    await expect(row).toHaveAttribute(
      "data-message-status",
      outcome === "complete" ? "complete" : "incomplete",
    );
    await expect(row).toHaveAttribute("data-identity-probe", "original");
    await expect(row.locator(".aui-md")).toHaveAttribute("data-part-probe", "original");
    await update(page, { ...done });
    await expect(row).toHaveAttribute("data-identity-probe", "original");
    await expect(page.getByLabel("Assistant is working", { exact: true })).toHaveCount(0);
  });
}

test("ordered omission receipts preserve text boundaries and truthful failure outcomes", async ({
  page,
}) => {
  await connect(page, {
    ...empty,
    controls,
    conversationId: 1,
    live: null,
    window: { entryIds: [1, 2, 3] },
    messages: [
      {
        id: "1:0",
        role: "assistant",
        text: "PRIVATE_UNUSED_FALLBACK",
        interrupted: false,
        outcome: "error",
        parts: [
          { id: "1:0:0", type: "text", text: "Before" },
          { id: "1:0:1", type: "omitted", kind: "other" },
          { id: "1:0:2", type: "text", text: "After" },
        ],
      },
      {
        id: "2:0",
        role: "assistant",
        text: "Stopped output",
        interrupted: true,
        outcome: "interrupted",
      },
      {
        id: "3:0",
        role: "assistant",
        text: "Limited output",
        interrupted: false,
        outcome: "length",
      },
    ],
  });
  await page.goto("/");
  const rows = page.locator('[data-slot="aui_assistant-message-root"]');
  await expect(rows).toHaveCount(3);
  const first = rows.first();
  await expect(
    first.getByText("Unsupported content is not shown in this text-only chat.", { exact: true }),
  ).toBeVisible();
  await expect(first).toContainText("Response failed.");
  const text = await first.innerText();
  expect(text.indexOf("Before")).toBeLessThan(text.indexOf("Unsupported content"));
  expect(text.indexOf("Unsupported content")).toBeLessThan(text.indexOf("After"));
  await expect(page.getByText("Response interrupted.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("PRIVATE_UNUSED_FALLBACK", { exact: true })).toHaveCount(0);
  await expect(rows.nth(1)).toHaveAttribute("data-message-status", "incomplete");
  await expect(rows.nth(2)).toHaveAttribute("data-message-status", "incomplete");
  await expect(page.getByLabel("Assistant is working", { exact: true })).toHaveCount(0);
});

test("a busy run without a live message does not mark a settled answer as streaming", async ({
  page,
}) => {
  await connect(page, {
    ...empty,
    controls,
    busy: true,
    partial: "Stale legacy partial",
    live: null,
    messages: [
      {
        id: "1:0",
        role: "assistant",
        text: "Settled answer",
        interrupted: false,
        outcome: "complete",
      },
    ],
  });
  await page.goto("/");
  const row = page.locator('[data-slot="aui_assistant-message-root"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Settled answer");
  await expect(row).toHaveAttribute("data-message-status", "complete");
  await expect(page.getByText("Stale legacy partial", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Assistant is working", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
});

test("invalid identity frames preserve history and draft, then recover without sending", async ({
  page,
}) => {
  const initial: ChatState = {
    ...empty,
    controls,
    messages: [{ id: "1:0", role: "assistant", text: "Retained history", interrupted: false }],
  };
  await connect(page, initial);
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Retained draft");
  await update(page, { ...initial, messages: [initial.messages[0]!, initial.messages[0]!] });
  await expect(page.getByRole("alert")).toContainText("Received an invalid conversation update.");
  await expect(page.getByText("Retained history", { exact: true })).toHaveCount(1);
  await expect(draft).toHaveValue("Retained draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await update(page, { ...initial });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(draft).toHaveValue("Retained draft");
});

test("native Reasoning follows live streaming and collapses when reasoning completes", async ({
  page,
}) => {
  const streaming: ChatState = {
    ...empty,
    controls,
    conversationId: 1,
    window: { entryIds: [] },
    busy: true,
    live: {
      id: "generation:1:9:1",
      taskId: 9,
      afterEntryId: null,
      text: "",
      parts: [{ id: "generation:1:9:1:0", type: "reasoning", text: "Provider reasoning stream" }],
    },
  };
  await connect(page, streaming);
  await page.goto("/");
  const root = page.locator('[data-slot="reasoning-root"]');
  await expect(root).toHaveAttribute("data-variant", "ghost");
  await expect(root).toHaveCSS("border-top-width", "0px");
  const trigger = root.getByRole("button", { name: "Reasoning", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(root).toContainText("Provider reasoning stream");
  await expect(root.locator('[data-slot="reasoning-content"]')).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await update(page, {
    ...empty,
    controls,
    conversationId: 1,
    window: { entryIds: [1] },
    live: null,
    messages: [
      {
        id: "1:0",
        role: "assistant",
        text: "Answer",
        interrupted: false,
        outcome: "complete",
        source: { entryId: 1, taskId: 9 },
        parts: [
          { id: "1:0:0", type: "reasoning", text: "Provider reasoning stream" },
          { id: "1:0:1", type: "text", text: "Answer" },
        ],
      },
    ],
  });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Answer", { exact: true })).toBeVisible();
  await trigger.click();
  await expect(root.getByText("Provider reasoning stream", { exact: true })).toBeVisible();
});

test("provider reasoning uses the supplied Reasoning disclosure, not a paused status notice", async ({
  page,
}) => {
  await connect(page, {
    ...empty,
    controls,
    live: null,
    messages: [
      {
        id: "1:0",
        role: "assistant",
        text: "Final answer",
        interrupted: false,
        outcome: "complete",
        parts: [
          { id: "1:0:0", type: "reasoning", text: "Actual provider reasoning" },
          { id: "1:0:1", type: "text", text: "Final answer" },
        ],
      },
      {
        id: "2:0",
        role: "assistant",
        text: "Legacy answer",
        interrupted: false,
        parts: [
          { id: "2:0:0", type: "omitted", kind: "reasoning" },
          { id: "2:0:1", type: "text", text: "Legacy answer" },
        ],
      },
    ],
  });
  await page.goto("/");
  const reasoning = page.locator('[data-slot="reasoning-root"]');
  await expect(reasoning).toHaveCount(1);
  await expect(reasoning).toHaveAttribute("data-variant", "ghost");
  await expect(reasoning).toHaveCSS("border-top-width", "0px");
  await reasoning.getByRole("button", { name: "Reasoning", exact: true }).click();
  await expect(reasoning).toContainText("Actual provider reasoning");
  await expect(page.getByText("Final answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Legacy answer", { exact: true })).toBeVisible();
  await expect(page.getByText(/Reasoning content is not shown/)).toHaveCount(0);
  await expect(page.locator('[data-slot="agent-status"]')).toHaveCount(0);
});

for (const width of [1100, 375]) {
  test(`short streaming turns reserve no blank page and the composer stays fixed on completion (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state: ChatState = {
      ...empty,
      controls,
      conversationId: 1,
      window: { entryIds: [1] },
      busy: true,
      messages: [
        { id: "1:0", role: "user", text: "Prompt", interrupted: false, source: { entryId: 1 } },
      ],
      live: textLive(9, 1, "Short partial"),
    };
    await connect(page, state);
    await page.goto("/");
    await expect(page.getByText("Short partial", { exact: true })).toBeVisible();
    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeLessThan(3);
    await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
    const composer = page.locator('[data-slot="aui_composer-shell"]');
    const before = await composer.boundingBox();
    await update(page, {
      ...state,
      busy: false,
      live: null,
      window: { entryIds: [1, 2] },
      messages: [
        ...state.messages,
        {
          id: "2:0",
          role: "assistant",
          text: "Short answer",
          interrupted: false,
          outcome: "complete",
          source: { entryId: 2, taskId: 9 },
        },
      ],
    });
    await expect(page.getByText("Short answer", { exact: true })).toBeVisible();
    await expect
      .poll(async () => Math.abs((await composer.boundingBox())!.y - before!.y))
      .toBeLessThan(2);
    await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeHidden();
  });
}

test("untouched streams follow the bottom through growth and handover, but respect reading older text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const state: ChatState = {
    ...empty,
    controls,
    conversationId: 1,
    window: { entryIds: [1] },
    busy: true,
    messages: [
      { id: "1:0", role: "user", text: "Prompt", interrupted: false, source: { entryId: 1 } },
    ],
    live: textLive(9, 1, "Initial partial"),
  };
  await connect(page, state);
  await page.goto("/");
  await expect(page.getByText("Initial partial", { exact: true })).toBeVisible();
  const viewport = page.locator('[data-slot="aui_thread-viewport"]');
  const distance = () =>
    viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  const composer = page.locator('[data-slot="aui_composer-shell"]');
  const composerTop = (await composer.boundingBox())!.y;
  let text = "";
  for (const count of [25, 45, 65]) {
    text = Array.from({ length: count }, (_, index) => `Streaming paragraph ${index}.`).join(
      "\n\n",
    );
    await update(page, { ...state, live: textLive(9, 1, text) });
    await expect.poll(distance).toBeLessThan(3);
    await expect
      .poll(async () => Math.abs((await composer.boundingBox())!.y - composerTop))
      .toBeLessThan(2);
  }
  const settled: ChatState = {
    ...state,
    busy: false,
    live: null,
    window: { entryIds: [1, 2] },
    messages: [
      ...state.messages,
      {
        id: "2:0",
        role: "assistant",
        text,
        interrupted: false,
        outcome: "complete",
        source: { entryId: 2, taskId: 9 },
      },
    ],
  };
  await update(page, settled);
  await expect.poll(distance).toBeLessThan(3);
  await expect
    .poll(async () => Math.abs((await composer.boundingBox())!.y - composerTop))
    .toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeHidden();
  await viewport.hover({ position: { x: 100, y: 100 } });
  expect(
    await viewport.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(300);
  await page.mouse.wheel(0, -450);
  await expect.poll(distance).toBeGreaterThan(200);
  const top = await viewport.evaluate((element) => element.scrollTop);
  await update(page, {
    ...settled,
    busy: true,
    live: textLive(10, 2, "Another partial"),
  });
  // A new run intentionally scrolls to latest. User scrolling during that run
  // must still suspend following subsequent token updates.
  await expect.poll(distance).toBeLessThan(3);
  await page.mouse.wheel(0, -450);
  await expect.poll(distance).toBeGreaterThan(200);
  const reading = await viewport.evaluate((element) => element.scrollTop);
  await update(page, {
    ...settled,
    busy: true,
    live: textLive(10, 2, "Another partial\n\nMore text"),
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(reading);
  expect(top).toBeGreaterThan(0);
});

test("collapsed reasoning/tool rows use their actual compact height, including offscreen history", async ({
  page,
}) => {
  await connect(page, {
    ...empty,
    controls,
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `${index + 1}:0`,
      role: "assistant" as const,
      text: "",
      interrupted: false,
      outcome: "complete" as const,
      parts: [
        { id: `${index + 1}:0:0`, type: "reasoning" as const, text: "Hidden reasoning" },
        {
          id: `${index + 1}:0:1`,
          type: "tool-call" as const,
          callId: `call-${index}`,
          name: "bash",
          arguments: { command: "pwd" },
          state: "complete" as const,
          output: "Done",
        },
      ],
    })),
  });
  await page.goto("/");
  await expect(page.locator('[data-slot="aui_assistant-message-root"]')).toHaveCount(20);
  await expect
    .poll(() =>
      page
        .locator('[data-slot="aui_assistant-message-root"]')
        .evaluateAll((rows) => Math.max(...rows.map((row) => row.getBoundingClientRect().height))),
    )
    .toBeLessThan(140);
});

for (const finalState of ["complete", "error", "cancelled"] as const) {
  test(`native tool output stays disclosed through ${finalState} without approval or retry actions`, async ({
    page,
  }) => {
    const state: ChatState = {
      ...empty,
      controls,
      conversationId: 1,
      busy: true,
      live: null,
      window: { entryIds: [1] },
      messages: [
        {
          id: "1:0",
          role: "assistant",
          text: "",
          interrupted: false,
          outcome: "complete",
          source: { entryId: 1, taskId: 9 },
          parts: [
            {
              id: "1:0:0",
              type: "tool-call",
              callId: "shell",
              name: "bash",
              arguments: { command: "printf '<script>literal output</script>'" },
              state: "running",
              output: "first chunk",
            },
          ],
        },
      ],
    };
    await connect(page, state);
    await page.goto("/");
    await page.getByRole("button", { name: "1 tool call", exact: true }).click();
    const tool = page.locator('[data-slot="tool-fallback-root"]');
    await expect(tool).toHaveCount(1);
    await tool.getByRole("button", { name: /Running tool: bash/ }).click();
    await expect(tool).toContainText("first chunk");
    await expect(tool).toContainText("printf '<script>literal output</script>'");
    await update(page, {
      ...state,
      busy: false,
      messages: [
        {
          ...state.messages[0]!,
          parts: [
            {
              id: "1:0:0",
              type: "tool-call",
              callId: "shell",
              name: "bash",
              arguments: { command: "printf '<script>literal output</script>'" },
              state: finalState,
              output: "<script>literal output</script>",
              resultEntryId: 2,
            },
          ],
        },
      ],
    });
    await expect(tool).toContainText(
      finalState === "complete"
        ? "Used tool"
        : finalState === "cancelled"
          ? "Cancelled tool"
          : "Failed tool",
    );
    await expect(tool.getByText("<script>literal output</script>", { exact: true })).toBeVisible();
    await expect(tool.locator("script")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Allow|Deny|Retry|Run now)$/ })).toHaveCount(0);
    await expect(tool.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });
}

test("two official Threads keep their native drafts and action panels independent", async ({
  page,
  baseURL,
}) => {
  test.skip(
    new URL(baseURL ?? "http://127.0.0.1:3000").port === "3000",
    "Vite-only embedding fixture",
  );
  await page.goto("/tests/fixtures/chat-reuse.html");
  const first = page.getByRole("region", { name: "First chat", exact: true });
  const second = page.getByRole("region", { name: "Second chat", exact: true });
  await first.getByRole("textbox", { name: "Message input", exact: true }).fill("First draft");
  await second
    .getByRole("textbox", { name: "Message input", exact: true })
    .fill("Independent second draft");
  await (await actions(page, first)).getByRole("option", { name: /\/reset/ }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(1);
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first.getByRole("textbox", { name: "Message input", exact: true })).toBeFocused();
  await first.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(first.getByRole("textbox", { name: "Message input", exact: true })).toHaveValue("");
  await expect(second.getByRole("textbox", { name: "Message input", exact: true })).toHaveValue(
    "Independent second draft",
  );
});
