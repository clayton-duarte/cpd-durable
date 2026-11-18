import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
const id = "11111111-1111-4111-8111-111111111111";
const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const saved = {
  revision: 1,
  content: {
    text: "  saved draft  ",
    images: [{ id, name: "saved.png", mimeType: "image/png", size: png.length }],
  },
};
test("restores native text and original image without uploading or sending", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    if (route.request().url().endsWith("/draft")) return route.fulfill({ json: saved });
    return route.fulfill({ body: png, contentType: "image/png" });
  });
  await page.goto("/tests/fixtures/draft-restoration/");
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("  saved draft  ");
  await expect(page.getByTestId("attachment")).toContainText(id);
  await expect(page.getByRole("img", { name: "saved.png" })).toHaveAttribute(
    "src",
    `/api/chats/1/attachments/${id}`,
  );
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});
test("late read does not replace edits and stale chat responses are discarded", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/chats/1/draft")) {
      await gate;
      return route.fulfill({ json: saved }).catch(() => {});
    }
    if (route.request().url().includes("/draft"))
      return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
    return route.fulfill({ body: png, contentType: "image/png" });
  });
  await page.goto("/tests/fixtures/draft-restoration/");
  await page.getByRole("textbox", { name: "Draft" }).fill("new text");
  await page.getByRole("button", { name: "Add local" }).click();
  release();
  await expect(page.getByRole("button", { name: "Keep mine" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("new text");
  await expect(page.getByTestId("attachment")).toContainText(
    "22222222-2222-4222-8222-222222222222",
  );
  await page.getByRole("button", { name: "Use saved" }).click();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("  saved draft  ");
  await expect(page.getByTestId("attachment")).toContainText(id);
  await expect(page.getByRole("button", { name: "Use saved" })).toHaveCount(0);
  await page.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByRole("button", { name: "Keep mine" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("  saved draft  ");
});

test("readonly does not fetch or restore", async ({ page }) => {
  let count = 0;
  await page.route("**/api/**", async (route) => {
    count++;
    await route.fulfill({ json: saved });
  });
  await page.goto("/tests/fixtures/draft-restoration/?readonly");
  await expect(page.getByRole("textbox", { name: "Draft" })).toBeVisible();
  expect(count).toBe(0);
});

test("switching chats before a read completes discards the old response", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/chats/1/draft")) {
      await gate;
      return route.fulfill({ json: saved }).catch(() => {});
    }
    return route.fulfill({ json: { revision: 0, content: { text: "", images: [] } } });
  });
  await page.goto("/tests/fixtures/draft-restoration/");
  await page.getByRole("button", { name: "Switch" }).click();
  release();
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("");
  await expect(page.getByTestId("attachment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use saved" })).toHaveCount(0);
});
