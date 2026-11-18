import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page, withHistory = false) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: true },
          { id: "2", title: "Second chat", running: false },
        ],
      },
    }),
  );
  await page.addInitScript((withHistory) => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        super();
        const id = new URL(url, location.href).pathname.split("/")[3]!;
        queueMicrotask(() => {
          if (!this.closed)
            this.dispatchEvent(
              new MessageEvent("state", {
                data: JSON.stringify({
                  conversationId: Number(id),
                  messages: withHistory
                    ? Array.from({ length: 80 }, (_, index) => ({
                        id: `${index + 1}:0`,
                        role: "user",
                        text: `Historical turn ${index + 1}\nLine two\nLine three`,
                        interrupted: false,
                      }))
                    : [],
                  partial: "",
                  busy: id === "1",
                  hasEarlier: false,
                  failure: null,
                  controls: { canContinue: false, resetPending: false, queue: [] },
                }),
              }),
            );
        });
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "EventSource", { value: Source });
  }, withHistory);
}
const draft = (page: Page) => page.getByRole("textbox", { name: "Message input", exact: true });

test("routes, back/forward and drafts stay isolated while another chat runs", async ({ page }) => {
  await workspace(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/chats\/1$/);
  await draft(page).fill("Original draft");
  await expect(page.locator('[data-slot="aui_thread-list-item-running"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toHaveValue("");
  await draft(page).fill("Second draft");
  await page.goBack();
  await expect(draft(page)).toHaveValue("Original draft");
  await page.goForward();
  await expect(draft(page)).toHaveValue("Second draft");
  await expect(page.getByRole("button", { name: "More options" })).toHaveCount(2);
  await expect(page.locator('[data-slot="aui_thread-list-group-label"]')).toHaveCount(0);
});

test("uncertain creation retries the same identity and navigates only on acknowledgement", async ({
  page,
}) => {
  await workspace(page);
  const requests: unknown[] = [];
  await page.route("**/api/chats", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.abort();
    return route.fulfill({ status: 201, json: { id: "3", title: "New chat", running: false } });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Keep this draft");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByText("Chat creation could not be confirmed. Retry safely.")).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/3$/);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("deep links and unavailable chats do not silently open the original", async ({ page }) => {
  await workspace(page);
  await page.goto("/chats/2");
  await expect(draft(page)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toBeVisible();
  await page.goto("/chats/999");
  await expect(page.getByText("Chat not found", { exact: true })).toBeVisible();
  await expect(draft(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open original chat" }).click();
  await expect(page).toHaveURL(/\/chats\/1$/);
});

test("mobile supplied sidebar closes after switching and keeps the draft", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await workspace(page);
  await page.goto("/chats/2");
  await draft(page).fill("Mobile draft");
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByRole("button", { name: /Original chat/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  await expect(draft(page)).toHaveValue("Mobile draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("delivery retry identity stays with its chat across navigation", async ({ page }) => {
  await workspace(page);
  const attempts: unknown[] = [];
  await page.route("**/api/chats/2/input", async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) return route.abort();
    return route.fulfill({ status: 202, json: { id: "10" } });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Uncertain message");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Delivery could not be confirmed. Retry the original action safely."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Original chat/ }).click();
  await expect(
    page.getByText("Delivery could not be confirmed. Retry the original action safely."),
  ).toBeHidden();
  await draft(page).fill("Independent original draft");
  await page.goBack();
  await expect(draft(page)).toHaveValue("Uncertain message");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(draft(page)).toHaveValue("");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
});

test("browser navigation closes an outgoing reset dialog without sending its handoff", async ({
  page,
}) => {
  await workspace(page);
  await page.goto("/chats/1");
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  await draft(page).fill("/ ");
  await draft(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft(page).press("ArrowLeft");
  await draft(page).press("ArrowRight");
  await page.getByRole("option", { name: /\/reset/ }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("switching preserves the reading position of retained history", async ({ page }) => {
  await workspace(page, true);
  await page.goto("/chats/2");
  const viewport = page.locator('[data-slot="aui_thread-viewport"]:visible');
  await expect(page.getByText("Historical turn 80", { exact: false }).last()).toBeVisible();
  await viewport.evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(400);
  await page.getByRole("button", { name: /Original chat/ }).click();
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(400);
});

test("New chat reselects the existing empty chat without clearing its draft", async ({ page }) => {
  await workspace(page);
  await page.route("**/api/chats", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 201,
      json: { id: "2", title: "Second chat", running: false, status: "regular" },
    });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Unsent empty-chat draft");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toHaveValue("Unsent empty-chat draft");
});

test("chat context menus archive, restore and confirm deletion without resurrecting rows", async ({
  page,
}) => {
  await workspace(page);
  let chats = [
    { id: "1", title: "Original chat", running: false, status: "regular" },
    { id: "2", title: "Second chat", running: false, status: "regular" },
  ];
  await page.route("**/api/chats", (route) => route.fulfill({ json: { rootId: "1", chats } }));
  await page.route("**/api/chats/*/manage", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const { action } = route.request().postDataJSON() as { action: string };
    chats =
      action === "delete"
        ? chats.filter((chat) => chat.id !== id)
        : chats.map((chat) =>
            chat.id === id
              ? { ...chat, status: action === "archive" ? "archived" : "regular" }
              : chat,
          );
    await route.fulfill({ json: { rootId: "1", chats } });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Retain on archive");
  await page.getByRole("button", { name: "Second chat", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/1$/);
  await expect(page.getByRole("button", { name: "Second chat", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived chats", exact: true }).click();
  const row = page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: "Second chat" });
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  await expect(draft(page)).toHaveValue("Retain on archive");
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Underlying pi-durable records remain");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft(page)).toHaveValue("Retain on archive");
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete chat", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Second chat", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Second chat", exact: true })).toHaveCount(0);
});
