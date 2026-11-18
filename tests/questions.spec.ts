import { test, expect, type Page } from "@playwright/test";

const pending = {
  questionId: "q-7",
  taskId: 7,
  revision: 1,
  status: "pending",
  actionable: true,
  cancelled: false,
  spec: {
    message: "Choose the next step",
    fields: [
      { id: "name", kind: "text", label: "Your name", required: true },
      {
        id: "color",
        kind: "choice",
        label: "Color",
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
      },
      {
        id: "extras",
        kind: "multi",
        label: "Extras",
        required: true,
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      },
    ],
  },
};
async function setup(page: Page) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false },
          { id: "2", title: "Other chat", running: false },
        ],
      },
    }),
  );
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onerror: (() => void) | null = null;
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: location.pathname.endsWith("/2") ? 2 : 1,
                messages: [],
                partial: "",
                busy: false,
                hasEarlier: false,
                failure: null,
                controls: { canContinue: false, resetPending: false, queue: [] },
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
}

test("answers through dedicated endpoint, preserving draft and same-payload retry", async ({
  page,
}) => {
  await setup(page);
  let resolved = false;
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/questions", (route) =>
    route.fulfill({ json: { conversationId: "1", questions: resolved ? [] : [pending] } }),
  );
  await page.route("**/api/chats/1/questions/resolve", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.abort();
    resolved = true;
    return route.fulfill({ json: { status: "already-resolved" } });
  });
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("Keep this unsent draft");
  await page.getByLabel("Your name").fill("Ada");
  await page.getByRole("button", { name: "Red (red)" }).click();
  await page.getByRole("switch", { name: "Extras: Alpha" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Answer not confirmed")).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Ada");
  await expect(page.getByLabel("Your name")).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Choose the next step")).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({
    questionId: "q-7",
    taskId: 7,
    revision: 1,
    resolution: { kind: "answer", values: { name: "Ada", color: "red", extras: ["a"] } },
  });
  await expect(draft).toHaveValue("Keep this unsent draft");
});

test("read-only chats disable actions and navigating does not decline", async ({ page }) => {
  await setup(page);
  let posted = 0;
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false, status: "archived" },
          { id: "2", title: "Other chat", running: false },
        ],
      },
    }),
  );
  await page.route("**/api/chats/1/questions", (route) =>
    route.fulfill({
      json: { conversationId: "1", questions: [{ ...pending, actionable: false }] },
    }),
  );
  await page.route("**/api/chats/2/questions", (route) =>
    route.fulfill({ json: { conversationId: "2", questions: [] } }),
  );
  await page.route("**/api/chats/*/questions/resolve", (route) => {
    posted++;
    return route.abort();
  });
  await page.goto("/chats/1");
  await expect(page.getByText("Choose the next step")).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toBeDisabled();
  await page.getByText("Other chat", { exact: true }).click();
  await expect(page.getByText("Choose the next step")).toBeHidden();
  expect(posted).toBe(0);
});

test("stale reads cannot place another chat's question after navigation", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chats/1/questions", async (route) => {
    started();
    await gate;
    await route.fulfill({ json: { conversationId: "1", questions: [pending] } }).catch(() => {});
  });
  await page.route("**/api/chats/2/questions", (route) =>
    route.fulfill({ json: { conversationId: "2", questions: [] } }),
  );
  await page.goto("/chats/1");
  await requested;
  await page.getByText("Other chat", { exact: true }).click();
  release();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(page.getByText("Choose the next step")).toHaveCount(0);
});
