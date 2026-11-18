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
  await page.route("**/api/saved-prompts/*", (route) => {
    const body = route.request().postDataJSON() as {
      id: string;
      title?: string;
      text?: string;
      expectedRevision: number;
    };
    const index = saved.findIndex((item) => item.id === body.id);
    const old = saved[index]!;
    if (body.expectedRevision !== old.revision)
      return route.fulfill({ status: 409, json: { error: "Conflict" } });
    if (route.request().method() === "DELETE") {
      saved.splice(index, 1);
      return route.fulfill({ json: { prompt: old, deleted: true } });
    }
    const prompt = { ...old, title: body.title!, text: body.text!, revision: old.revision + 1 };
    saved[index] = prompt;
    return route.fulfill({ json: { prompt, deleted: false } });
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
  await page.getByRole("button", { name: "Append to draft" }).click();
  await expect(draft).toHaveValue("literal ${example}\nliteral ${example}");
  await draft.fill("/ working draft");
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft.press("ArrowLeft");
  await draft.press("ArrowRight");
  await page.getByRole("option", { name: /\/prompts/ }).click();
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("button", { name: "Replace draft" }).click();
  await expect(draft).toHaveValue("literal ${example}");
  await draft.fill("/ current");
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft.press("ArrowLeft");
  await draft.press("ArrowRight");
  await page.getByRole("option", { name: /\/prompts/ }).click();
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("textbox", { name: "Edit prompt text" }).fill("Changed literal");
  saved[0]!.revision = 2;
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect(page.getByRole("button", { name: "Reload latest revision" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest revision" }).click();
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue(
    "Changed literal",
  );
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect.poll(() => saved[0]?.revision).toBe(3);
  await page.getByRole("button", { name: "Delete prompt" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(saved).toHaveLength(1);
  await page.getByRole("button", { name: "Delete prompt" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect.poll(() => saved.length).toBe(0);
  expect(sends).toBe(0);
});
