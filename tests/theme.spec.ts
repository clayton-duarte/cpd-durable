import { test, expect } from "@playwright/test";

test("defaults to dark on first load and reload regardless of system preference", async ({
  page,
}) => {
  // Theme verification needs no model request or saved conversation.
  await page.route("**/api/events", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: state\ndata: {"messages":[],"partial":"","busy":false,"hasEarlier":false,"failure":null}\n\n',
    });
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass("dark");
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "dark");
    await expect(page.getByRole("heading", { name: "CPD Durable" })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveClass("dark");
  }
});
