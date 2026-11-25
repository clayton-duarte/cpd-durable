import type { Page } from "@playwright/test";

export async function openChatSetting(page: Page, name: string) {
  const item = page.getByRole("button", { name, exact: true });
  if (!(await item.isVisible()))
    await page.getByRole("button", { name: "Chat settings", exact: true }).first().click();
  await item.click();
}
