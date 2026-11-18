import { expect, test } from "@playwright/test";

test("immediate open tangents remain selectable, including running", async ({ page }) => {
  await page.goto("/tests/tangent-fixture/");
  const main = page.getByTestId("main");
  const cards = main.locator('[data-slot="task-card"]');
  await expect(cards).toHaveCount(4);
  for (const name of ["Running", "Idle", "Waiting", "Failed"]) {
    await expect(main.getByRole("button", { name: `Open tangent: ${name} task` })).toBeEnabled();
  }
  const running = cards.filter({ hasText: "Running task" });
  await expect(running.getByRole("button")).toHaveAttribute(
    "aria-description",
    "Model Alpha · Open · Running · Needs input",
  );
  await expect(main).not.toContainText("Other task");
  await expect(main).not.toContainText("Concluded task");
  await expect(main.locator('[data-slot="task-card-transcript"]')).toHaveCount(0);
  await expect(main.locator("button button")).toHaveCount(0);
  await expect(running.locator(":scope > button")).toBeEnabled();
  await expect(
    cards.filter({ hasText: "Idle task" }).getByRole("button", { name: "Open tangent: Idle task" }),
  ).toBeEnabled();
  await main.getByRole("button", { name: "Open tangent: Running task" }).click();
  await expect(page.getByTestId("selected")).toHaveText("running");
  await expect(
    main.getByRole("button", { name: "Selected tangent: Running task" }),
  ).toHaveAttribute("aria-pressed", "true");
  await main.getByRole("button", { name: "Open tangent: Failed task" }).click();
  await expect(page.getByTestId("selected")).toHaveText("failed");
  await expect(main.getByRole("button", { name: "Open tangent: Running task" })).toBeEnabled();
});

test("workers are scoped by immediate parent and empty strips are omitted", async ({ page }) => {
  await page.goto("/tests/tangent-fixture/");
  const main = page.getByTestId("main");
  const tangent = page.getByTestId("tangent");
  const mainWorkers = main.locator('[data-slot="agent-status"]');
  await expect(mainWorkers).toHaveCount(2);
  await expect(mainWorkers.nth(0)).toContainText("Worker two · Model Two · Open · Failed");
  await expect(mainWorkers.nth(1)).toContainText(
    "Worker one · Model One · Open · Idle · Needs input",
  );
  await expect(tangent).toContainText(
    "Tangent worker · Model Three · Open · Running · Needs input",
  );
  await expect(main).not.toContainText("Tangent worker");
  await expect(tangent).not.toContainText("Worker one");
  await expect(page.locator('[data-slot="agent-status-trailing"] svg')).toHaveCount(0);
  await expect(page.getByTestId("empty")).toBeEmpty();
});
