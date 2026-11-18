import { expect, test } from "@playwright/test";

test("caller table stays in its disclosure and sorts only supplied rows", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  await page.addInitScript(() => {
    class SyntheticSource extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
                messages: [
                  {
                    id: "1:0",
                    role: "assistant",
                    text: "",
                    interrupted: false,
                    outcome: "complete",
                    parts: [
                      {
                        id: "1:0:0",
                        type: "tool-call",
                        callId: "table",
                        name: "display_table",
                        arguments: {},
                        state: "complete",
                        output: "Caller-provided table: 2 rows, 2 columns.",
                        table: {
                          version: 1,
                          table: {
                            title: "Synthetic table",
                            source: "Author",
                            columns: [
                              { id: "name", label: "Name" },
                              { id: "score", label: "Score" },
                            ],
                            rows: [
                              { name: "Zulu", score: 4 },
                              { name: "Alpha", score: null },
                            ],
                          },
                        },
                      },
                      {
                        id: "1:0:1",
                        type: "tool-call",
                        callId: "edit",
                        name: "edit",
                        arguments: {},
                        state: "complete",
                        output: "Edit completed.",
                        editDiff: {
                          kind: "patch",
                          patch: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-before\n+after\n",
                        },
                      },
                    ],
                  },
                ],
                partial: "",
                busy: false,
                hasEarlier: false,
                failure: null,
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: SyntheticSource });
  });
  await page.goto("/");
  await expect(page.locator('[data-slot="data-table"]')).not.toBeVisible();
  await page.locator('[data-slot="tool-group-trigger"]').click();
  const trigger = page.getByRole("button", { name: /Used tool.*display_table/ });
  await trigger.click();
  const result = page.locator('[data-slot="data-table"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText("Zulu");
  await expect(result).toContainText("Alpha");
  await expect(
    page.getByText("Caller-provided table: 2 rows, 2 columns.", { exact: true }),
  ).toHaveCount(1);
  const editTrigger = page.getByRole("button", { name: /Used tool.*edit/ });
  await editTrigger.click();
  const diff = page.locator('[data-slot="code-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("before");
  await expect(diff).toContainText("after");
  await expect(page.getByText("Edit completed.", { exact: true })).toHaveCount(1);
  await editTrigger.click();
  await expect(diff).not.toBeVisible();
  await expect(result).toBeVisible();
  const sort = page.getByRole("button", { name: "Sort by Name" });
  if (await sort.isVisible()) {
    await sort.click();
    await expect(page.getByText("Sorted by Name, ascending")).toHaveCount(1);
  }
  await expect(page.getByRole("button", { name: /^(Apply|Export|Edit)$/ })).toHaveCount(0);
  await trigger.click();
  await expect(result).not.toBeVisible();
});
