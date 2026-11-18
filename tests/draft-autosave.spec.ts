import { expect, test } from "@playwright/test";

test("serializes edits and never persists the native-send transient empty composer", async ({
  page,
}) => {
  let saved = { revision: 0, content: { text: "", images: [] as never[] } };
  const writes: (typeof saved)[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chats/1/draft", async (route) => {
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      content: typeof saved.content;
    };
    if (!writes.length) await gate;
    expect(body.expectedRevision).toBe(saved.revision);
    saved = { revision: saved.revision + 1, content: body.content };
    writes.push(saved);
    await route.fulfill({ json: saved });
  });
  await page.goto("/tests/fixtures/draft-autosave/");
  const input = page.getByRole("textbox", { name: "Draft" });
  await input.fill("first");
  await page.waitForTimeout(350);
  await input.fill("newer");
  release();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map((write) => write.content.text)).toEqual(["first", "newer"]);
  await page.getByRole("button", { name: "Begin send" }).click();
  await page.getByRole("button", { name: "Detach" }).click();
  await page.getByRole("button", { name: "End send" }).click();
  await page.waitForTimeout(400);
  expect(writes).toHaveLength(2);
  await input.fill("next draft");
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]?.content.text).toBe("next draft");
});

test("CAS conflict requires an explicit choice before writing against the current revision", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await page.route("**/api/chats/1/draft", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { revision: 4, content: { text: "remote", images: [] } } });
    const body = route.request().postDataJSON() as {
      expectedRevision: number;
      content: { text: string };
    };
    writes.push(body);
    if (body.expectedRevision === 0) return route.fulfill({ status: 409, json: {} });
    return route.fulfill({ json: { revision: 5, content: body.content } });
  });
  await page.goto("/tests/fixtures/draft-autosave/");
  await page.getByRole("textbox", { name: "Draft" }).fill("mine");
  await expect(page.getByRole("button", { name: "Keep mine" })).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.getByRole("button", { name: "Keep mine" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ expectedRevision: 4, content: { text: "mine", images: [] } });
});

test("persists restored image metadata without uploading it again", async ({ page }) => {
  const requests: string[] = [];
  let body: unknown;
  await page.route("**/api/**", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    body = route.request().postDataJSON();
    const input = body as { content: unknown };
    await route.fulfill({ json: { revision: 1, content: input.content } });
  });
  await page.goto("/tests/fixtures/draft-autosave/?image");
  await page.getByRole("textbox", { name: "Draft" }).fill("with image");
  await expect.poll(() => requests.length).toBe(1);
  expect(body).toEqual({
    expectedRevision: 0,
    content: {
      text: "with image",
      images: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "saved.png",
          mimeType: "image/png",
          size: 5,
        },
      ],
    },
  });
  expect(requests).toEqual(["PUT /api/chats/1/draft"]);
});

test("recovery lists unknown and admitted attempts without sending or retrying", async ({
  page,
}) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const record = {
    requestId: id,
    draftRevision: 1,
    text: "original",
    images: [],
    mode: "reject",
    fingerprint: "a".repeat(64),
  };
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({
      json: cursor
        ? {
            attempts: [
              { record: { ...record, requestId: other }, admission: "admitted", submissionId: "1" },
            ],
            capped: false,
            nextCursor: null,
          }
        : { attempts: [{ record, admission: "unknown" }], capped: true, nextCursor: id },
    });
  });
  await page.goto("/tests/fixtures/draft-autosave/?recovery");
  await expect(page.getByText(`unknown: ${id}`)).toBeVisible();
  await page.getByRole("button", { name: "Load older attempts" }).click();
  await expect(page.getByText(`admitted: ${other}`)).toBeVisible();
  expect(requests).toEqual(["GET /api/chats/1/draft/attempts", "GET /api/chats/1/draft/attempts"]);
});
