import { expect, test } from "@playwright/test";

test("nested code-mode calls use supplied disclosures without inventing output", async ({
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
                        callId: "parent",
                        name: "codemode",
                        arguments: { code: "test" },
                        state: "complete",
                        nested: {
                          state: "available",
                          calls: [
                            {
                              parentCallId: "parent",
                              callId: "parent/c1",
                              name: "read",
                              state: "complete",
                            },
                          ],
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
  await page.getByRole("button", { name: "1 tool call" }).click();
  await page.getByRole("button", { name: /Used tool.*codemode/ }).click();
  await page.getByRole("button", { name: /Used tool.*read/ }).click();
  await expect(page.getByText("Nested arguments unavailable.")).toBeVisible();
  await expect(page.getByText("Nested output unavailable.")).toBeVisible();
});
