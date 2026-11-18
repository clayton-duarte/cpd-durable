import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      update = (event: Event) => {
        if (event instanceof CustomEvent)
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(event.detail) }));
      };
      constructor(url: string) {
        super();
        const conversationId = Number(
          new URL(url, location.href).pathname.match(/\/chats\/(\d+)\//)?.[1] ?? 1,
        );
        window.addEventListener("attachment-test-state", this.update);
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
      close() {
        window.removeEventListener("attachment-test-state", this.update);
      }
    }
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
});
async function prepare(
  page: import("@playwright/test").Page,
  input: (route: import("@playwright/test").Route) => Promise<void>,
) {
  let uploads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
      });
    if (url.pathname.endsWith("/attachments") && route.request().method() === "POST") {
      const id = ids[uploads++]!;
      return route.fulfill({
        status: 201,
        json: {
          id,
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    }
    if (url.pathname.includes("/attachments/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.pathname.includes("/images/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.pathname.endsWith("/input")) return input(route);
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
  return () => uploads;
}
async function attach(page: import("@playwright/test").Page, name = "one.png") {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}
test("direct shell with an attachment is rejected without losing the draft", async ({ page }) => {
  let calls = 0;
  await prepare(page, async (route) => route.abort());
  await page.route("**/api/chats/1/shell", (route) => {
    if (route.request().method() === "POST") calls++;
    return route.fulfill({ json: null });
  });
  await attach(page);
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("!printf ignored");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Direct shell commands cannot include image attachments."),
  ).toBeVisible();
  await expect(draft).toHaveValue("!printf ignored");
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  expect(calls).toBe(0);
});
test("image-only retry preserves id and avoids reupload", async ({ page }) => {
  const bodies: unknown[] = [];
  const uploads = await prepare(page, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, json: { id: "1" } });
  });
  await attach(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Delivery not confirmed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(uploads()).toBe(1);
  await expect(page.getByRole("button", { name: "Remove one.png" })).toHaveCount(0);
});
test("new attachment survives acknowledgement of an unchanged text draft", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent: unknown;
  await prepare(page, async (route) => {
    sent = route.request().postDataJSON();
    await gate;
    await route.fulfill({ status: 202, json: { id: "1" } });
  });
  await attach(page);
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sent).toBeTruthy();
  expect(sent).toMatchObject({ text: "hello", images: [ids[0]], mode: "reject" });
  await attach(page, "two.png");
  release();
  await expect(page.getByRole("button", { name: "Remove two.png" })).toBeVisible();
  await expect(draft).toHaveValue("hello");
});
test("an upload still in flight is not cancelled by an earlier admission acknowledgement", async ({
  page,
}) => {
  let accept!: () => void, finishUpload!: () => void;
  const inputGate = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const uploadGate = new Promise<void>((resolve) => {
    finishUpload = resolve;
  });
  let inputStarted = false,
    uploadStarted = false;
  await prepare(page, async (route) => {
    inputStarted = true;
    await inputGate;
    await route.fulfill({ status: 202, json: { id: "1" } });
  });
  await attach(page);
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("keep");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => inputStarted).toBe(true);
  await page.route("**/api/chats/1/attachments", async (route) => {
    uploadStarted = true;
    await uploadGate;
    await route.fulfill({
      status: 201,
      json: {
        id: ids[1],
        mimeType: "image/png",
        size: png.length,
        prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
      },
    });
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name: "new.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => uploadStarted).toBe(true);
  accept();
  await expect(draft).toHaveValue("keep");
  finishUpload();
  await expect(page.getByRole("button", { name: "Remove new.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
});
test("removing and readding an identical server ID cannot clear the newer draft", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = false;
  await prepare(page, async (route) => {
    sent = true;
    await gate;
    await route.fulfill({ status: 202, json: { id: "1" } });
  });
  await page.route("**/api/chats/1/attachments", (route) =>
    route.fulfill({
      status: 201,
      json: {
        id: ids[0],
        mimeType: "image/png",
        size: png.length,
        prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
      },
    }),
  );
  await attach(page);
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("same");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sent).toBe(true);
  await page.getByRole("button", { name: "Remove one.png" }).click();
  await attach(page, "again.png");
  release();
  await expect(page.getByRole("button", { name: "Remove again.png" })).toBeVisible();
  await expect(draft).toHaveValue("same");
});
test("native paste uses the same upload and removal path", async ({ page }) => {
  const uploads = await prepare(page, async (route) =>
    route.fulfill({ status: 202, json: { id: "1" } }),
  );
  await page.getByRole("textbox", { name: "Message input" }).evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(bytes)], "paste.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
    },
    [...png],
  );
  await expect(page.getByRole("button", { name: "Remove paste.png" })).toBeVisible();
  expect(uploads()).toBe(1);
  await page.getByRole("button", { name: "Remove paste.png" }).click();
  await expect(page.getByRole("button", { name: "Remove paste.png" })).toHaveCount(0);
});
test("removal and newer text survive an uncertain retry", async ({ page }) => {
  const bodies: unknown[] = [];
  const uploads = await prepare(page, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, json: { id: "1" } });
  });
  await attach(page);
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("first");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Delivery not confirmed")).toBeVisible();
  await page.getByRole("button", { name: "Remove one.png" }).click();
  await draft.fill("new draft");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(uploads()).toBe(1);
  await expect(draft).toHaveValue("new draft");
  await expect(page.getByRole("button", { name: "Remove one.png" })).toHaveCount(0);
});
test("reports upload and unsupported model failures without discarding the draft", async ({
  page,
}) => {
  await prepare(page, async (route) =>
    route.fulfill({ status: 400, json: { error: "The selected model does not support images." } }),
  );
  await page.route("**/api/chats/1/attachments", (route) =>
    route.fulfill({ status: 400, json: { error: "bad image" } }),
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name: "bad.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Image upload failed. Choose an image and try again.")).toBeVisible();
  await page.unroute("**/api/chats/1/attachments");
  await attach(page);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("The selected model does not support images.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
});
test("saved and tool-result images use requesting-chat URLs and retain result order", async ({
  page,
}) => {
  const requested: string[] = [];
  await prepare(page, async (route) => route.fulfill({ status: 202, json: { id: "1" } }));
  await page.route("**/api/chats/1/images/**", (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("attachment-test-state", {
        detail: {
          conversationId: 1,
          partial: "",
          busy: false,
          hasEarlier: false,
          failure: null,
          messages: [
            {
              id: "5:0",
              role: "user",
              text: "beforeafter",
              interrupted: false,
              parts: [
                { id: "5:0:0", type: "text", text: "before" },
                { id: "5:0:1", type: "image", source: { entryId: 5, modelIndex: 0, partIndex: 1 } },
                { id: "5:0:2", type: "text", text: "after" },
              ],
            },
            {
              id: "6:0",
              role: "assistant",
              text: "",
              interrupted: false,
              outcome: "complete",
              parts: [
                {
                  id: "6:0:result",
                  type: "tool-call",
                  callId: "x",
                  name: "read",
                  arguments: {},
                  state: "complete",
                  output:
                    "first tool text\n[Non-text tool output is not displayed.]\nlast tool text",
                  resultParts: [
                    { type: "text", text: "first tool text" },
                    { type: "image", source: { entryId: 6, modelIndex: 0, partIndex: 1 } },
                    { type: "text", text: "last tool text" },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ),
  );
  await expect.poll(() => requested.includes("/api/chats/1/images/5/0/1")).toBe(true);
  await page.getByRole("button", { name: "1 tool call" }).click();
  const tool = page.getByRole("button", { name: /Used tool: read/ });
  await expect(page.getByText("first tool text")).toBeHidden();
  await expect(page.locator('img[src="/api/chats/1/images/6/0/1"]')).toBeHidden();
  await tool.click();
  await expect.poll(() => requested.includes("/api/chats/1/images/6/0/1")).toBe(true);
  const first = page.getByText("first tool text"),
    last = page.getByText("last tool text");
  await expect(first).toBeVisible();
  await expect(last).toBeVisible();
  await expect(first).toHaveCount(1);
  expect(
    await first.evaluate(
      (e) =>
        e.compareDocumentPosition(document.querySelector('img[src="/api/chats/1/images/6/0/1"]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBeTruthy();
  await tool.click();
  await expect(first).toBeHidden();
  await expect(page.locator('img[src="/api/chats/1/images/6/0/1"]')).toBeHidden();
});

test("navigation keeps attachment drafts isolated without resubmitting", async ({ page }) => {
  let sends = 0;
  await prepare(page, async (route) => {
    sends++;
    return route.fulfill({ status: 202, json: { id: "1" } });
  });
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false },
          { id: "2", title: "Second chat", running: false },
        ],
      },
    }),
  );
  await page.reload();
  await attach(page);
  await page.getByRole("button", { name: "Second chat" }).click();
  await expect(page.getByRole("button", { name: "Remove one.png" })).toHaveCount(0);
  await page.getByRole("button", { name: "Original chat" }).click();
  await expect(page.getByRole("button", { name: "Remove one.png" })).toBeVisible();
  expect(sends).toBe(0);
});

test("archived chat shows saved images without upload or send controls", async ({ page }) => {
  await prepare(page, async (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Archived chat", running: false, status: "archived" },
          { id: "2", title: "Active chat", running: false },
        ],
      },
    }),
  );
  await page.goto("/chats/1");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("attachment-test-state", {
        detail: {
          conversationId: 1,
          partial: "",
          busy: false,
          hasEarlier: false,
          failure: null,
          messages: [
            {
              id: "5:0",
              role: "user",
              text: "",
              interrupted: false,
              parts: [
                { id: "5:0:0", type: "image", source: { entryId: 5, modelIndex: 0, partIndex: 0 } },
              ],
            },
          ],
        },
      }),
    ),
  );
  await expect(page.locator('img[src="/api/chats/1/images/5/0/0"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Attachment" })).toHaveCount(0);
});

test("delayed native attachment completion does not restore refs after a newer draft was cleared", async ({
  page,
}) => {
  await prepare(page, async (route) => route.abort());
  await page.evaluate(async () => {
    const path = "/tests/attachment-race-harness.tsx";
    await import(/* @vite-ignore */ path);
  });
  const scope = page.locator("#controlled-native-composer");
  await expect(scope.getByRole("textbox", { name: "Message input" })).toBeVisible();
  async function add(name: string) {
    const chooser = page.waitForEvent("filechooser");
    await scope.getByRole("button", { name: "Add Attachment" }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: png });
    await expect(scope.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  }
  await add("first.png");
  await add("second.png");
  const text = scope.getByRole("textbox", { name: "Message input" });
  await text.fill("submitted text");
  await scope.getByRole("button", { name: "Send message" }).click();
  await text.fill("newer text");
  await text.fill("");
  await add("new.png");
  await scope.getByRole("button", { name: "Remove new.png" }).click();
  await page.evaluate(() => (Reflect.get(window, "__releaseAttachmentSend") as () => void)());
  await expect
    .poll(async () => page.evaluate(() => Reflect.get(window, "__raceSent") as unknown))
    .toEqual([ids[0], ids[1]]);
  await expect(text).toHaveValue("");
  await expect(scope.getByRole("button", { name: /Remove (first|second|new)\.png/ })).toHaveCount(
    0,
  );
});
