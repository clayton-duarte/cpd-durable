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

for (const scenario of ["debounced", "inflight", "failure", "conflict"] as const) {
  test(`archive ${scenario === "failure" || scenario === "conflict" ? `is blocked on ${scenario}` : `waits for the ${scenario} draft`}`, async ({
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
    let archived = false;
    let puts = 0;
    let archives = 0;
    const operations: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalog = () => ({
      rootId: "1",
      chats: [
        { id: "1", title: "First", running: false, status: archived ? "archived" : "regular" },
        { id: "2", title: "Second", running: false, status: "regular" },
      ],
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === "/api/chats") return route.fulfill({ json: catalog() });
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
        operations.push("put");
        if (scenario === "inflight") await gate;
        if (scenario === "failure") return route.fulfill({ status: 503, json: {} });
        if (scenario === "conflict") {
          draft = { revision: 2, content: { text: "other tab", images: [image] } };
          return route.fulfill({ status: 409, json: {} });
        }
        if (body.expectedRevision !== draft.revision)
          return route.fulfill({ status: 409, json: {} });
        draft = { revision: draft.revision + 1, content: body.content };
        operations.push("saved");
        return route.fulfill({ json: draft });
      }
      if (path === "/api/chats/1/manage") {
        archives++;
        operations.push("archive");
        archived = true;
        return route.fulfill({ json: catalog() });
      }
      if (path.includes("/attachments/"))
        return route.fulfill({ body: png, contentType: "image/png" });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/chats/1");
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toHaveValue("old");
    await input.fill("save before archive");
    if (scenario === "inflight") await expect.poll(() => puts).toBe(1);
    if (scenario !== "failure" && scenario !== "conflict")
      await page.getByRole("button", { name: "Second", exact: true }).click();
    const row = page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: "First" });
    await row.getByRole("button", { name: "More options" }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    if (scenario === "inflight") {
      expect(archives).toBe(0);
      release();
    }
    if (scenario === "failure" || scenario === "conflict") {
      await expect(page.getByText(/Draft could not be saved before archiving/)).toBeVisible();
      expect(archives).toBe(0);
      await expect(input).toHaveValue("save before archive");
    } else {
      await expect.poll(() => archives).toBe(1);
      expect(operations.indexOf("saved")).toBeLessThan(operations.indexOf("archive"));
      expect(draft.content.images).toEqual([image]);
      await page.goto("/chats/1");
      await expect(input).toHaveValue("save before archive");
      await expect(input).toBeDisabled();
      await expect(page.getByText("saved.png").first()).toBeVisible();
    }
  });
}

test("an external archive reports unconfirmed local draft changes", async ({ page }) => {
  await syntheticEvents(page);
  let archived = false;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [
            { id: "1", title: "First", running: false, status: archived ? "archived" : "regular" },
          ],
        },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({
        json: {
          attempts: [],
          capped: false,
          nextCursor: null,
        },
      });
    if (path.endsWith("/draft") && route.request().method() === "GET")
      return route.fulfill({
        json: { revision: 0, content: { text: "", images: [] } },
      });
    if (path.endsWith("/draft") && route.request().method() === "PUT") {
      entered = true;
      await gate;
      return route.fulfill({ status: 409, json: {} }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  await page.getByRole("textbox", { name: "Message input" }).fill("unsaved");
  await expect.poll(() => entered).toBe(true);
  archived = true;
  await expect(page.getByText(/archived elsewhere with unsaved draft changes/)).toBeVisible();
  release();
});

for (const succeeds of [true, false]) {
  test(`external archive warns about an upload-only draft even after late upload ${succeeds ? "success" : "failure"}`, async ({
    page,
  }) => {
    await syntheticEvents(page);
    let archived = false;
    let uploads = 0;
    const writes: string[] = [];
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
              {
                id: "1",
                title: "First",
                running: false,
                status: archived ? "archived" : "regular",
              },
              { id: "2", title: "Second", running: false },
            ],
          },
        });
      if (path.endsWith("/draft/attempts"))
        return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
      if (path.endsWith("/draft") && method === "GET")
        return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
      if (path.endsWith("/draft") && method === "PUT") {
        writes.push(path);
        return route.fulfill({ status: 409, json: {} });
      }
      if (path === "/api/chats/1/attachments" && method === "POST") {
        uploads++;
        await gate;
        if (!succeeds) return route.fulfill({ status: 503, json: {} }).catch(() => {});
        return route
          .fulfill({
            status: 201,
            json: {
              id: "11111111-1111-4111-8111-111111111111",
              mimeType: "image/png",
              size: png.length,
              prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
            },
          })
          .catch(() => {});
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/chats/1");
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toHaveValue("");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add Attachment" }).click();
    await (await chooser).setFiles({ name: "new.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => uploads).toBe(1);
    archived = true;
    const warning = page.getByText(/archived elsewhere with unsaved draft changes/);
    await expect(warning).toBeVisible();
    release();
    if (succeeds) await expect(page.getByText("new.png").first()).toBeVisible();
    else await expect(page.getByText(/Image upload failed/).first()).toBeVisible();
    await expect(warning).toBeVisible();
    expect(writes).toEqual([]);
    expect(uploads).toBe(1);
  });
}

test("archive is blocked while an attachment upload is pending", async ({ page }) => {
  await syntheticEvents(page);
  let uploadStarted = false;
  let archives = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "First", running: false }] },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
    if (path.endsWith("/draft"))
      return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
    if (path.endsWith("/attachments") && route.request().method() === "POST") {
      uploadStarted = true;
      await gate;
      return route.fulfill({
        status: 201,
        json: {
          id: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    }
    if (path.endsWith("/manage")) archives++;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooserPromise).setFiles({ name: "new.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => uploadStarted).toBe(true);
  const row = page.locator('[data-slot="aui_thread-list-item"]').filter({ hasText: "First" });
  await row.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(page.getByText(/Draft could not be saved before archiving/)).toBeVisible();
  expect(archives).toBe(0);
  release();
});

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
  await page.waitForTimeout(400);
  expect(writes).toEqual([]);
  await input.fill("next");
  await expect.poll(() => draft.content.text).toBe("next");
  expect(writes).toEqual([2]);
  await expect(page.getByText("Draft changed in another session.")).toHaveCount(0);
});

test("retry without a clear receipt retains an equal-content newer revision and image", async ({
  page,
}) => {
  await syntheticEvents(page);
  const image = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "saved.png",
    mimeType: "image/png",
    size: png.length,
  };
  const record = {
    requestId: "22222222-2222-4222-8222-222222222222",
    draftRevision: 1,
    text: "same",
    images: [image.id],
    mode: "reject",
    fingerprint: "a".repeat(64),
  };
  // Revision 3 represents edit-away/back or remove/re-add of the same reference.
  let draft = { revision: 3, content: { text: "same", images: [image] } };
  const expected: number[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "First", running: false }] },
      });
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({
        json: { attempts: [{ record, admission: "unknown" }], capped: false, nextCursor: null },
      });
    if (path.endsWith("/draft") && method === "GET") return route.fulfill({ json: draft });
    if (path.endsWith("/draft") && method === "PUT") {
      const body = route.request().postDataJSON() as {
        expectedRevision: number;
        content: typeof draft.content;
      };
      expected.push(body.expectedRevision);
      if (body.expectedRevision !== draft.revision) return route.fulfill({ status: 409, json: {} });
      draft = { revision: draft.revision + 1, content: body.content };
      return route.fulfill({ json: draft });
    }
    if (path.includes("/attachments/"))
      return route.fulfill({ body: png, contentType: "image/png" });
    if (path.endsWith("/input")) return route.fulfill({ status: 202, json: { id: "1" } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await expect(input).toHaveValue("same");
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(input).toHaveValue("same");
  await expect(page.getByText("saved.png").first()).toBeVisible();
  await input.fill("subsequent edit");
  await expect.poll(() => draft.content.text).toBe("subsequent edit");
  expect(expected).toEqual([3]);
  expect(draft.content.images).toEqual([image]);
});

for (const { uploadFirst, fails } of [
  { uploadFirst: false, fails: false },
  { uploadFirst: true, fails: false },
  { uploadFirst: true, fails: true },
]) {
  test(`recovery preserves draft when upload starts ${uploadFirst ? "before" : "after"} retry and ${fails ? "fails" : "succeeds"}`, async ({
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
    let inputCalls = 0;
    let uploadCalls = 0;
    const writes: number[] = [];
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
        writes.push(body.expectedRevision);
        if (body.expectedRevision !== draft.revision)
          return route.fulfill({ status: 409, json: {} });
        draft = { revision: draft.revision + 1, content: body.content };
        return route.fulfill({ json: draft });
      }
      if (path.endsWith("/input")) {
        inputStarted = true;
        inputCalls++;
        await inputGate;
        draft = { revision: 2, content: { text: "", images: [] } };
        return route.fulfill({ status: 202, json: { id: "1", clearedDraftRevision: 2 } });
      }
      if (path.endsWith("/attachments") && method === "POST") {
        uploadStarted = true;
        uploadCalls++;
        await uploadGate;
        if (fails) return route.fulfill({ status: 503, json: {} });
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
    if (!uploadFirst) {
      await page.getByRole("button", { name: "Retry original" }).click();
      await expect.poll(() => inputStarted).toBe(true);
    }
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add Attachment" }).click();
    await (await chooserPromise).setFiles({ name: "new.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => uploadStarted).toBe(true);
    if (uploadFirst) {
      await page.getByRole("button", { name: "Retry original" }).click();
      await expect.poll(() => inputStarted).toBe(true);
    }
    releaseInput();
    await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
    await expect(input).toHaveValue("original");
    releaseUpload();
    if (fails) {
      await expect(page.getByText(/Image upload failed/).first()).toBeVisible();
      await expect.poll(() => draft.content.text).toBe("original");
      expect(draft.content.images).toEqual([]);
      expect(writes).toEqual([2]);
      await page.reload();
      await expect(input).toHaveValue("original");
    } else {
      await expect.poll(() => draft.content.images.some((image) => image.id === newId)).toBe(true);
    }
    expect(draft.content.text).toBe("original");
    expect(writes[0]).toBe(2);
    expect(inputCalls).toBe(1);
    expect(uploadCalls).toBe(1);
  });
}

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
  const fullText = `second payload ${"x".repeat(200)}`;
  const records = ["first payload", fullText, "admitted payload"].map((text, i) => ({
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
  await expect(page.getByText(/second payload/).first()).toBeVisible();
  await page.getByText("View full original text").click();
  await expect(page.getByText(fullText, { exact: true })).toBeVisible();
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

test("production tangent command recovery retries the original immutable intent", async ({
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
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: 1,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: null,
          },
          choices: [],
        },
      });
    if (path === "/api/chats/1/tangents") return route.fulfill({ json: { tangents: [] } });
    if (path === "/api/chats/1/workers")
      return route.fulfill({ json: { helpers: [], hasUnsettled: false } });
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
  await input.fill("/tangent original");
  await expect.poll(() => draft.content.text).toBe("/tangent original");
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(8, 8));
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await page.getByRole("option", { name: /\/tangent/ }).click();
  await expect.poll(() => inputs.length).toBe(1);
  expect(intent?.["requestId"]).toBe(inputs[0]?.["requestId"]);
  expect(intent?.["intent"]).toEqual({
    kind: "tangent-handoff-request",
    version: 1,
    command: "tangent",
  });
  expect(inputs[0]).toMatchObject({
    text: expect.stringContaining("Goal:\noriginal"),
    images: [oldId],
    draft: {
      revision: intent?.["draftRevision"],
      text: "/tangent original",
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
  await expect(page.getByRole("button", { name: /Open tangent:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]).toEqual(inputs[0]);
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(input).toHaveValue("newer");
});

test("production side mouse selection retries the original immutable intent", async ({ page }) => {
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
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: 1,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: null,
          },
          choices: [],
        },
      });
    if (path === "/api/chats/1/tangents") return route.fulfill({ json: { tangents: [] } });
    if (path === "/api/chats/1/workers")
      return route.fulfill({ json: { helpers: [], hasUnsettled: false } });
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
  await input.fill("/side original");
  await expect.poll(() => draft.content.text).toBe("/side original");
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 5));
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await page.getByRole("option", { name: /\/side/ }).click();
  await expect.poll(() => inputs.length).toBe(1);
  expect(intent?.["requestId"]).toBe(inputs[0]?.["requestId"]);
  expect(intent?.["intent"]).toEqual({
    kind: "tangent-handoff-request",
    version: 1,
    command: "side",
  });
  expect(inputs[0]).toMatchObject({
    text: expect.stringContaining("Goal:\noriginal"),
    images: [oldId],
    draft: {
      revision: intent?.["draftRevision"],
      text: "/side original",
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
  await expect(page.getByRole("button", { name: /Open tangent:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry original" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1]).toEqual(inputs[0]);
  await expect(page.getByText(/Delivery unconfirmed/)).toHaveCount(0);
  await expect(input).toHaveValue("newer");
});

test("production side keyboard selection retries the original immutable intent", async ({
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
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: 1,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: null,
          },
          choices: [],
        },
      });
    if (path === "/api/chats/1/tangents") return route.fulfill({ json: { tangents: [] } });
    if (path === "/api/chats/1/workers")
      return route.fulfill({ json: { helpers: [], hasUnsettled: false } });
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
  await input.fill("/side original");
  await expect.poll(() => draft.content.text).toBe("/side original");
  await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 5));
  await input.press("ArrowLeft");
  await input.press("ArrowRight");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect.poll(() => inputs.length).toBe(1);
  expect(intent?.["requestId"]).toBe(inputs[0]?.["requestId"]);
  expect(intent?.["intent"]).toEqual({
    kind: "tangent-handoff-request",
    version: 1,
    command: "side",
  });
  expect(inputs[0]).toMatchObject({
    text: expect.stringContaining("Goal:\noriginal"),
    images: [oldId],
    draft: {
      revision: intent?.["draftRevision"],
      text: "/side original",
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
  await expect(page.getByRole("button", { name: /Open tangent:/ })).toHaveCount(0);
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
