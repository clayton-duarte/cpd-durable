import { openChatSetting } from "./fixtures/chat-settings.ts";
import { expect, test } from "@playwright/test";

test("settings save, conflict reload and unavailable catalog retain the user's draft", async ({
  page,
}) => {
  let revision = 0;
  let assignments = { main: null, tangent: null, worker: null } as Record<string, unknown>;
  let available = true;
  let conflict = false;
  const choices = [
    { provider: "example", modelId: "one", name: "One", thinkingLevels: ["off"] },
    { provider: "example", modelId: "two", name: "Two", thinkingLevels: ["off"] },
  ];
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [{ id: "1", slug: "1", title: "Chat", running: false, status: "regular" }],
      },
    }),
  );
  await page.route("**/api/model-policy", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { revision, assignments, choices: available ? choices : [] } });
    if (conflict) {
      conflict = false;
      revision++;
      return route.fulfill({ status: 409, json: { error: "Changed" } });
    }
    const body = route.request().postDataJSON() as {
      expected: { revision: number };
      assignments: Record<string, unknown>;
    };
    expect(body.expected.revision).toBe(revision);
    assignments = body.assignments;
    revision++;
    return route.fulfill({ json: { revision, assignments } });
  });
  await page.goto("/chats/1");
  await openChatSetting(page, "Model defaults");
  await expect(page.getByText("Host default until configured.")).toBeVisible();
  for (const role of ["Main", "Tangent", "Worker"]) {
    await page.getByRole("combobox", { name: `${role} model` }).click();
    await page
      .getByRole("option", { name: /example\/one/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Confirm thinking off" }).click();
  }
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect(page.getByText(/Saved for new threads/)).toBeVisible();
  await page.getByRole("combobox", { name: "Worker model" }).click();
  await page
    .getByRole("option", { name: /example\/two/ })
    .last()
    .click();
  conflict = true;
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect(page.getByRole("alert")).toContainText("Save unconfirmed");
  available = false;
  await page.getByRole("button", { name: "Reload saved settings" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("example/two · thinking off")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Worker model" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save model tiers" })).toBeDisabled();
  available = true;
  await page.getByRole("button", { name: "Refresh saved settings" }).click();
  await expect(page.getByRole("button", { name: "Save model tiers" })).toBeEnabled();
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect.poll(() => revision).toBe(3);
});

test("late save acknowledgements preserve newer edits and are ignored after closing settings", async ({
  page,
}) => {
  const choices = [
    { provider: "example", modelId: "one", name: "One", thinkingLevels: ["off"] },
    { provider: "example", modelId: "two", name: "Two", thinkingLevels: ["off"] },
  ];
  let revision = 0;
  let assignments: Record<string, unknown> = { main: null, tangent: null, worker: null };
  let release: (() => void) | undefined;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [{ id: "1", slug: "1", title: "Chat", running: false, status: "regular" }],
      },
    }),
  );
  await page.route("**/api/model-policy", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { revision, assignments, choices } });
    const body = route.request().postDataJSON() as { assignments: Record<string, unknown> };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    assignments = body.assignments;
    revision++;
    await route.fulfill({ json: { revision, assignments } }).catch(() => {});
  });
  await page.goto("/chats/1");
  await openChatSetting(page, "Model defaults");
  await page.getByRole("combobox", { name: "Main model" }).click();
  await page
    .getByRole("option", { name: /example\/one/ })
    .last()
    .click();
  await page.getByRole("button", { name: "Confirm thinking off" }).click();
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("combobox", { name: "Main model" }).click();
  await page
    .getByRole("option", { name: /example\/two/ })
    .last()
    .click();
  release!();
  await expect(page.getByText("example/two · thinking off")).toBeVisible();
  await expect(page.getByText(/Saved for new threads/)).toBeVisible();
  release = undefined;
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  release!();
  await openChatSetting(page, "Model defaults");
  await expect(page.getByText("example/two · thinking off")).toBeVisible();
});
