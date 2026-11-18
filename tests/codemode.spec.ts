import { expect, test } from "@playwright/test";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

test("nested code-mode calls use supplied disclosures without inventing output", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await syntheticDrafts(page);
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  await page.route("**/api/chats/1/images/2/0/1", (route) =>
    route.fulfill({ path: "tests/fixtures/attachments/sample.png", contentType: "image/png" }),
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
                        output: "before\n[Non-text tool output is not displayed.]\nafter",
                        resultParts: [
                          { type: "text", text: "before" },
                          { type: "image", source: { entryId: 2, modelIndex: 0, partIndex: 1 } },
                          { type: "text", text: "after" },
                        ],
                        nested: {
                          state: "available",
                          outputSpilled: true,
                          calls: [
                            {
                              parentCallId: "parent",
                              callId: "parent/c1",
                              name: "read",
                              state: "complete",
                            },
                            {
                              parentCallId: "parent",
                              callId: "parent/c2",
                              name: "write",
                              state: "pending",
                            },
                            {
                              parentCallId: "parent",
                              callId: "parent/c3",
                              name: "bash",
                              state: "unavailable",
                            },
                            {
                              parentCallId: "parent",
                              callId: "parent/c4",
                              name: "mcp_123456789012345678901234__123456789012345678901234",
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
  await expect(page.getByText("before", { exact: true })).toHaveCount(1);
  await expect(page.getByText("after", { exact: true })).toHaveCount(1);
  await expect(page.locator('img[src="/api/chats/1/images/2/0/1"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Pending tool: write" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tool status unavailable: bash" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Used tool: mcp_123456789012345678901234__123456789012345678901234",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The SDK reports a code-mode output spill file; its contents are not shown here.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: /Used tool.*read/ }).click();
  await expect(page.getByText("Nested arguments unavailable.")).toBeVisible();
  await expect(page.getByText("Nested output unavailable.")).toBeVisible();
});
