import { expect, test } from "@playwright/test";

test("edit uses the native composer, safely retries the same operation and keeps the source draft", async ({
  page,
}) => {
  let created = false;
  let recoveredRequestId = "";
  const requests: unknown[] = [];
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original", running: false },
          ...(created ? [{ id: "2", title: "Edited", running: false }] : []),
        ],
      },
    }),
  );
  await page.route("**/api/chats/1/edit-eligibility/*", (route) =>
    route.fulfill({ json: { eligible: route.request().url().endsWith("/10") } }),
  );
  await page.route("**/api/chats/1/edit-operations/*", (route) =>
    route.fulfill({
      json: {
        operations: created
          ? [
              {
                type: "edit",
                sourceId: "1",
                entryId: "10",
                branchId: "2",
                forkEntryId: null,
                configuration: "source-current-at-creation",
                status: "admitted",
                submissionId: "30",
                requestId: recoveredRequestId,
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/chats/1/edit-branch", async (route) => {
    const body = route.request().postDataJSON() as {
      sourceId: string;
      entryId: string;
      requestId: string;
      text: string;
    };
    requests.push(body);
    if (requests.length === 1) {
      created = true;
      recoveredRequestId = body.requestId;
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    }
    if (requests.length === 2) return route.fulfill({ status: 409, json: { error: "Conflict" } });
    created = true;
    return route.fulfill({
      status: 202,
      json: {
        type: "edit",
        sourceId: body.sourceId,
        entryId: body.entryId,
        branchId: "2",
        forkEntryId: null,
        configuration: "source-current-at-creation",
        status: "admitted",
        submissionId: "30",
      },
    });
  });
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
                messages:
                  id === 1
                    ? [
                        {
                          id: "10:0",
                          role: "user",
                          text: "Original message",
                          interrupted: false,
                          source: { entryId: 10 },
                        },
                        {
                          id: "20:0",
                          role: "user",
                          text: "Unsupported message",
                          interrupted: false,
                          source: { entryId: 20 },
                        },
                      ]
                    : [],
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
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Keep my draft");
  const first = page.locator('[data-durable-id="10:0"]');
  await first.hover();
  await first.getByRole("button", { name: "Edit in new chat" }).click();
  const editor = page.locator('[data-slot="aui_edit-composer-wrapper"] textarea');
  await editor.fill("Replacement message");
  await page.getByRole("button", { name: "Continue to new chat" }).click();
  await expect(page.getByText(/original chat and its draft remain unchanged/i)).toBeVisible();
  await page.getByRole("button", { name: "Create edited chat" }).click();
  await expect(page.getByRole("button", { name: "Retry same edit" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same edit" }).click();
  await expect(page.getByRole("button", { name: "Close and recover later" })).toBeVisible();
  await page.getByRole("button", { name: "Close and recover later" }).click();
  await page.reload();
  await first.hover();
  await first.getByRole("button", { name: "Edit in new chat" }).click();
  await editor.fill("Replacement message");
  await page.getByRole("button", { name: "Continue to new chat" }).click();
  await page.getByRole("button", { name: "Open created chat" }).click();
  await expect(page).toHaveURL(/\/chats\/2$/);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ sourceId: "1", entryId: "10", text: "Replacement message" });
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(
    page.locator('[data-durable-id="20:0"]').getByRole("button", { name: "Edit in new chat" }),
  ).toHaveCount(0);
});
