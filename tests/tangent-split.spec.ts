import { expect, test, type Page } from "@playwright/test";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

async function attach(page: Page, chat: string, name: string) {
  const scope = page.getByTestId(`chat-${chat}`);
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: Buffer.from("fixture") });
  await expect(scope.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}
const calls = (page: Page) =>
  page.evaluate(() => Reflect.get(window, "__workspaceCalls") as string[]);

test("native chats preserve independent drafts and files across navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await syntheticDrafts(page);
  await page.goto("/tests/tangent-fixture/workspace.html");
  const main = page.getByTestId("chat-main");
  const a = page.getByTestId("chat-a");
  const b = page.getByTestId("chat-b");
  const mainInput = main.getByRole("textbox", { name: "Message input" });
  await mainInput.fill("main draft");
  await attach(page, "main", "main.png");
  const viewport = main.locator('[data-slot="aui_thread-viewport"]');
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  await viewport.evaluate((node) => {
    node.scrollTop = 100;
  });
  const scrollBefore = await viewport.evaluate((node) => node.scrollTop);
  await page.getByRole("button", { name: "Open tangent: Running tangent" }).click();
  await expect(main).toBeVisible();
  await expect(a).toBeVisible();
  await mainInput.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-stream")));
  await expect(mainInput).toBeFocused();
  await expect(page.getByRole("heading", { name: "Running tangent · Model Alpha" })).toBeVisible();
  await expect(
    page.getByText("Alpha worker · Worker A · Open · Waiting · Needs input"),
  ).toBeVisible();
  await expect(page.getByText("Main worker · Worker M · Open · Running")).toBeVisible();
  await a.getByRole("textbox", { name: "Message input" }).fill("alpha draft");
  await attach(page, "a", "alpha.png");
  await page.getByRole("button", { name: "Open tangent: Idle tangent" }).click();
  await expect(b).toBeVisible();
  await expect(a).toBeHidden();
  await b.getByRole("textbox", { name: "Message input" }).fill("beta draft");
  await attach(page, "b", "beta.png");
  await page.getByRole("button", { name: "Open tangent: Running tangent" }).click();
  await expect(a.getByRole("textbox", { name: "Message input" })).toHaveValue("alpha draft");
  await expect(a.getByRole("button", { name: "Remove alpha.png" })).toBeVisible();
  await page.getByRole("button", { name: "Close tangent" }).click();
  await expect(page.getByRole("button", { name: "Open tangent: Running tangent" })).toBeFocused();
  await expect(a).toBeHidden();
  await expect(mainInput).toHaveValue("main draft");
  expect(await viewport.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  await expect(main.getByRole("button", { name: "Remove main.png" })).toBeVisible();
  await page.getByRole("button", { name: "Open tangent: Idle tangent" }).click();
  await expect(b.getByRole("textbox", { name: "Message input" })).toHaveValue("beta draft");
  await expect(b.getByRole("button", { name: "Remove beta.png" })).toBeVisible();
  expect(await calls(page)).toEqual([]);
  await page.getByRole("button", { name: "Open tangent: Running tangent" }).click();
  await a.getByRole("button", { name: "Stop" }).click();
  expect(await calls(page)).toEqual(["stop:a"]);
});

test("mobile tabs switch visible context with keyboard without starting work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await syntheticDrafts(page);
  await page.goto("/tests/tangent-fixture/workspace.html");
  await page.getByRole("button", { name: "Open tangent: Running tangent" }).click();
  const mainTab = page.getByRole("tab", { name: "Main thread" });
  const tangentTab = page.getByRole("tab", { name: "Running tangent" });
  await expect(tangentTab).toHaveAttribute("aria-selected", "true");
  const controlledPanel = await tangentTab.getAttribute("aria-controls");
  expect(controlledPanel).toBeTruthy();
  await expect(page.locator(`[id="${controlledPanel}"]`)).toHaveAttribute("role", "tabpanel");
  await expect(page.getByTestId("chat-main")).toBeHidden();
  await expect(page.getByTestId("chat-a")).toBeVisible();
  await page
    .getByTestId("chat-a")
    .getByRole("textbox", { name: "Message input" })
    .fill("tangent draft");
  await tangentTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(mainTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-main")).toBeVisible();
  await expect(page.getByTestId("chat-a")).toBeHidden();
  await page
    .getByTestId("chat-main")
    .getByRole("textbox", { name: "Message input" })
    .fill("main draft");
  await mainTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tangentTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("chat-a").getByRole("textbox", { name: "Message input" }),
  ).toHaveValue("tangent draft");
  await tangentTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("chat-main").getByRole("textbox", { name: "Message input" }),
  ).toHaveValue("main draft");
  await expect(
    page.getByRole("button", { name: "Selected tangent: Running tangent" }),
  ).toBeVisible();
  expect(await calls(page)).toEqual([]);
});
