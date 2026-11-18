import { expect, test } from "@playwright/test";

test("native edit receipt appears only inside its disclosure", async ({ page }) => {
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
                        callId: "edit-one",
                        name: "edit",
                        arguments: {},
                        state: "complete",
                        output: "Edited.",
                        editDiff: {
                          kind: "patch",
                          patch:
                            "Index: sample\n===================================================================\n--- sample\n+++ sample\n@@ -1,1 +1,1 @@\n-before\n+after\n",
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
  await expect(page.locator('[data-slot="code-diff"]')).not.toBeVisible();
  await page.getByRole("button", { name: "1 tool call" }).click();
  const trigger = page.getByRole("button", { name: /Used tool.*edit/ });
  await trigger.click();
  const diff = page.locator('[data-slot="code-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("before");
  await expect(diff).toContainText("after");
  await expect(page.getByRole("button", { name: /^(Apply|Undo|Discard|Accept)$/ })).toHaveCount(0);
  await trigger.click();
  await expect(diff).not.toBeVisible();
});
