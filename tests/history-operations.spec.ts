import { expect, test, type Page } from "@playwright/test";

const catalog = {
  rootId: "1",
  chats: [
    { id: "1", title: "First", running: false, status: "regular" },
    { id: "2", title: "Second", running: false, status: "regular" },
    { id: "3", title: "Old", running: false, status: "archived" },
  ],
};
async function setup(page: Page) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) => route.fulfill({ json: catalog }));
  await page.addInitScript(() => {
    class SyntheticSource extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        const match = /\/chats\/(\d+)\//.exec(url);
        const id = Number(match?.[1] ?? 1);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
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
    Object.defineProperty(window, "EventSource", { value: SyntheticSource });
  });
}
function report(
  scope: { conversationIds: string[]; includeArchived: boolean },
  status = "complete",
) {
  return {
    scope,
    status,
    partial: status !== "complete",
    scannedEntries: 2,
    conversations: scope.conversationIds.map((id) => ({
      conversationId: id,
      archived: id === "3",
      upperEntryId: 42,
      scannedEntries: 2,
      complete: status === "complete",
    })),
  };
}
test.beforeEach(async ({ page }) => setup(page));

test("search and logical export use explicit selected scope and preserve the composer draft", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/history-operations/search", async (route) => {
    const request = route.request().postDataJSON() as {
      scope: { conversationIds: string[]; includeArchived: boolean };
      search: { query: string };
    };
    requests.push(request);
    await route.fulfill({
      json: {
        report: report(request.scope, "capped"),
        query: request.search.query,
        caseSensitive: false,
        offsetEncoding: "utf-16",
        hits: [
          {
            conversationId: "1",
            originConversationId: "1",
            entryId: 42,
            messageId: "42:0",
            role: "user",
            start: 0,
            end: 6,
            match: "needle",
          },
        ],
      },
    });
  });
  await page.route("**/api/history-operations/export", async (route) => {
    const request = route.request().postDataJSON() as {
      scope: { conversationIds: string[]; includeArchived: boolean };
      format: string;
    };
    requests.push(request);
    await route.fulfill({
      json: {
        format: request.format,
        content: "# Logical transcript\n",
        report: report(request.scope),
      },
    });
  });
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep draft");
  await page.getByRole("button", { name: "Chat details" }).click();
  await page.getByRole("button", { name: "Search or export saved history" }).click();
  await page.getByLabel("Search saved text").fill("needle");
  await page.getByRole("button", { name: "Search saved history" }).click();
  await expect(page.getByText(/Status: capped/)).toBeVisible();
  await expect(page.getByText(/message 42:0/)).toContainText("entry 42");
  expect(requests[0]).toMatchObject({
    scope: { conversationIds: ["1"], includeArchived: false },
    search: { query: "needle" },
  });
  await page.getByLabel("Export format").selectOption("json");
  await page.getByRole("button", { name: "Prepare logical export" }).click();
  await expect(page.getByText(/Status: complete/)).toBeVisible();
  const wait = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON" }).click();
  expect((await wait).suggestedFilename()).toBe("logical-transcript.json");
  expect(requests[1]).toMatchObject({ scope: { conversationIds: ["1"] }, format: "json" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft).toHaveValue("Keep draft");
});

test("multiple and catalog scopes explicitly include archived and label navigation without an entry jump", async ({
  page,
}) => {
  await page.route("**/api/history-operations/search", async (route) => {
    const request = route.request().postDataJSON() as {
      scope: { conversationIds: string[]; includeArchived: boolean };
      search: { query: string };
    };
    await route.fulfill({
      json: {
        report: report(request.scope),
        query: request.search.query,
        caseSensitive: false,
        offsetEncoding: "utf-16",
        hits: [
          {
            conversationId: "2",
            originConversationId: "1",
            entryId: 42,
            messageId: "42:0",
            role: "assistant",
            start: 0,
            end: 6,
            match: "needle",
          },
        ],
      },
    });
  });
  await page.goto("/chats/1");
  await page.getByRole("button", { name: "Chat details" }).click();
  await page.getByRole("button", { name: "Search or export saved history" }).click();
  await page.getByLabel("History scope").selectOption("multiple");
  await page.getByLabel(/Second · chat 2/).check();
  await page.getByLabel("Include archived chats").check();
  await page.getByLabel(/Old · chat 3/).check();
  await page.getByLabel("Search saved text").fill("needle");
  await page.getByRole("button", { name: "Search saved history" }).click();
  await expect(page.getByText(/Chat 3 \(archived\): upper entry 42/)).toBeVisible();
  await expect(page.getByText(/origin chat 1/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open chat (not entry)" })).toHaveAttribute(
    "href",
    "/chats/2",
  );
  await page.getByLabel("History scope").selectOption("catalog");
  await expect(page.getByText(/origin chat 1/)).not.toBeVisible();
});

test("cancelling a pending read discards a late result without stopping the run", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/history-operations/search", async (route) => {
    const request = route.request().postDataJSON() as {
      scope: { conversationIds: string[]; includeArchived: boolean };
      search: { query: string };
    };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({
        json: {
          report: report(request.scope),
          query: request.search.query,
          caseSensitive: false,
          offsetEncoding: "utf-16",
          hits: [],
        },
      })
      .catch(() => {});
  });
  await page.goto("/chats/1");
  await page.getByRole("button", { name: "Chat details" }).click();
  await page.getByRole("button", { name: "Search or export saved history" }).click();
  await page.getByLabel("Search saved text").fill("needle");
  await page.getByRole("button", { name: "Search saved history" }).click();
  await expect(page.getByRole("button", { name: "Cancel read" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel read" }).click();
  release?.();
  await expect(page.getByText("Read cancelled. No agent work was stopped.")).toBeVisible();
  await expect(page.getByText(/0 matches/)).not.toBeVisible();
});

test("rejects a wrong-scope response and closes the inspector when changing chats", async ({
  page,
}) => {
  await page.route("**/api/history-operations/search", async (route) => {
    const request = route.request().postDataJSON() as { search: { query: string } };
    await route.fulfill({
      json: {
        report: report({ conversationIds: ["2"], includeArchived: false }),
        query: request.search.query,
        caseSensitive: false,
        offsetEncoding: "utf-16",
        hits: [],
      },
    });
  });
  await page.goto("/chats/1");
  await page.getByRole("button", { name: "Chat details" }).click();
  await page.getByRole("button", { name: "Search or export saved history" }).click();
  await page.getByLabel("Search saved text").fill("needle");
  await page.getByRole("button", { name: "Search saved history" }).click();
  await expect(
    page.getByText("Saved history is unavailable. No message or run was sent."),
  ).toBeVisible();
  await page.evaluate(() => history.pushState(null, "", "/chats/2"));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
