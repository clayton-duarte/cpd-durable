import { test, expect } from "@playwright/test";
import type { ChatState } from "../src/shared/chat.ts";

const empty = { messages: [], partial: "", busy: false, hasEarlier: false, failure: null };
const controls = { canContinue: false, resetPending: false, queue: [] };

async function connect(
  page: import("@playwright/test").Page,
  state: ChatState = { ...empty, controls },
) {
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

test.beforeEach(async ({ page }) => {
  // No request in this suite may reach the user's live conversation.
  await page.route("**/api/**", (route) => route.abort());
});

test("loads history before showing empty state", async ({ page }) => {
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
  await expect(page.getByLabel("Loading conversation")).toBeVisible();
  await expect(page.getByText("No messages yet")).toHaveCount(0);
  release();
  await expect(page.getByText("No messages yet")).toBeVisible();
  await expect(page.getByLabel("Loading conversation")).toHaveCount(0);
});

test("retries the original identity without erasing a newer draft", async ({ page }) => {
  // Keep observation connected; a fulfilled SSE route immediately closes its stream.
  await page.addInitScript((state) => {
    class TestEventSource extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(state) })),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  }, empty);
  const requests: unknown[] = [];
  await page.route("**/api/input", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "synthetic-submission" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Original submission");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry submission" })).toBeVisible();
  await draft.fill("Newer unsent draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry submission" }).click();
  await expect(page.getByRole("button", { name: "Retry submission" })).toHaveCount(0);
  await expect(draft).toHaveValue("Newer unsent draft");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("queues a follow-up while busy and preserves a newer draft during admission", async ({
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
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Follow-up\n  with indentation");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Send mode" }).click();
  await page.getByRole("menuitem", { name: "Send after current response", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await draft.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  await draft.fill("Another draft");
  release();
  await expect(page.getByText("Follow-up input admitted.", { exact: false })).toBeVisible();
  await expect(draft).toHaveValue("Another draft");
  expect(requests[0]).toMatchObject({ mode: "followUp", text: "Follow-up\n  with indentation" });
  await expect(
    page.getByText("Stop ends current foreground work and withdraws queued inputs."),
  ).toBeVisible();
});

test("does not silently send steering as ordinary input when the run ends", async ({ page }) => {
  await connect(page, { ...empty, busy: true, controls });
  await page.goto("/");
  await page.getByRole("button", { name: "Send mode" }).click();
  await page.getByRole("menuitem", { name: "Steer current work", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Change direction");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.evaluate(
    (state) => window.dispatchEvent(new CustomEvent("synthetic-chat-state", { detail: state })),
    { ...empty, controls },
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(draft).toHaveValue("Change direction");
  await expect(
    page.getByText("Requested steering is applied at an eligible run boundary, not immediately."),
  ).toBeVisible();
});

test("shows queued input separately and reports the withdraw placement race", async ({ page }) => {
  const queueState = {
    ...empty,
    busy: true,
    controls: {
      ...controls,
      queue: [{ id: "123", mode: "steer", text: "Queued synthetic direction" }],
    },
  };
  await connect(page, { ...empty, busy: true, controls });
  await page.route("**/api/withdraw", (route) =>
    route.fulfill({ json: { status: "already_placed" } }),
  );
  await page.goto("/");
  await page.evaluate(
    (state) => window.dispatchEvent(new CustomEvent("synthetic-chat-state", { detail: state })),
    queueState,
  );
  await page.getByRole("button", { name: "Queued inputs" }).click();
  await expect(page.getByText("Steer requested")).toBeVisible();
  await expect(page.getByText("Queued synthetic direction")).toBeVisible();
  await expect(
    page.locator('[data-slot="message"]', { hasText: "Queued synthetic direction" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Withdraw queued input 123" }).click();
  await expect(page.getByText("Input was already placed; it was not withdrawn.")).toBeVisible();
});

test("Continue retries the same command without consuming the draft", async ({ page }) => {
  await connect(page, { ...empty, controls: { ...controls, canContinue: true } });
  const requests: unknown[] = [];
  await page.route("**/api/control", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await route.abort();
    else await route.fulfill({ status: 202, json: { id: "test-continue" } });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Unsent draft");
  await page.getByRole("button", { name: "Continue response" }).click();
  await page.getByRole("button", { name: "Retry action" }).click();
  await expect(page.getByText("Continue admitted;", { exact: false })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ type: "continue" });
  await expect(draft).toHaveValue("Unsent draft");
});

test("does not offer an unsafe original-action retry for an uncertain Stop", async ({ page }) => {
  await connect(page, { ...empty, busy: true, controls });
  await page.route("**/api/stop", (route) => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Check current state before using Stop again.",
  );
  await expect(page.getByRole("button", { name: "Retry action" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop response" })).toBeEnabled();
});

test("requires reset confirmation, preserves drafts and retries an uncertain reset identity", async ({
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
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft");
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Reset model context…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Stored conversation history is retained.",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Reset model context…" }).click();
  await page
    .getByRole("textbox", { name: "Handoff instructions (optional)", exact: true })
    .fill("Keep only the approved direction");
  await page.getByRole("button", { name: "Reset context", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry action" }).click();
  await expect(page.getByText("Context reset admitted.", { exact: false })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({ type: "reset", handoff: "Keep only the approved direction" });
  await expect(draft).toHaveValue("Keep this draft");
});
