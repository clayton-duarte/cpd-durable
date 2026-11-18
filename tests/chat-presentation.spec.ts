import { test, expect, type Page, type Locator } from "@playwright/test";
import type { ChatState } from "../src/shared/chat.ts";

const empty = { messages: [], partial: "", busy: false, hasEarlier: false, failure: null };
const controls = { canContinue: false, resetPending: false, queue: [] };
async function connect(page: Page, state: ChatState = { ...empty, controls }) {
  await page.addInitScript((initial) => {
    class TestEventSource extends EventTarget {
      onerror: (() => void) | null = null;
      disconnect = () => this.onerror?.();
      update = (event: Event) => {
        if (event instanceof CustomEvent)
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super();
        window.addEventListener("synthetic-chat-state", this.update);
        window.addEventListener("synthetic-chat-disconnect", this.disconnect);
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("state", { data: initial })));
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

test.beforeEach(async ({ page }) => {
  // Never let synthetic tests reach the user's live conversation.
  await page.route("**/api/**", (route) => route.abort());
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
  await page.route("**/api/input", async (route) => {
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
  await page.route("**/api/input", async (route) => {
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
  await page.route("**/api/control", async (route) => {
    controlsSent.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { id: "keyboard-reset" } });
  });
  await page.route("**/api/input", (route) => {
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
  await page.route("**/api/input", async (route) => {
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
  await page.route("**/api/withdraw", (route) =>
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
  await page.route("**/api/control", async (route) => {
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

test("compact AlertDialog confirms reset, preserves drafts and retries the original payload", async ({
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
  await page.route("**/api/control", async (route) => {
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
  await page.route("**/api/control", async (route) => {
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
  await reasoning.getByRole("button", { name: "Reasoning", exact: true }).click();
  await expect(reasoning).toContainText("Actual provider reasoning");
  await expect(page.getByText("Final answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Legacy answer", { exact: true })).toBeVisible();
  await expect(page.getByText(/Reasoning content is not shown/)).toHaveCount(0);
  await expect(page.locator('[data-slot="agent-status"]')).toHaveCount(0);
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
  test.skip(!baseURL?.endsWith(":5173"), "Vite-only embedding fixture");
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
