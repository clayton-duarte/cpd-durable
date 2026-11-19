import { expect, test } from "@playwright/test";

test("synthetic preview survives a deep-route reload without API network requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });
  await page.goto("/tests/ui-preview/");
  await expect(
    page.getByText("Investigate the synthetic architecture", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/1\?tangent=2/);
  await page.reload();
  await expect(
    page.getByText("Investigate the synthetic architecture", { exact: true }),
  ).toBeVisible();
  await page.goto("/tests/ui-preview/?scenario=stress");
  await expect(page.getByText("1 send not confirmed (loaded)")).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 send not confirmed (loaded)")).toBeVisible();
  expect(requests).toEqual([]);
});
