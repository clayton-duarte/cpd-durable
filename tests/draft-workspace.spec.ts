import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));

async function syntheticEvents(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
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

for (const delayed of [false, true]) {
  test(`navigation preserves a ${delayed ? "pending" : "debounced"} draft save`, async ({
    page,
  }) => {
    await syntheticEvents(page);
    const image = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "saved.png",
      mimeType: "image/png",
      size: png.length,
    };
    let draft = { revision: 1, content: { text: "old", images: [image] } };
    let puts = 0;
    let uploads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === "/api/chats")
        return route.fulfill({
          json: {
            rootId: "1",
            chats: [
              { id: "1", title: "First", running: false },
              { id: "2", title: "Second", running: false },
            ],
          },
        });
      if (path.endsWith("/draft/attempts"))
        return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
      if (path === "/api/chats/2/draft")
        return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
      if (path === "/api/chats/1/draft" && method === "GET") return route.fulfill({ json: draft });
      if (path === "/api/chats/1/draft" && method === "PUT") {
        const body = route.request().postDataJSON() as {
          expectedRevision: number;
          content: typeof draft.content;
        };
        puts++;
        if (delayed && puts === 1) await gate;
        if (body.expectedRevision !== draft.revision)
          return route.fulfill({ status: 409, json: {} });
        draft = { revision: draft.revision + 1, content: body.content };
        return route.fulfill({ json: draft });
      }
      if (path.endsWith("/attachments") && method === "POST") {
        uploads++;
        return route.abort();
      }
      if (path.includes("/attachments/"))
        return route.fulfill({ body: png, contentType: "image/png" });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/chats/1");
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toHaveValue("old");
    await input.fill("new draft");
    if (delayed) await expect.poll(() => puts).toBe(1);
    await page.getByRole("button", { name: "Second", exact: true }).click();
    if (delayed) release();
    await expect.poll(() => draft.content.text).toBe("new draft");
    expect(draft.content.images).toEqual([image]);
    expect(uploads).toBe(0);
    await page.reload();
    await expect(page).toHaveURL(/\/chats\/2$/);
    await page.goto("/chats/1");
    await expect(input).toHaveValue("new draft");
    await expect(page.getByText("saved.png").first()).toBeVisible();
    expect(uploads).toBe(0);
  });
}

test("recovery retry clears only the unchanged original and adopts the confirmed revision", async ({
  page,
}) => {
  await syntheticEvents(page);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const record = {
    requestId,
    draftRevision: 1,
    text: "original",
    images: [],
    mode: "reject",
    fingerprint: "a".repeat(64),
  };
  let draft = { revision: 1, content: { text: "original", images: [] as never[] } };
  const writes: number[] = [];
  let inputCalls = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "First", running: false }],
        },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({
        json: {
          attempts: [{ record, admission: "unknown" }],
          capped: false,
          nextCursor: null,
        },
      });
    if (path.endsWith("/draft") && route.request().method() === "GET")
      return route.fulfill({ json: draft });
    if (path.endsWith("/draft") && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      writes.push(body.expectedRevision);
      if (body.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: body.content };
      return route.fulfill({ json: draft });
    }
    if (path.endsWith("/input")) {
      inputCalls++;
      expect(route.request().postDataJSON()).toMatchObject({
        requestId,
        text: "original",
        draft: { revision: 1, text: "original" },
      });
      draft = { revision: 2, content: { text: "", images: [] } };
      return route.fulfill({ status: 202, json: { id: "1", clearedDraftRevision: 2 } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("original");
  await expect(page.getByText(/Delivery unconfirmed/)).toBeVisible();
  expect(inputCalls).toBe(0);
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect(input).toHaveValue("");
  await input.fill("next");
  await expect.poll(() => draft.content.text).toBe("next");
  expect(writes).toEqual([2]);
  await expect(page.getByText("Draft changed in another session.")).toHaveCount(0);
});

test("recovery acknowledgement cannot clear a draft after a new upload starts", async ({
  page,
}) => {
  await syntheticEvents(page);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  const record = {
    requestId,
    draftRevision: 1,
    text: "original",
    images: [],
    mode: "reject",
    fingerprint: "a".repeat(64),
  };
  let draft: {
    revision: number;
    content: {
      text: string;
      images: { id: string; name: string; mimeType: string; size: number }[];
    };
  } = {
    revision: 1,
    content: { text: "original", images: [] },
  };
  let releaseInput!: () => void;
  let releaseUpload!: () => void;
  let uploadStarted = false;
  let inputStarted = false;
  const inputGate = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "First", running: false }],
        },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({
        json: {
          attempts: [{ record, admission: "unknown" }],
          capped: false,
          nextCursor: null,
        },
      });
    if (path.endsWith("/draft") && method === "GET") return route.fulfill({ json: draft });
    if (path.endsWith("/draft") && method === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      if (body.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: body.content };
      return route.fulfill({ json: draft });
    }
    if (path.endsWith("/input")) {
      inputStarted = true;
      await inputGate;
      draft = { revision: 2, content: { text: "", images: [] } };
      return route.fulfill({ status: 202, json: { id: "1", clearedDraftRevision: 2 } });
    }
    if (path.endsWith("/attachments") && method === "POST") {
      uploadStarted = true;
      await uploadGate;
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
    if (path.includes("/attachments/"))
      return route.fulfill({ body: png, contentType: "image/png" });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("original");
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect.poll(() => inputStarted).toBe(true);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooserPromise).setFiles({ name: "new.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => uploadStarted).toBe(true);
  releaseInput();
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(input).toHaveValue("original");
  releaseUpload();
  await expect.poll(() => draft.content.images.some((image) => image.id === newId)).toBe(true);
  expect(draft.content.text).toBe("original");
});

test("retry saving persists the latest text and retained image after a network failure", async ({
  page,
}) => {
  await syntheticEvents(page);
  const image = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "saved.png",
    mimeType: "image/png",
    size: png.length,
  };
  let draft = { revision: 1, content: { text: "old", images: [image] } };
  let attempts = 0;
  let uploads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "First", running: false }] },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
    if (path.endsWith("/draft") && method === "GET") return route.fulfill({ json: draft });
    if (path.endsWith("/draft") && method === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      attempts++;
      if (attempts === 1) return route.abort();
      if (body.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: body.content };
      return route.fulfill({ json: draft });
    }
    if (path.endsWith("/attachments") && method === "POST") {
      uploads++;
      return route.abort();
    }
    if (path.includes("/attachments/"))
      return route.fulfill({ body: png, contentType: "image/png" });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("old");
  await input.fill("saved after retry");
  await expect(page.getByRole("button", { name: "Retry saving draft" })).toBeVisible();
  await page.getByRole("button", { name: "Retry saving draft" }).click();
  await expect.poll(() => draft.content.text).toBe("saved after retry");
  await page.reload();
  await expect(input).toHaveValue("saved after retry");
  await expect(page.getByText("saved.png").first()).toBeVisible();
  expect(draft.content.images).toEqual([image]);
  expect(uploads).toBe(0);
});

test("recovery identifies each unknown attempt and displays admitted receipts without retry", async ({
  page,
}) => {
  await syntheticEvents(page);
  const records = ["first payload", "second payload", "admitted payload"].map((text, i) => ({
    requestId: `${i + 1}`.repeat(8) + "-1111-4111-8111-111111111111",
    draftRevision: i + 1,
    text,
    images: i === 1 ? ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] : [],
    mode: "reject",
    fingerprint: "a".repeat(64),
  }));
  let inputs = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [{ id: "1", title: "First", running: false }],
        },
      });
    if (path.endsWith("/draft"))
      return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({
        json: {
          attempts: [
            { record: records[0], admission: "unknown" },
            { record: records[1], admission: "unknown" },
            { record: records[2], admission: "admitted", submissionId: "7" },
          ],
          capped: true,
          nextCursor: records[2]!.requestId,
        },
      });
    if (path.endsWith("/input")) inputs++;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  await expect(page.getByText("first payload")).toBeVisible();
  await expect(page.getByText("second payload")).toBeVisible();
  await expect(page.getByText(/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/)).toBeVisible();
  await expect(page.getByText("admitted payload")).toBeVisible();
  await expect(page.getByText("Submission 7")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry original" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Load older attempts" })).toBeVisible();
  expect(inputs).toBe(0);
});

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
