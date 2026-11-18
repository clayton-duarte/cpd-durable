import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const item = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Example",
  text: "Saved literal",
  revision: 1,
};
const uploadIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function openPicker(page: Page, text = "draft") {
  const draft = page
    .getByRole("textbox", { name: "Message input", exact: true })
    .filter({ visible: true });
  await draft.fill(`/ ${text}`);
  await draft.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(1, 1));
  await draft.press("ArrowLeft");
  await draft.press("ArrowRight");
  await page.getByRole("option", { name: /\/prompts/ }).click();
  return draft;
}
async function syntheticSources(page: Page) {
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      disconnect = () => this.onerror?.();
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.match(/\/chats\/(\d+)\//)?.[1] ?? 1);
        window.addEventListener(`disconnect-${id}`, this.disconnect);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
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
}

test("inserting a prompt autosaves through the native draft writer and survives reopen", async ({
  page,
}) => {
  let saved = { revision: 0, content: { text: "", images: [] as unknown[] } };
  let sends = 0;
  await syntheticSources(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "Original", running: false }],
        },
      });
    if (url.pathname === "/api/saved-prompts")
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (url.pathname.endsWith("/draft/attempts"))
      return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
    if (url.pathname.endsWith("/draft") && method === "GET") return route.fulfill({ json: saved });
    if (url.pathname.endsWith("/draft") && method === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof saved.content;
      };
      if (body.expectedRevision !== saved.revision) return route.fulfill({ status: 409, json: {} });
      saved = { revision: saved.revision + 1, content: body.content };
      return route.fulfill({ json: saved });
    }
    if (url.pathname.endsWith("/input")) sends++;
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
  const draft = await openPicker(page, "draft");
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("button", { name: "Append to draft" }).click();
  await expect(draft).toHaveValue("draft\nSaved literal");
  await expect.poll(() => saved.content.text).toBe("draft\nSaved literal");
  await page.reload();
  await expect(draft).toHaveValue("draft\nSaved literal");
  expect(sends).toBe(0);
});

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
  await syntheticDrafts(page);
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

test("prompt insertion retains existing and pending native images without reupload or send", async ({
  page,
}) => {
  const pendingUpload = gate();
  const listRead = gate();
  let uploads = 0,
    sends = 0,
    reads = 0;
  await syntheticSources(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "Original", running: false }],
        },
      });
    if (url.pathname === "/api/saved-prompts") {
      reads++;
      if (reads === 1) await listRead.promise;
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    }
    if (url.pathname.endsWith("/attachments") && route.request().method() === "POST") {
      const index = uploads++;
      if (index === 1) await pendingUpload.promise;
      return route.fulfill({
        status: 201,
        json: {
          id: uploadIds[index],
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    }
    if (url.pathname.includes("/attachments/"))
      return route.fulfill({ contentType: "image/png", body: png });
    if (url.pathname.endsWith("/input")) sends++;
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
  async function attach(name: string) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add Attachment" }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: png });
  }
  await attach("first.png");
  await expect(page.getByRole("button", { name: "Remove first.png" })).toBeVisible();
  await attach("second.png");
  await expect.poll(() => uploads).toBe(2);
  const draft = await openPicker(page);
  await expect.poll(() => reads).toBe(1);
  listRead.release();
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("button", { name: "Append to draft" }).click();
  await expect(draft).toHaveValue("draft\nSaved literal");
  pendingUpload.release();
  await expect(page.getByRole("button", { name: "Remove second.png" })).toBeVisible();
  await openPicker(page, "another");
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("button", { name: "Replace draft" }).click();
  await expect(draft).toHaveValue("Saved literal");
  await expect(page.getByRole("button", { name: "Remove first.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove second.png" })).toBeVisible();
  expect(await page.getByRole("button", { name: /Remove (first|second)\.png/ }).count()).toBe(2);
  const second = await page.getByRole("button", { name: "Remove second.png" }).elementHandle();
  expect(
    await page
      .getByRole("button", { name: "Remove first.png" })
      .evaluate(
        (first, other) =>
          !!(other && first.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING),
        second,
      ),
  ).toBe(true);
  expect(uploads).toBe(2);
  expect(sends).toBe(0);
});

test("late library read from chat A cannot apply or save in chat B", async ({ page }) => {
  const held = gate();
  let reads = 0,
    writes = 0;
  await syntheticSources(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [
            { id: "1", title: "First", running: false },
            { id: "2", title: "Second", running: false },
          ],
        },
      });
    if (url.pathname === "/api/saved-prompts") {
      if (route.request().method() !== "GET") {
        writes++;
        return route.abort();
      }
      reads++;
      if (reads === 1) await held.promise;
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    }
    if (url.pathname.endsWith("/input")) writes++;
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
  await openPicker(page, "first draft");
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Second", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message input" }).filter({ visible: true });
  await expect(draft).toBeEnabled();
  await draft.fill("second draft");
  held.release();
  await expect(page.getByText("Saved prompts—all chats")).toHaveCount(0);
  await expect(draft).toHaveValue("second draft");
  expect(writes).toBe(0);
});

test("disconnect after preview blocks insertion and all prompt mutations", async ({ page }) => {
  let writes = 0;
  await syntheticSources(page);
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Original", running: false }] },
      });
    if (url.pathname === "/api/saved-prompts" && route.request().method() === "GET")
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    if (route.request().method() !== "GET") writes++;
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
  const draft = await openPicker(page);
  await page.getByRole("option", { name: "Example" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-1")));
  await expect(page.getByRole("button", { name: "Replace draft" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save edit" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete prompt" })).toBeDisabled();
  for (const name of [
    "Append to draft",
    "Replace draft",
    "Save edit",
    "Delete prompt",
    "Save prompt",
  ]) {
    await page.getByRole("button", { name, exact: true }).dispatchEvent("click");
  }
  await page.getByRole("button", { name: "Close" }).click();
  await expect(draft).toHaveValue("draft");
  expect(writes).toBe(0);
});

test("late edit acknowledgement preserves newer form values and conflict reload is explicit", async ({
  page,
}) => {
  const held = gate();
  let current = { ...item },
    updates = 0;
  await syntheticSources(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Original", running: false }] },
      });
    if (url.pathname === "/api/saved-prompts")
      return route.fulfill({ json: { items: [current], nextCursor: null } });
    if (url.pathname === `/api/saved-prompts/${item.id}` && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        title: string;
        text: string;
        expectedRevision: number;
      };
      updates++;
      if (updates === 1) {
        await held.promise;
        current = { ...current, title: body.title, text: body.text, revision: 2 };
        return route.fulfill({ json: { prompt: current, deleted: false } });
      }
      return route.fulfill({ status: 409, json: { error: "Conflict" } });
    }
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEnabled();
  await openPicker(page);
  await page.getByRole("option", { name: "Example" }).click();
  await page.getByRole("textbox", { name: "Edit prompt title" }).fill("First");
  await page.getByRole("textbox", { name: "Edit prompt text" }).fill("First text");
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect.poll(() => updates).toBe(1);
  await page.getByRole("textbox", { name: "Edit prompt title" }).fill("Newer");
  await page.getByRole("textbox", { name: "Edit prompt text" }).fill("Newer text");
  held.release();
  await expect(page.getByRole("button", { name: "Save edit" })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Edit prompt title" })).toHaveValue("Newer");
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue("Newer text");
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect(page.getByRole("button", { name: "Reload latest revision" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest revision" }).click();
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue("Newer text");
  expect(updates).toBe(2);
});
