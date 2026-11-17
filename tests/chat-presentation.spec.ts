import { test, expect } from "@playwright/test";

const empty = { messages: [], partial: "", busy: false, hasEarlier: false, failure: null };

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
