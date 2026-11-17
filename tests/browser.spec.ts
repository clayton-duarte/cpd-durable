import { test, expect } from "@playwright/test";

test("sends, streams, restores on refresh and shows a provider failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CPD Durable" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Ready");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByText("Hello from the test provider", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Ready");
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
  await expect(page.getByRole("status")).toHaveText("Ready");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Slow response");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("A streamed partial", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Responding…");
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.getByRole("status")).toHaveText("Ready");
  await expect(page.getByRole("alert")).toContainText("Response stopped.");
  await expect(page.getByText("Response interrupted.", { exact: true })).toBeVisible();
});
