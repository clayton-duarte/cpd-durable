import { expect, test } from "@playwright/test";

test("native composer saves and previews a literal prompt without sending the draft", async ({
  page,
}) => {
  const saved: { id: string; title: string; text: string; revision: number }[] = [];
  let sends = 0;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [{ id: "1", title: "Original", running: false }],
      },
    }),
  );
  await page.route("**/api/chats/1/input", (route) => {
    sends++;
    return route.abort();
  });
  await page.route("**/api/saved-prompts", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { items: saved, nextCursor: null } });
    const body = route.request().postDataJSON() as { id: string; title: string; text: string };
    const prompt = { id: body.id, title: body.title, text: body.text, revision: 1 };
    saved.push(prompt);
    return route.fulfill({ status: 201, json: { prompt, deleted: false } });
  });
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
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
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await expect(draft).toBeEnabled();
  await draft.fill("/ literal ${example}");
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft.press("ArrowLeft");
  await draft.press("ArrowRight");
  await page
    .locator('[data-slot="composer-trigger-popover"]')
    .getByText("/prompts", { exact: true })
    .click();
  await expect(page.getByText("Saved prompts—all chats")).toBeVisible();
  await page.getByRole("textbox", { name: "Prompt title" }).fill("Example");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]?.text).toBe("literal ${example}");
  await page.getByRole("option", { name: "Example" }).click();
  await expect(page.getByRole("textbox", { name: "Literal prompt preview" })).toHaveValue(
    "literal ${example}",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await expect(draft).toHaveValue("literal ${example}");
  expect(sends).toBe(0);
});
