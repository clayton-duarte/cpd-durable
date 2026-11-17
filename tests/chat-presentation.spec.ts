import { test, expect, type Page } from "@playwright/test";
import type { ChatState } from "../src/shared/chat.ts";

const empty = { messages: [], partial: "", busy: false, hasEarlier: false, failure: null };
const controls = { canContinue: false, resetPending: false, queue: [] };
async function connect(page: Page, state: ChatState = { ...empty, controls }) {
  await page.addInitScript((initial) => {
    class TestEventSource extends EventTarget {
      update = (event: Event) => {
        if (event instanceof CustomEvent)
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super();
        window.addEventListener("synthetic-chat-state", this.update);
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(initial) })),
        );
      }
      close() {
        window.removeEventListener("synthetic-chat-state", this.update);
      }
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  }, state);
}
async function update(page: Page, state: ChatState) {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("synthetic-chat-state", { detail })),
    state,
  );
}
async function actions(page: Page) {
  await page.getByRole("button", { name: /^Conversation actions/ }).click();
  return page.getByRole("dialog", { name: "Conversation actions", exact: true });
}

test.beforeEach(async ({ page }) => {
  // Never let synthetic tests reach the user's live conversation.
  await page.route("**/api/**", (route) => route.abort());
});

test("official Thread distinguishes history loading from its welcome", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/events", async (route) => {
    await gate;
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: state\ndata: ${JSON.stringify(empty)}\n\n`,
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
  await page.route("**/api/input", async (route) => {
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
  await page.route("**/api/input", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-retry" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Original submission");
  await draft.press("Enter");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await draft.fill("Newer unsent draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue("Newer unsent draft");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("official action palette queues a draft while busy without erasing newer edits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await connect(page, { ...empty, busy: true, controls });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  await page.route("**/api/input", async (route) => {
    requests.push(route.request().postDataJSON());
    await gate;
    await route.fulfill({ status: 202, json: { id: "test-queue" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Follow-up\n  with indentation");
  const palette = await actions(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await palette
    .getByRole("option", { name: "Queue current draft after this response", exact: true })
    .click();
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
  await expect(palette.getByRole("option", { name: /Steer current work/ })).toBeVisible();
  await update(page, { ...empty, controls });
  await expect(palette.getByRole("option", { name: /Steer current work/ })).toHaveCount(0);
  await expect(draft).toHaveValue("Change direction");
  await palette.getByRole("option", { name: "Close conversation actions", exact: true }).click();
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
  await page.route("**/api/withdraw", (route) =>
    route.fulfill({ json: { status: "already_placed" } }),
  );
  await page.goto("/");
  const palette = await actions(page);
  await expect(
    page.locator('[data-slot="aui_assistant-message-root"]', {
      hasText: "Queued synthetic direction",
    }),
  ).toHaveCount(0);
  await palette
    .getByRole("option", {
      name: "Withdraw steering request: Queued synthetic direction",
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
  await page.route("**/api/control", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-continue" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Unsent draft");
  await (await actions(page)).getByRole("option", { name: /Continue response without/ }).click();
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
  await page.route("**/api/stop", (route) => route.abort());
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

test("official ElicitationForm confirms reset, preserves drafts and retries the original payload", async ({
  page,
}) => {
  await connect(page);
  const requests: unknown[] = [];
  await page.route("**/api/control", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-reset" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep this draft");
  await (
    await actions(page)
  )
    .getByRole("option", { name: "Reset model context…", exact: true })
    .click();
  let form = page.getByRole("dialog", { name: "Reset model context", exact: true });
  await expect(form).toContainText("Stored history is retained.");
  await expect(form.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "Decline", exact: true }).click();
  expect(requests).toHaveLength(0);
  await (
    await actions(page)
  )
    .getByRole("option", { name: "Reset model context…", exact: true })
    .click();
  form = page.getByRole("dialog", { name: "Reset model context", exact: true });
  await form
    .getByRole("textbox", { name: "Handoff instructions (optional)", exact: true })
    .fill("Keep the approved direction");
  await form.getByRole("button", { name: "Reset model context", exact: true }).click();
  await form.getByRole("button", { name: "Send", exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("Context reset admitted.");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ type: "reset", handoff: "Keep the approved direction" });
  await expect(draft).toHaveValue("Keep this draft");
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
  await expect(page.getByRole("button", { name: "Add Attachment", exact: true })).toBeDisabled();
  await expect(footer.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
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

test("two official Threads keep their native drafts and action panels independent", async ({
  page,
  baseURL,
}) => {
  test.skip(!baseURL?.endsWith(":5173"), "Vite-only embedding fixture");
  await page.goto("/tests/fixtures/chat-reuse.html");
  const first = page.getByRole("region", { name: "First chat", exact: true });
  const second = page.getByRole("region", { name: "Second chat", exact: true });
  await first.getByRole("textbox", { name: "Message input", exact: true }).fill("First draft");
  await second
    .getByRole("textbox", { name: "Message input", exact: true })
    .fill("Independent second draft");
  await first.getByRole("button", { name: "Conversation actions", exact: true }).click();
  await expect(second.getByRole("dialog")).toHaveCount(0);
  await first.getByRole("option", { name: "Close conversation actions", exact: true }).click();
  await first.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(first.getByRole("textbox", { name: "Message input", exact: true })).toHaveValue("");
  await expect(second.getByRole("textbox", { name: "Message input", exact: true })).toHaveValue(
    "Independent second draft",
  );
});
