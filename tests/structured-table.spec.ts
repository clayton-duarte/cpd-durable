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
  await page.getByRole("button", { name: "1 tool call" }).click();
  const trigger = page.getByRole("button", { name: /Used tool.*display_table/ });
  await trigger.click();
  const result = page.locator('[data-slot="data-table"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText("Zulu");
  await expect(result).toContainText("Alpha");
  const sort = page.getByRole("button", { name: "Sort by Name" });
  if (await sort.isVisible()) {
    await sort.click();
    await expect(page.getByText("Sorted by Name, ascending")).toHaveCount(1);
  }
  await expect(page.getByRole("button", { name: /^(Apply|Export|Edit)$/ })).toHaveCount(0);
  await trigger.click();
  await expect(result).not.toBeVisible();
});
