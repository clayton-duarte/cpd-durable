import { test, expect } from "@playwright/test";

test("sends, streams, restores on refresh and shows a provider failure", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("CPD Durable");
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  const input = page.getByRole("textbox", { name: "Message input", exact: true });
  await input.fill("Hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("Hello from the test provider", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Hello from the test provider", { exact: true })).toBeVisible();
  await input.fill("Fail next");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Response did not complete");
  await expect(page.getByRole("alert")).not.toContainText("PRIVATE_PROVIDER_DIAGNOSTIC");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test("shows partial output and explicitly stops a running response", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message input", exact: true }).fill("Slow response");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("A streamed partial", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toContainText("Working…");
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Response stopped.");
  await expect(page.getByText("Response interrupted.", { exact: true })).toBeVisible();
});

test("acknowledging a send preserves edits made while delivery is pending", async ({ page }) => {
  let acknowledge = () => {};
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  await page.route("**/api/input", async (route) => {
    const response = await route.fetch();
    await acknowledgement;
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Message input", exact: true });
  await input.fill("Delayed acknowledgement");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await input.fill("This draft has not been submitted");
  const delivered = page.waitForResponse("**/api/input");
  acknowledge();
  await delivered;
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(input).toHaveValue("This draft has not been submitted");
});

test("user transcript preserves line breaks and indentation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-slot="agent-status"][role="status"]')).toHaveCount(0);
  const text = "Indented example:\n    const value = 1;\n    return  value;";
  await page.getByRole("textbox", { name: "Message input", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const content = page
    .locator(".aui-user-message-content .whitespace-pre-wrap")
    .filter({ hasText: "Indented example:" });
  await expect(content).toHaveText(text, { useInnerText: true });
  await expect(content).toHaveCSS("white-space", "pre-wrap");
  expect(await content.innerText()).toBe(text);
});
