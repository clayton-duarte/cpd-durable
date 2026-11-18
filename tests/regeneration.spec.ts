import { expect, test } from "@playwright/test";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";
import { readFile } from "node:fs/promises";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));

test("assistant action confirms and recovers an uncertain regeneration with the original identity", async ({
  page,
}) => {
  const requests: { sourceId: string; entryId: string; requestId: string }[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", (route) => route.abort());
  await syntheticDrafts(page);
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original", running: false },
          {
            id: "2",
            title: "Regenerated",
            running: false,
            parentId: "1",
            forkEntryId: "9",
            branchRootId: "1",
          },
          { id: "3", title: "Other chat", running: false },
        ],
      },
    }),
  );
  await page.route("**/api/chats/1/regeneration-eligibility/10", (route) =>
    route.fulfill({ json: { eligible: true } }),
  );
  await page.route("**/api/chats/1/attachments", (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png",
        size: png.length,
        prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
      },
    }),
  );
  await page.route("**/api/chats/1/attachments/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
  await page.route("**/api/chats/1/regenerations/10", (route) =>
    route.fulfill({
      json: {
        operations: requests.length
          ? [
              {
                type: "regenerate",
                sourceId: "1",
                entryId: "10",
                branchId: "2",
                forkEntryId: "9",
                status: "prepared",
                requestId: requests[0]!.requestId,
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/chats/1/regenerate", async (route) => {
    const request = route.request().postDataJSON() as {
      sourceId: string;
      entryId: string;
      requestId: string;
    };
    requests.push(request);
    if (requests.length === 1)
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    await delayed;
    return route.fulfill({
      status: 202,
      json: {
        type: "regenerate",
        sourceId: "1",
        entryId: "10",
        branchId: "2",
        forkEntryId: "9",
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
                          role: "assistant",
                          text: "Saved answer",
                          interrupted: false,
                          source: { entryId: 10 },
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
  await draft.fill("Keep this draft");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Remove draft.png" })).toBeVisible();
  const row = page.locator('[data-durable-id="10:0"]');
  await row.hover();
  await row.getByRole("button", { name: "Regenerate in new chat" }).click();
  await expect(page.getByText(/may repeat tool calls and external effects/i)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Remove draft.png" })).toBeVisible();
  expect(requests).toHaveLength(0);
  await row.hover();
  await row.getByRole("button", { name: "Regenerate in new chat" }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page.getByRole("button", { name: "Close and recover later" }).click();
  await expect(draft).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Remove draft.png" })).toBeVisible();
  await page.reload();
  await expect(draft).toBeVisible();
  expect(requests).toHaveLength(1);
  await draft.fill("Keep this draft");
  const chooserAfterReload = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (
    await chooserAfterReload
  ).setFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Remove draft.png" })).toBeVisible();
  await row.hover();
  await row.getByRole("button", { name: "Regenerate in new chat" }).click();
  await page.getByRole("button", { name: "Resume prepared regeneration" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/chats/3");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/chats\/3$/);
  release();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Other chat", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/3$/);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(draft).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Remove draft.png" })).toBeVisible();
});
