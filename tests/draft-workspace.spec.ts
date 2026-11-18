import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));

test("production composer saves, records original intent, and recovers an uncertain send", async ({
  page,
}) => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  let uploads = 0;
  let draft = {
    revision: 1,
    content: {
      text: "saved",
      images: [{ id: oldId, name: "saved.png", mimeType: "image/png", size: png.length }],
    },
  };
  let intent: Record<string, unknown> | undefined;
  const inputs: Record<string, unknown>[] = [];
  const writes: (typeof draft)[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
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
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
      });
    if (path === "/api/chats/1/draft" && method === "GET") return route.fulfill({ json: draft });
    if (path === "/api/chats/1/draft" && method === "PUT") {
      const input = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      if (input.expectedRevision !== draft.revision)
        return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: input.content };
      writes.push(draft);
      return route.fulfill({ json: draft });
    }
    if (path === "/api/chats/1/draft/attempts")
      return route.fulfill({
        json: {
          attempts: intent
            ? [{ record: { ...intent, fingerprint: "a".repeat(64) }, admission: "unknown" }]
            : [],
          capped: false,
          nextCursor: null,
        },
      });
    if (path === "/api/chats/1/draft/attempt") {
      intent = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { ...intent, fingerprint: "a".repeat(64) } });
    }
    if (path === "/api/chats/1/attachments" && method === "POST") {
      uploads++;
      return route.fulfill({
        status: 201,
        json: {
          id: newId,
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    }
    if (path.startsWith("/api/chats/1/attachments/"))
      return route.fulfill({ body: png, contentType: "image/png" });
    if (path === "/api/chats/1/input") {
      inputs.push(route.request().postDataJSON() as Record<string, unknown>);
      if (inputs.length === 1) {
        await gate;
        return route.abort();
      }
      return route.fulfill({ status: 202, json: { id: "1" } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("saved");
  await expect(page.getByText("saved.png").first()).toBeVisible();
  expect(uploads).toBe(0);
  await input.fill("  original  ");
  await expect.poll(() => draft.content.text).toBe("  original  ");
  await input.press("Enter");
  await expect.poll(() => inputs.length).toBe(1);
  expect(intent?.["requestId"]).toBe(inputs[0]?.["requestId"]);
  expect(inputs[0]).toMatchObject({
    text: "original",
    images: [oldId],
    draft: {
      revision: intent?.["draftRevision"],
      text: "  original  ",
      images: [oldId],
      attempt: true,
    },
  });
  await input.fill("newer");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "new.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect.poll(() => draft.content.text).toBe("newer");
  await expect.poll(() => draft.content.images.some((image) => image.id === newId)).toBe(true);
  expect(writes.some((write) => write.content.text === "")).toBe(false);
  release();
  await page.reload();
  await expect(input).toHaveValue("newer");
  await expect(page.getByText("new.png").first()).toBeVisible();
  expect(uploads).toBe(1);
  await expect(page.getByText(/Delivery unconfirmed/)).toBeVisible();
  expect(inputs).toHaveLength(1);
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]).toEqual(inputs[0]);
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(input).toHaveValue("newer");
});

test("an admitted receipt is not presented as unsent, and archived drafts are read-only", async ({
  page,
}) => {
  const requests: string[] = [];
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
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(`${route.request().method()} ${path}`);
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "Archived", running: false, status: "archived" }],
        },
      });
    if (path === "/api/chats/1/draft")
      return route.fulfill({
        json: { revision: 3, content: { text: "saved later", images: [] } },
      });
    if (path === "/api/chats/1/draft/attempts")
      return route.fulfill({
        json: {
          attempts: [
            {
              record: {
                requestId: "11111111-1111-4111-8111-111111111111",
                draftRevision: 1,
                fingerprint: "a".repeat(64),
                text: "already admitted",
                images: [],
                mode: "reject",
              },
              admission: "admitted",
              submissionId: "1",
            },
          ],
          capped: false,
          nextCursor: null,
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  await expect(page.getByRole("textbox", { name: "Message input" })).toHaveValue("saved later");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeDisabled();
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry original" })).toHaveCount(0);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("a confirmed transactional clear advances autosave without a false conflict", async ({
  page,
}) => {
  let draft = { revision: 1, content: { text: "first", images: [] as never[] } };
  const expectedRevisions: number[] = [];
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
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Chat", running: false }] },
      });
    if (path === "/api/chats/1/draft" && method === "GET") return route.fulfill({ json: draft });
    if (path === "/api/chats/1/draft" && method === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      expectedRevisions.push(body.expectedRevision);
      if (body.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: body.content };
      return route.fulfill({ json: draft });
    }
    if (path === "/api/chats/1/draft/attempts")
      return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
    if (path === "/api/chats/1/draft/attempt")
      return route.fulfill({
        json: { ...(route.request().postDataJSON() as object), fingerprint: "a".repeat(64) },
      });
    if (path === "/api/chats/1/input") {
      draft = { revision: 2, content: { text: "", images: [] } };
      return route.fulfill({ status: 202, json: { id: "1", clearedDraftRevision: 2 } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("first");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.fill("next");
  await expect.poll(() => draft.content.text).toBe("next");
  expect(expectedRevisions).toEqual([2]);
  await expect(page.getByText("Draft changed in another session.")).toHaveCount(0);
});
