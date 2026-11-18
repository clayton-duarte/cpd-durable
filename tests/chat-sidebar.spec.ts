import { expect, test, type Page } from "@playwright/test";
import { RenameChatSchema, ForkChatSchema, type ChatSummary } from "../src/shared/chats.ts";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

async function workspace(page: Page, withHistory = false, mockEvents = true) {
  await page.route("**/api/**", (route) => route.abort());
  await syntheticDrafts(page);
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
  if (mockEvents)
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
                          source: { entryId: index + 1 },
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
      Object.defineProperty(window, "EventSource", { value: Source, configurable: true });
    }, withHistory);
}
const draft = (page: Page) => page.getByRole("textbox", { name: "Message input", exact: true });

test("private feedback targets committed messages and retries an uncertain save across chat navigation", async ({
  page,
}) => {
  await workspace(page, false, false);
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      disconnect = () => this.onerror?.();
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
        window.addEventListener("feedback-disconnect", this.disconnect);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
                messages: [
                  {
                    id: "10:0",
                    role: "user",
                    text: "Question",
                    interrupted: false,
                    source: { entryId: 10 },
                  },
                  {
                    id: "11:2",
                    role: "assistant",
                    text: "Saved answer",
                    interrupted: false,
                    source: { entryId: 11, feedbackModelIndex: 2 },
                  },
                  {
                    id: "12:0",
                    role: "assistant",
                    text: "",
                    interrupted: false,
                    source: { entryId: 12 },
                    parts: [
                      {
                        id: "12:0:0",
                        type: "tool-call",
                        callId: "test-call",
                        name: "test-tool",
                        arguments: {},
                        state: "complete",
                      },
                    ],
                  },
                ],
                partial: "",
                busy: false,
                hasEarlier: false,
                failure: null,
                history: {
                  view: new URL(url, location.href).searchParams.get("view"),
                  epoch: "11111111-1111-4111-8111-111111111111",
                  revision: 1,
                  oldest: 10,
                  gaps: [{ after: 10, upTo: 11 }],
                },
                live: {
                  id: "generation:1",
                  taskId: 5,
                  afterEntryId: 12,
                  text: "Live answer",
                  parts: [{ id: "live:0", type: "text", text: "Live answer" }],
                },
                controls: { canContinue: false, resetPending: false, queue: [] },
              }),
            }),
          ),
        );
      }
      close() {
        window.removeEventListener("feedback-disconnect", this.disconnect);
      }
    }
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  const requests: {
    requestId: string;
    expectedRevision: number;
    value: { vote: string; comment: string | null } | null;
  }[] = [];
  let release: (() => void) | undefined;
  let value: { vote: string; comment: string | null } | null = null;
  let revision = 0;
  await page.route("**/api/chats/*/feedback/*/*", async (route) => {
    const chat = new URL(route.request().url()).pathname.split("/")[3]!;
    const view = () => ({
      conversationId: chat,
      target: { entryId: 11, modelIndex: 2 },
      revision: chat === "1" ? revision : 0,
      value: chat === "1" ? value : null,
      readOnly: chat === "2",
    });
    expect(new URL(route.request().url()).pathname).toBe(`/api/chats/${chat}/feedback/11/2`);
    if (route.request().method() === "GET") return route.fulfill({ json: view() });
    expect(chat).toBe("1");
    const body = route.request().postDataJSON() as (typeof requests)[number];
    requests.push(body);
    if (requests.length === 2) return route.abort();
    if (requests.length === 3)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    revision = body.expectedRevision + 1;
    value = body.value;
    return route.fulfill({ json: view() });
  });
  await page.goto("/chats/1");
  const saved = page.locator('[aria-hidden="false"] [data-durable-id="11:2"]');
  await saved.hover();
  await expect(saved.getByRole("button", { name: "Helpful", exact: true })).toBeVisible();
  await expect(
    page.locator('[data-durable-id="10:0"]').getByRole("button", { name: "Helpful" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-durable-id="12:0"]').getByRole("button", { name: "Helpful" }),
  ).toHaveCount(0);
  const gap = page.locator('[data-message-id^="history-gap:"]');
  await expect(gap).toHaveCount(1);
  await expect(gap.getByRole("button", { name: "Helpful" })).toHaveCount(0);
  await expect(page.locator('[data-message-status="running"]')).toHaveCount(1);
  await expect(
    page.locator('[data-message-status="running"]').getByRole("button", { name: "Helpful" }),
  ).toHaveCount(0);
  await saved.getByRole("button", { name: "Helpful", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Private feedback, stored with this chat—not sent to provider",
  );
  await dialog.getByLabel("Optional comment").fill("First comment");
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect(dialog).toContainText("Saved revision 1.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await saved.hover();
  await expect(saved.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await saved.getByRole("button", { name: "Not helpful" }).click();
  await dialog.getByLabel("Optional comment").fill("Original retry comment");
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect(dialog).toContainText("Save unconfirmed");
  await dialog.getByLabel("Optional comment").fill("Newer draft");
  await dialog.getByRole("button", { name: "Retry same save" }).click();
  await expect.poll(() => requests.length).toBe(3);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Second chat", exact: true }).click();
  const other = page.locator('[aria-hidden="false"] [data-durable-id="11:2"]');
  await other.hover();
  await expect(other.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(other.getByRole("button", { name: "Helpful", exact: true })).toBeDisabled();
  release?.();
  await page.getByRole("button", { name: /Original chat/ }).click();
  await saved.hover();
  await saved.getByRole("button", { name: "Not helpful" }).click();
  await expect(dialog.getByLabel("Optional comment")).toHaveValue("Newer draft");
  expect(requests[2]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({
    expectedRevision: 0,
    value: { vote: "helpful", comment: "First comment" },
  });
  expect(requests[1]).toMatchObject({
    expectedRevision: 1,
    value: { vote: "unhelpful", comment: "Original retry comment" },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("feedback-disconnect")));
  await expect(dialog.getByRole("button", { name: "Retry same save" })).toBeDisabled();
  expect(requests).toHaveLength(3);
});

test("supplied inline rename persists a title without changing route or unsent draft", async ({
  page,
}) => {
  await workspace(page);
  let title = "Second chat";
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false },
          { id: "2", title, running: false },
        ],
      },
    }),
  );
  await page.route("**/api/chats/2/rename", async (route) => {
    const request = RenameChatSchema.parse(route.request().postDataJSON());
    expect(request.expected).toBe("Second chat");
    title = request.title;
    return route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false },
          { id: "2", title, running: false },
        ],
      },
    });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Retain rename draft");
  const row = page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: "Second chat" });
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Rename thread" });
  await input.fill("Renamed branch");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Renamed branch", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toHaveValue("Retain rename draft");
});

test("durable fork retries keep their boundary and branch navigation restores the source draft", async ({
  page,
}) => {
  await workspace(page, true);
  const chats: ChatSummary[] = [
    { id: "1", title: "Original chat", running: false, status: "regular" },
    { id: "2", title: "Second chat", running: false, status: "regular" },
  ];
  await page.route("**/api/chats", (route) => route.fulfill({ json: { rootId: "1", chats } }));
  const requests: unknown[] = [];
  await page.route("**/api/chats/2/fork", async (route) => {
    const request = ForkChatSchema.parse(route.request().postDataJSON());
    requests.push(request);
    if (requests.length === 1) return route.abort();
    const created: ChatSummary = {
      id: "3",
      title: "Fork of Second chat",
      running: false,
      status: "regular",
      parentId: "2",
      forkEntryId: request.at,
      branchRootId: "2",
    };
    chats.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  await page.goto("/chats/2");
  await draft(page).fill("Source draft survives");
  const lastRow = page.locator('[data-durable-id="80:0"]');
  await lastRow.hover();
  await lastRow.getByRole("button", { name: "Fork from saved entry" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Fork from saved entry 80?");
  await dialog.getByRole("button", { name: "Create fork", exact: true }).click();
  await expect(dialog).toContainText("Fork not confirmed");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/3$/);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(draft(page)).toHaveValue("");
  await draft(page).fill("Fork draft");
  await page.getByRole("button", { name: "Show previous saved branch" }).click();
  await expect(page).toHaveURL(/\/chats\/2$/);
  await expect(draft(page)).toHaveValue("Source draft survives");
  await page.getByRole("button", { name: "Show next saved branch" }).click();
  await expect(draft(page)).toHaveValue("Fork draft");
  await page.getByRole("button", { name: "Open source chat", exact: true }).click();
  await expect(draft(page)).toHaveValue("Source draft survives");
});

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
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(1);
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/1$/);
  await expect(page.getByRole("button", { name: "Second chat", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived chats", exact: true }).click();
  const row = page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: "Second chat" });
  await row.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
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
