import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

test("templates insert into native drafts only after explicit append or replace", async ({
  page,
}) => {
  const id = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const template = {
    id,
    fingerprint,
    name: "queue",
    path: "/project/.pi/prompts/queue.md",
    truncated: false,
  };
  let inputs = 0;
  let stale = true;
  let releaseTemplate: (() => void) | undefined;
  await page.route("**/api/**", (route) => {
    if (route.request().url().endsWith("/input")) inputs++;
    return route.abort();
  });
  await syntheticDrafts(page);
  const savedTexts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/draft")) {
      const body = request.postDataJSON() as { content: { text: string } };
      savedTexts.push(body.content.text);
    }
  });
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Chat", running: false, status: "regular" }] },
    }),
  );
  const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
  let uploadCount = 0;
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/chats/1/attachments", async (route) => {
    const count = ++uploadCount;
    if (count === 2) await uploadGate;
    return route.fulfill({
      status: 201,
      json: {
        id:
          count === 1
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        mimeType: "image/png",
        size: png.length,
        prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
      },
    });
  });
  await page.route("**/api/chats/1/attachments/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );
  await page.route("**/api/chats/1/templates", (route) =>
    route.fulfill({ json: { conversationId: "1", templates: [template], issues: [], omitted: 0 } }),
  );
  await page.route(`**/api/chats/1/templates/${id}*`, async (route) => {
    if (stale) {
      stale = false;
      return route.fulfill({ status: 409, json: { error: "Changed" } });
    }
    if (!releaseTemplate)
      await new Promise<void>((resolve) => {
        releaseTemplate = resolve;
      });
    return route.fulfill({
      json: { conversationId: "1", template, text: "Literal $1 <b>text</b>" },
    });
  });
  await page.addInitScript(() => {
    class Source extends EventTarget {
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
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name: "one.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  const secondChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await secondChooser).setFiles({ name: "two.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => uploadCount).toBe(2);
  await draft.fill("Existing /");
  await page.getByRole("option", { name: /templates/i }).click();
  await expect(page.getByRole("dialog", { name: "Prompt templates" })).toBeVisible();
  await page.getByRole("option", { name: /queue.*project/ }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await page.getByRole("button", { name: "Refresh templates" }).click();
  await page.getByRole("option", { name: /queue.*project/ }).click();
  await expect.poll(() => !!releaseTemplate).toBe(true);
  await page
    .locator('textarea[aria-label="Message input"]')
    .evaluate((element: HTMLTextAreaElement) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        element,
        "Newer text",
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  releaseTemplate!();
  await expect(page.getByRole("textbox", { name: "Template preview" })).toHaveValue(
    "Literal $1 <b>text</b>",
  );
  await expect(
    page.getByText("/project/.pi/prompts/queue.md", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Append to draft" }).click();
  releaseUpload();
  await expect(draft).toHaveValue("Newer text\nLiteral $1 <b>text</b>");
  await expect.poll(() => savedTexts).toContain("Newer text\nLiteral $1 <b>text</b>");
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove two.png" })).toBeVisible();
  await draft.fill("Discard only by choice /");
  await page.getByRole("option", { name: /templates/i }).click();
  await page.getByRole("option", { name: /queue.*project/ }).click();
  await page.getByRole("button", { name: "Replace draft text" }).click();
  await expect(draft).toHaveValue("Literal $1 <b>text</b>");
  await expect.poll(() => savedTexts).toContain("Literal $1 <b>text</b>");
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  expect(inputs).toBe(0);
});

test("a delayed template read cannot cross navigation into an archived chat", async ({ page }) => {
  const id = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const template = {
    id,
    fingerprint,
    name: "example",
    path: "/example/.pi/prompts/example.md",
    truncated: false,
  };
  let release: (() => void) | undefined;
  await page.route("**/api/**", (route) => route.abort());
  await syntheticDrafts(page);
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "First", running: false, status: "regular" },
          { id: "2", title: "Archived", running: false, status: "archived" },
        ],
      },
    }),
  );
  await page.route("**/api/chats/1/templates", (route) =>
    route.fulfill({ json: { conversationId: "1", templates: [template], issues: [], omitted: 0 } }),
  );
  await page.route(`**/api/chats/1/templates/${id}*`, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route
      .fulfill({ json: { conversationId: "1", template, text: "STALE TEMPLATE" } })
      .catch(() => {});
  });
  await page.addInitScript(() => {
    class Source extends EventTarget {
      constructor(url: string) {
        super();
        const conversationId = Number(new URL(url, location.href).pathname.split("/")[3]);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId,
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
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("Retained /");
  await page.getByRole("option", { name: /templates/i }).click();
  await page.getByRole("option", { name: /example.*prompts/ }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.goto("/chats/2");
  release!();
  await expect(page.getByRole("dialog", { name: "Prompt templates" })).toHaveCount(0);
  await expect(page.getByText("STALE TEMPLATE")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeDisabled();
});

test("preview cannot insert when read-only, disconnected, or the retained chat changes", async ({
  page,
}) => {
  const id = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const template = {
    id,
    fingerprint,
    name: "example",
    path: "/example/.pi/prompts/example.md",
    truncated: false,
  };
  await page.route("**/api/**", (route) => route.abort());
  await syntheticDrafts(page);
  await page.route("**/api/chats/1/templates", (route) =>
    route.fulfill({
      json: { conversationId: "1", templates: [template], issues: [], omitted: 0 },
    }),
  );
  await page.route(`**/api/chats/1/templates/${id}*`, (route) =>
    route.fulfill({
      json: { conversationId: "1", template, text: "<img src='https://invalid.example/x'> $1" },
    }),
  );
  await page.goto("/tests/fixtures/template-guard.html");
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("Keep /");
  await page.getByRole("option", { name: /templates/i }).click();
  await page.getByRole("option", { name: /example.*prompts/ }).click();
  await expect(page.getByRole("textbox", { name: "Template preview" })).toHaveValue(
    "<img src='https://invalid.example/x'> $1",
  );
  await expect(page.locator("img[src^='https://invalid.example']")).toHaveCount(0);
  const insert = page.getByRole("button", { name: "Replace draft text" });
  async function setHost(chatId: string, readOnly: boolean, connected: boolean) {
    await page.evaluate(
      (value) => {
        const setter = Reflect.get(window, "__setTemplateFixture") as (value: unknown) => void;
        setter(value);
      },
      { chatId, readOnly, connected },
    );
  }
  await setHost("1", true, true);
  await expect(insert).toBeDisabled();
  await setHost("1", false, true);
  await expect(insert).toBeEnabled();
  await setHost("1", true, true);
  await expect(insert).toBeDisabled();
  await setHost("1", false, false);
  await expect(insert).toBeDisabled();
  await setHost("1", false, true);
  await expect(insert).toBeEnabled();
  await setHost("2", false, true);
  await expect(insert).toHaveCount(0);
  await expect(page.locator('textarea[aria-label="Message input"]')).toHaveValue("Keep ");
  expect(await page.evaluate(() => Reflect.has(window, "__templateSent"))).toBe(false);
});
