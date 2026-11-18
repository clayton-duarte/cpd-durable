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
                            'Index: https://invalid.example/a\n===================================================================\n--- https://invalid.example/a\n+++ https://invalid.example/b\n@@ -1,1 +1,1 @@\n-before\n+<img src="https://invalid.example/image" onerror="alert(1)">\n',
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
  await expect(diff).toContainText('<img src="https://invalid.example/image" onerror="alert(1)">');
  await expect(diff.locator("img, a")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Apply|Undo|Discard|Accept)$/ })).toHaveCount(0);
  await trigger.click();
  await expect(diff).not.toBeVisible();
});

test("unavailable and malformed receipts retain ordinary output only inside disclosures", async ({
  page,
}) => {
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
                        callId: "edit",
                        name: "edit",
                        arguments: {},
                        state: "complete",
                        output: "Original output.",
                        editDiff: { kind: "patch", patch: "not a unified patch" },
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
  await expect(page.getByText("Original output.")).not.toBeVisible();
  await page.getByRole("button", { name: "1 tool call" }).click();
  const trigger = page.getByRole("button", { name: /Used tool.*edit/ });
  await trigger.click();
  await expect(page.getByText("Original output.", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Edit diff unavailable.", { exact: true })).toHaveCount(1);
  await expect(page.locator('[data-slot="code-diff"]')).toHaveCount(0);
  await trigger.click();
  await expect(page.getByText("Original output.")).not.toBeVisible();
});
