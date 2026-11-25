import { test, expect, type Page } from "@playwright/test";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

type Selection = { provider: string; modelId: string; thinkingLevel: string } | null;
const choices = [
  {
    provider: "alpha",
    modelId: "alpha-one",
    name: "Alpha One",
    thinkingLevels: ["off", "low", "high", "max"],
  },
  { provider: "alpha", modelId: "alpha-two", name: "Alpha Two", thinkingLevels: ["off", "low"] },
  { provider: "beta", modelId: "beta-one", name: "Beta One", thinkingLevels: ["off", "high"] },
];
const initial = {
  main: { provider: "alpha", modelId: "alpha-one", thinkingLevel: "low" },
  tangent: { provider: "beta", modelId: "beta-one", thinkingLevel: "default" },
  worker: { provider: "alpha", modelId: "alpha-two", thinkingLevel: "off" },
};

async function setup(
  page: Page,
  options: { conflict?: boolean; unavailable?: boolean; thread?: boolean } = {},
) {
  let revision = 2;
  let assignments: Record<string, Selection> = structuredClone(initial);
  const writes: unknown[] = [];
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [{ id: "1", slug: "1", title: "Chat", running: false, status: "regular" }],
      },
    }),
  );
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats/*/threads", (route) =>
    route.fulfill({
      json: {
        threads: options.thread
          ? [
              {
                id: "3",
                parentId: "1",
                sourceEntryId: "2",
                slug: "3-thread",
                title: "Thread",
                replyCount: 1,
                replyCountCapped: false,
                activity: "idle",
                source: { entryId: "2", role: "assistant", text: "Original", truncated: false },
              },
            ]
          : [],
      },
    }),
  );
  await syntheticDrafts(page);
  await page.route("**/api/model-policy", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { revision, assignments, choices: options.unavailable ? [] : choices },
      });
    const body = route.request().postDataJSON() as {
      expected: { revision: number; assignments: Record<string, Selection> };
      assignments: Record<string, Selection>;
    };
    writes.push(body);
    if (options.conflict) {
      options.conflict = false;
      revision++;
      return route.fulfill({ status: 409, json: { error: "Changed" } });
    }
    expect(body.expected).toEqual({ revision, assignments });
    assignments = body.assignments;
    return route.fulfill({ json: { revision: ++revision, assignments } });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.match(/\/chats\/(\d+)/)?.[1] ?? "1");
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
                messages: [],
                partial: "",
                busy: false,
                hasEarlier: false,
                failure: null,
                controls: { canContinue: false, resetPending: false, queue: [] },
              }),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.goto(options.thread ? "/chats/1/threads/3-thread" : "/chats/1");
  return { writes, getAssignments: () => assignments };
}

test("composer selector searches, filters and groups models; applies role-wide with explicit review", async ({
  page,
}) => {
  const { writes, getAssignments } = await setup(page);
  const trigger = page.getByRole("combobox", { name: "Main role model" });
  await expect(trigger).toContainText("alpha-one");
  const draft = page.getByRole("textbox", { name: "Message input", exact: true });
  await draft.fill("Preserve this draft");
  await trigger.click();
  await expect(
    page.getByText(/Apply updates configured roles across existing and new chats and workers/),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter by provider" })).toBeVisible();
  await page.getByRole("button", { name: "beta", exact: true }).click();
  await expect(page.getByRole("option", { name: /beta-one/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /alpha-two/ })).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  const search = page.getByRole("combobox", { name: "Search models" });
  await search.fill("beta");
  await expect(page.getByRole("option", { name: /beta-one/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /alpha-two/ })).toHaveCount(0);
  await page.getByRole("option", { name: /beta-one/ }).click();
  await expect(page.getByRole("radio", { name: "Default", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Max", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "High", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply role model" })).toBeEnabled();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Apply role model" }).click();
  await expect(trigger).toContainText("beta-one");
  expect(writes).toHaveLength(1);
  expect(getAssignments()).toEqual({
    ...initial,
    main: { provider: "beta", modelId: "beta-one", thinkingLevel: "high" },
  });
  await expect(draft).toHaveValue("Preserve this draft");
});

test("stale settings require explicit reload, without overwriting any role", async ({ page }) => {
  const { writes } = await setup(page, { conflict: true });
  const trigger = page.getByRole("combobox", { name: "Main role model" });
  await trigger.click();
  await page.getByRole("option", { name: /alpha-two/ }).click();
  await page.getByRole("button", { name: "Apply role model" }).click();
  await expect(page.getByRole("alert")).toContainText("Save unconfirmed");
  await expect(page.getByRole("button", { name: "Apply role model" })).toBeDisabled();
  expect(writes).toHaveLength(1);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply role model" })).toBeDisabled();
  await expect(trigger).toContainText("alpha-one");
});

test("unavailable model list does not allow saving", async ({ page }) => {
  const { writes } = await setup(page, { unavailable: true });
  await page.getByRole("combobox", { name: "Main role model" }).click();
  await expect(
    page.getByText("This model is unavailable. Choose an available model."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply role model" })).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test("message thread selector changes the tangent role, not the main role", async ({ page }) => {
  const { writes, getAssignments } = await setup(page, { thread: true });
  const panel = page.getByRole("complementary", { name: "Message thread" });
  const trigger = panel.getByRole("combobox", { name: "Tangent role model" });
  await expect(trigger).toContainText("beta-one");
  await trigger.click();
  await expect(
    page.getByText("Tangent covers message threads, tangents and mid-tier workers."),
  ).toBeVisible();
  await page.getByRole("option", { name: /alpha-one/ }).click();
  await page.getByRole("button", { name: "Apply role model" }).click();
  await expect(trigger).toContainText("alpha-one");
  expect(writes).toHaveLength(1);
  expect(getAssignments()).toEqual({
    ...initial,
    tangent: { provider: "alpha", modelId: "alpha-one", thinkingLevel: "default" },
  });
});

test("thinking selection preserves the model and disables unsupported Max", async ({ page }) => {
  const { writes, getAssignments } = await setup(page);
  await page.getByRole("combobox", { name: "Main role model" }).click();
  await expect(page.getByRole("radio", { name: "Max", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Low", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "High", exact: true }).click();
  await page.getByRole("button", { name: "Apply role model" }).click();
  expect(writes).toHaveLength(1);
  expect(getAssignments()).toEqual({
    ...initial,
    main: { ...initial.main, thinkingLevel: "high" },
  });
});

test("reopening a message thread after a pending save reads the confirmed role model", async ({
  page,
}) => {
  await setup(page, { thread: true });
  let saved = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/model-policy", async (route) => {
    if (route.request().method() === "GET") {
      if (!saved) return route.fallback();
      return route.fulfill({
        json: {
          revision: 3,
          assignments: {
            ...initial,
            tangent: { provider: "alpha", modelId: "alpha-one", thinkingLevel: "default" },
          },
          choices,
        },
      });
    }
    const body = route.request().postDataJSON() as { assignments: Record<string, Selection> };
    await gate;
    saved = true;
    await route.fulfill({ json: { revision: 3, assignments: body.assignments } }).catch(() => {});
  });
  await page.setViewportSize({ width: 700, height: 800 });
  const panel = page.getByRole("complementary", { name: "Message thread" });
  const trigger = panel.getByRole("combobox", { name: "Tangent role model" });
  await trigger.click();
  await page.getByRole("option", { name: /alpha-one/ }).click();
  await page.getByRole("button", { name: "Apply role model" }).click();
  await expect(page.getByRole("button", { name: "Applying…" })).toBeDisabled();
  await panel.getByRole("button", { name: /close/i }).click();
  release();
  await expect.poll(() => saved).toBe(true);
  await page.goto("/chats/1/threads/3-thread");
  await expect(page.getByRole("combobox", { name: "Tangent role model" })).toContainText(
    "alpha-one",
  );
});
