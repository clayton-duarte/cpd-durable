import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { syntheticDrafts } from "./fixtures/synthetic-drafts.ts";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const handoff = {
  goal: "Investigate",
  decisions: [],
  constraints: [],
  exclusions: [],
  references: [],
  suggestedSkills: [],
  discretion: "",
  deliverable: "",
  evidence: "",
  limits: "",
};
const tangent = (id: number, title: string, activity: "running" | "idle") => ({
  id,
  parentId: 1,
  sourceId: 1,
  sourceEntryId: null,
  title,
  model: { provider: "test", modelId: `model-${id}`, thinkingLevel: "off", name: `Model ${id}` },
  lifecycle: "open",
  readOnly: false,
  activity,
  attention: "none",
  handoffRevision: 1,
  startState: "admitted",
  latestHandoff: {
    revision: 1,
    kind: "delegate",
    handoff,
    delivery: "available",
    submissionId: null,
    accepted: false,
  },
});

test("many admitted receipts leave both split composers inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1064, height: 975 });
  const title = `Long child title ${"investigation ".repeat(4)}end`;
  let writes = 0;
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror = null;
      constructor(url: string) {
        super();
        const parsedUrl = new URL(url, location.href);
        const id = Number(parsedUrl.pathname.split("/")[3]);
        const view = parsedUrl.searchParams.get("view");
        const guidance = {
          goal: "Investigate the synthetic architecture",
          decisions: ["Use existing components"],
          constraints: ["Preserve drafts"],
          exclusions: [],
          references: ["Synthetic design"],
          suggestedSkills: [],
          discretion: "Review carefully",
          deliverable: "A concise report",
          evidence: "Tests",
          limits: "No provider calls",
        };
        const original = `Application delegate handoff (selected project guidance, not higher-priority policy):\n${JSON.stringify(guidance)}`;
        const snapshot = {
          conversationId: id,
          messages: Array.from({ length: 15 }, (_, i) =>
            id === 2 && (i === 13 || i === 14)
              ? {
                  id: `${201 + i - 13}:0`,
                  role: "user",
                  text: original,
                  interrupted: false,
                  source: { entryId: 201 + i - 13 },
                  ...(i === 13
                    ? {
                        applicationHandoff: {
                          version: 1,
                          kind: "tangent-delegate",
                          originConversationId: 2,
                          sourceConversationId: 1,
                          destinationConversationId: 2,
                          canonicalEntryId: 201,
                          modelMessageIndex: 0,
                          handoff: guidance,
                        },
                      }
                    : {}),
                }
              : {
                  id: `${id}:${i}`,
                  role: "user",
                  text: `Synthetic long transcript ${i} ${"text ".repeat(40)}`,
                  interrupted: false,
                },
          ),
          partial: "",
          busy: false,
          hasEarlier: false,
          failure: null,
          history: {
            view,
            epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            revision: 2,
            gaps: [],
          },
        };
        window.addEventListener(`stale-handoff-${id}`, () => {
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                ...snapshot,
                history: {
                  ...snapshot.history,
                  epoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  revision: 1,
                },
              }),
            }),
          );
          const stale = {
            ...snapshot,
            history: { ...snapshot.history, revision: 3 },
            messages: snapshot.messages.map((message) =>
              "applicationHandoff" in message && message.applicationHandoff
                ? {
                    ...message,
                    applicationHandoff: {
                      ...message.applicationHandoff,
                      handoff: { ...guidance, goal: "Stale guidance must not appear" },
                    },
                  }
                : message,
            ),
          };
          this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(stale) }));
        });
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify(snapshot),
            }),
          ),
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") writes++;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return route.fulfill({
        json: {
          tangents: [
            {
              ...tangent(2, title, "idle"),
              latestHandoff: {
                ...tangent(2, "Child", "idle").latestHandoff,
                handoff: { ...handoff, goal: "Long synthetic handoff ".repeat(50) },
              },
            },
          ],
        },
      });
    if (path.endsWith("/workers"))
      return route.fulfill({
        json: {
          hasUnsettled: true,
          helpers: [
            {
              requestId: "worker-request",
              taskId: "worker-task",
              childId: null,
              mode: "background",
              model: { provider: "test", modelId: "synthetic" },
              modelName: "Synthetic worker",
              stop: "none",
              status: "running",
              answerEntryId: null,
              delivery: "notify-only",
            },
          ],
        },
      });
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.route("**/api/chats/1/draft/attempts", (route) =>
    route.fulfill({
      json: {
        attempts: Array.from({ length: 13 }, (_, i) => ({
          record: {
            requestId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
            draftRevision: i + 1,
            text: `synthetic receipt ${i}`,
            images: [],
            mode: "reject",
            fingerprint: "a".repeat(64),
          },
          ...(i === 12
            ? { admission: "unknown" }
            : { admission: "admitted", submissionId: String(i + 1) }),
        })),
        capped: false,
        nextCursor: null,
      },
    }),
  );
  await page.goto("/chats/1");
  await page.getByRole("button", { name: `Open tangent: ${title}` }).click();
  const tangentPane = page.getByRole("region", { name: `Tangent chat: ${title}` });
  await expect(
    tangentPane.getByText("Investigate the synthetic architecture", { exact: true }),
  ).toBeVisible();
  await expect(tangentPane.getByText(/Application delegate handoff/)).toBeVisible();
  await tangentPane.getByRole("button", { name: "Review full handoff" }).click();
  const mainDraft = page
    .getByRole("region", { name: "Main chat: Main" })
    .getByRole("textbox", { name: "Message input" });
  await mainDraft.fill("Newer main draft");
  await page.evaluate(() => window.dispatchEvent(new Event("stale-handoff-2")));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(tangentPane.getByText("Stale guidance must not appear")).toHaveCount(0);
  await expect(mainDraft).toHaveValue("Newer main draft");
  const originalText = tangentPane.getByRole("textbox", { name: "Original transcript message" });
  await expect(originalText).toHaveValue(/Application delegate handoff/);
  const fullOriginal = await originalText.inputValue();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await originalText.selectText();
  await page.keyboard.press("ControlOrMeta+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullOriginal);
  expect(fullOriginal).toContain("No provider calls");
  await expect(tangentPane.getByText("Suggested skills", { exact: true })).toBeVisible();
  await tangentPane.getByRole("button", { name: "Review full handoff" }).click();
  await expect(page.getByRole("heading", { name: `${title} · Model 2` })).toHaveAttribute(
    "title",
    `${title} · Model 2`,
  );
  if (process.env["CPD_SYNTHETIC_SCREENSHOT"]) {
    await page.screenshot({ path: process.env["CPD_SYNTHETIC_SCREENSHOT"] });
  }
  for (const name of ["Main chat: Main", `Tangent chat: ${title}`]) {
    const input = page
      .getByRole("region", { name })
      .getByRole("textbox", { name: "Message input" });
    await expect(input).toBeVisible();
    const bounds = await input.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(975);
    await input.focus();
    await expect(input).toBeFocused();
  }
  const recovery = page
    .getByRole("region", { name: "Main chat: Main" })
    .getByRole("region", { name: "Draft recovery" });
  await recovery.focus();
  await page.keyboard.press("End");
  await expect(recovery.getByText("synthetic receipt 12")).toBeInViewport();
  await expect(recovery.getByRole("button", { name: "Retry original" })).toHaveCount(1);
  await expect(recovery.getByText("1 send not confirmed")).toBeVisible();
  await expect(recovery.getByText("synthetic receipt 0", { exact: true })).toHaveCount(0);
  await recovery.getByRole("button", { name: "Review original" }).click();
  await expect(recovery.getByRole("textbox", { name: "Full original text" })).toHaveValue(
    "synthetic receipt 12",
  );
  await recovery.getByRole("button", { name: "Review original" }).click();
  await recovery.getByRole("button", { name: "Send history" }).click();
  await expect(recovery.getByRole("button", { name: "synthetic receipt 0" })).toBeVisible();
  await recovery.getByRole("button", { name: "Send history" }).click();
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  // CSS viewport emulation, not browser zoom: 532×487 approximates 200% of 1064×975.
  for (const viewport of [
    { width: 532, height: 487 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const tab of ["Main", title]) {
      await page.getByRole("tab", { name: tab, exact: true }).focus();
      await page.keyboard.press("Enter");
      const input = page
        .getByRole("tabpanel", { name: tab })
        .getByRole("textbox", { name: "Message input" });
      await expect(input).toBeVisible();
      const bounds = await input.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await input.focus();
      await expect(input).toBeFocused();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  expect(writes).toBe(0);
});

test("private feedback stays scoped to each pane and stale ownership blocks held saves", async ({
  page,
}) => {
  let stale = false;
  let releaseRead: (() => void) | undefined;
  let releaseSave: (() => void) | undefined;
  let reads = 0;
  const writes: {
    chat: string;
    body: {
      requestId: string;
      expectedRevision: number;
      value: { vote: string; comment: string | null };
    };
  }[] = [];
  const values: Record<
    string,
    { revision: number; value: { vote: string; comment: string | null } | null }
  > = {
    "1": { revision: 0, value: null },
    "2": { revision: 0, value: null },
  };
  await page.addInitScript(() => {
    class Source extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: id,
                messages: [
                  {
                    id: "11:2",
                    role: "assistant",
                    text: "Inherited answer",
                    interrupted: false,
                    source: { entryId: 11, feedbackModelIndex: 2 },
                  },
                ],
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
    Object.defineProperty(window, "EventSource", { value: Source });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return stale
        ? route.fulfill({ status: 503 })
        : route.fulfill({ json: { tangents: [tangent(2, "Child", "idle")] } });
    const match = /^\/api\/chats\/([12])\/feedback\/11\/2$/.exec(path);
    if (match) {
      const chat = match[1]!;
      const view = () => ({
        conversationId: chat,
        target: { entryId: 11, modelIndex: 2 },
        ...values[chat]!,
        readOnly: false,
      });
      if (req.method() === "GET") {
        if (chat === "2" && reads++ === 0)
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        return route.fulfill({ json: view() });
      }
      const body = req.postDataJSON() as (typeof writes)[number]["body"];
      writes.push({ chat, body });
      if (chat === "2")
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
      values[chat] = { revision: body.expectedRevision + 1, value: body.value };
      return route.fulfill({ json: view() });
    }
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1");
  const main = page.getByRole("region", { name: "Main chat: Main" });
  const draft = main.getByRole("textbox", { name: "Message input" });
  await draft.fill("Main draft");
  await main.getByRole("button", { name: "Helpful", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Optional comment").fill("Main vote");
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect(dialog).toContainText("Saved revision 1");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Open tangent: Child" }).click();
  const side = page.getByRole("region", { name: "Tangent chat: Child" });
  await expect.poll(() => !!releaseRead).toBe(true);
  await page.getByRole("button", { name: "Close tangent" }).click();
  releaseRead?.();
  await page.getByRole("button", { name: "Open tangent: Child" }).click();
  await side.getByRole("button", { name: "Not helpful", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Optional comment").fill("Child vote");
  await expect(dialog.getByRole("button", { name: "Save feedback" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save feedback" }).click();
  await expect.poll(() => !!releaseSave).toBe(true);
  await dialog.getByLabel("Optional comment").fill("Newer child draft");
  stale = true;
  await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(dialog.getByRole("button", { name: "Save feedback" })).toBeDisabled();
  releaseSave?.();
  await expect(dialog.getByLabel("Optional comment")).toHaveValue("Newer child draft");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft).toHaveValue("Main draft");
  expect(writes.map((entry) => entry.chat)).toEqual(["1", "2"]);
  expect(writes[0]!.body.value.vote).toBe("helpful");
  expect(writes[1]!.body.value.vote).toBe("unhelpful");
});

async function addFile(page: Page, scope: ReturnType<Page["locator"]>, name: string) {
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: png });
  await expect(scope.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}

for (const prefix of ["!", "!!"]) {
  test(`stale parent relationship blocks ${prefix} shell admission with child still connected`, async ({
    page,
  }) => {
    let stale = false;
    let runningShell = false;
    const writes: string[] = [];
    await page.addInitScript(() => {
      class Source extends EventTarget {
        onerror = null;
        constructor(url: string) {
          super();
          const id = Number(new URL(url, location.href).pathname.split("/")[3]);
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
      Object.defineProperty(window, "EventSource", { value: Source });
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && !path.endsWith("/attachments"))
        writes.push(`${request.method()} ${path}`);
      if (path === "/api/chats")
        return route.fulfill({
          json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
        });
      if (path === "/api/chats/1/tangents")
        return stale
          ? route.fulfill({ status: 503 })
          : route.fulfill({ json: { tangents: [tangent(2, "Child", "idle")] } });
      if (path === "/api/chats/2/shell" && request.method() === "GET")
        return route.fulfill({
          json: runningShell
            ? {
                requestId: "11111111-1111-4111-8111-111111111111",
                command: "synthetic",
                includeInContext: true,
                conversationId: "2",
                taskId: "7",
                status: "running",
                output: "synthetic",
                truncated: false,
              }
            : null,
        });
      if (path.endsWith("/attachments") && request.method() === "POST")
        return route.fulfill({
          status: 201,
          json: {
            id: ids[0],
            mimeType: "image/png",
            size: png.length,
            prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
          },
        });
      if (path.includes("/attachments/"))
        return route.fulfill({ contentType: "image/png", body: png });
      return route.abort();
    });
    await syntheticDrafts(page);
    await page.goto("/chats/1");
    await page.getByRole("button", { name: "Open tangent: Child" }).click();
    const side = page.getByRole("region", { name: "Tangent chat: Child" });
    const input = side.getByRole("textbox", { name: "Message input" });
    await input.fill(`${prefix} synthetic-command`);
    stale = true;
    await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter" });
    await side.getByRole("button", { name: "Send message", exact: true }).dispatchEvent("click");
    expect(writes).toEqual([]);
    await expect(input).toHaveValue(`${prefix} synthetic-command`);
    stale = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(side.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await expect(input).toHaveValue(`${prefix} synthetic-command`);
    expect(writes).toEqual([]);
    runningShell = true;
    await expect(side.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 15000,
    });
    stale = true;
    await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    const stop = side.getByRole("button", { name: "Stop generating" });
    await expect(stop).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

test("saved prompts use each native composer and respect stale parent scope", async ({ page }) => {
  let saved = {
    id: "44444444-4444-4444-8444-444444444444",
    title: "Shared",
    text: "Literal prompt",
    revision: 1,
  };
  let created: typeof saved | null = null;
  let upload = 0,
    mutations = 0,
    inputs = 0,
    parentUnavailable = false;
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
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
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return parentUnavailable
        ? route.fulfill({ status: 503 })
        : route.fulfill({ json: { tangents: [tangent(2, "Child", "idle")] } });
    if (path === "/api/saved-prompts") {
      if (req.method() !== "GET") {
        mutations++;
        const body = req.postDataJSON() as { id: string; title: string; text: string };
        created = { id: body.id, title: body.title, text: body.text, revision: 1 };
        return route.fulfill({ status: 201, json: { prompt: created, deleted: false } });
      }
      return route.fulfill({
        json: { items: created ? [saved, created] : [saved], nextCursor: null },
      });
    }
    if (path.startsWith("/api/saved-prompts/")) {
      mutations++;
      const body = req.postDataJSON() as {
        id: string;
        title: string;
        text: string;
        expectedRevision: number;
      };
      if (body.id === saved.id && body.expectedRevision !== saved.revision)
        return route.fulfill({ status: 409, json: {} });
      if (req.method() === "DELETE") {
        const prior = created!;
        created = null;
        return route.fulfill({ json: { prompt: prior, deleted: true } });
      }
      saved = { id: saved.id, title: body.title, text: body.text, revision: saved.revision + 1 };
      return route.fulfill({ json: { prompt: saved, deleted: false } });
    }
    if (path.endsWith("/attachments") && req.method() === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id: ids[upload++],
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    if (path.includes("/attachments/"))
      return route.fulfill({ contentType: "image/png", body: png });
    if (path.endsWith("/input")) inputs++;
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1");
  const main = page.getByRole("region", { name: "Main chat: Main" });
  const draft = (scope: ReturnType<Page["locator"]>) =>
    scope.getByRole("textbox", { name: "Message input" });
  await expect(draft(main)).toBeEnabled();
  await addFile(page, main, "main.png");
  await page.getByRole("button", { name: "Open tangent: Child" }).click();
  const side = page.getByRole("region", { name: "Tangent chat: Child" });
  await expect(draft(side)).toBeEnabled();
  await addFile(page, side, "side.png");
  async function choose(scope: ReturnType<Page["locator"]>, text: string) {
    const input = draft(scope);
    await input.fill(`/ ${text}`);
    await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 1));
    await input.press("ArrowLeft");
    await input.press("ArrowRight");
    await scope.getByRole("option", { name: /\/prompts/ }).click();
    await page.getByRole("option", { name: "Shared", exact: true }).click();
  }
  await choose(main, "main draft");
  await page.getByRole("button", { name: "Append to draft" }).click();
  await expect(draft(main)).toHaveValue("main draft\nLiteral prompt");
  await choose(side, "side draft");
  await page.getByRole("textbox", { name: "Prompt title", exact: true }).fill("From child");
  await page.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect.poll(() => created?.text).toBe("side draft");
  await page.getByRole("option", { name: "From child" }).click();
  await page.getByRole("button", { name: "Delete prompt" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect.poll(() => created).toBeNull();
  await page.getByRole("option", { name: "Shared", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit prompt text" }).fill("Revised literal");
  saved = { ...saved, revision: 2 };
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect(page.getByRole("button", { name: "Reload latest revision" })).toBeVisible();
  await page.getByRole("button", { name: "Reload latest revision" }).click();
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue(
    "Revised literal",
  );
  await page.getByRole("button", { name: "Save edit" }).click();
  await expect.poll(() => saved.revision).toBe(3);
  await page.getByRole("option", { name: "Shared", exact: true }).click();
  await page.getByRole("button", { name: "Replace draft" }).click();
  await expect(draft(side)).toHaveValue("Revised literal");
  await expect(draft(main)).toHaveValue("main draft\nLiteral prompt");
  await expect(main.getByRole("button", { name: "Remove main.png" })).toBeVisible();
  await expect(side.getByRole("button", { name: "Remove side.png" })).toBeVisible();
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let readStarted = false;
  const heldRead = async (route: import("@playwright/test").Route) => {
    readStarted = true;
    await readGate;
    await route.fulfill({ json: { items: [saved], nextCursor: null } });
  };
  await page.route("**/api/saved-prompts", heldRead);
  await draft(side).fill("/ side before navigation");
  await draft(side).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 1));
  await draft(side).press("ArrowLeft");
  await draft(side).press("ArrowRight");
  await side.getByRole("option", { name: /\/prompts/ }).click();
  await expect.poll(() => readStarted).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Close tangent" }).click();
  releaseRead();
  await page.unroute("**/api/saved-prompts", heldRead);
  await expect(draft(main)).toHaveValue("main draft\nLiteral prompt");
  await page.getByRole("button", { name: "Open tangent: Child" }).click();
  await expect(draft(side)).toHaveValue("side before navigation");
  const beforeStale = mutations;
  await choose(side, "retained side");
  await page.getByRole("textbox", { name: "Edit prompt text" }).fill("Held unsaved edit");
  await page.getByRole("textbox", { name: "Prompt title", exact: true }).fill("Held title");
  parentUnavailable = true;
  await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  for (const name of [
    "Append to draft",
    "Replace draft",
    "Save edit",
    "Delete prompt",
    "Save prompt",
  ])
    await page.getByRole("button", { name, exact: true }).dispatchEvent("click");
  expect(mutations).toBe(beforeStale);
  expect(inputs).toBe(0);
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue(
    "Held unsaved edit",
  );
  await expect(page.getByRole("textbox", { name: "Prompt title", exact: true })).toHaveValue(
    "Held title",
  );
  parentUnavailable = false;
  await expect(page.getByRole("button", { name: "Save edit" })).toBeEnabled({ timeout: 15000 });
  await expect(page.getByRole("textbox", { name: "Edit prompt text" })).toHaveValue(
    "Held unsaved edit",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(draft(side)).toHaveValue("retained side");
  await expect(side.getByRole("button", { name: "Remove side.png" })).toBeVisible();
  expect(upload).toBe(2);
  expect(inputs).toBe(0);
  expect(mutations).toBe(beforeStale);
});

test("production route keeps native chats and drafts through tangent navigation", async ({
  page,
}) => {
  const requests: string[] = [];
  let upload = 0;
  let stopRequested = false;
  let policyRevision = 1;
  let workerSelection: { provider: string; modelId: string; thinkingLevel: string } | null = null;
  const inputs: unknown[] = [];
  let releaseInput!: () => void;
  const inputGate = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
        queueMicrotask(() => {
          if (!this.closed)
            this.dispatchEvent(
              new MessageEvent("state", {
                data: JSON.stringify({
                  conversationId: id,
                  messages: [],
                  partial: "",
                  busy: id === 2,
                  hasEarlier: false,
                  failure: null,
                  controls: { canContinue: false, resetPending: false, queue: [] },
                }),
              }),
            );
        });
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/model-policy" && request.method() === "POST") {
      const body = request.postDataJSON() as { assignments: { worker: typeof workerSelection } };
      workerSelection = body.assignments.worker;
      policyRevision++;
      return route.fulfill({
        json: {
          revision: policyRevision,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: workerSelection,
          },
        },
      });
    }
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: policyRevision,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: workerSelection,
          },
          choices: [
            { provider: "test", modelId: "mid", name: "Mid", thinkingLevels: ["off"] },
            { provider: "test", modelId: "cheap", name: "Cheap", thinkingLevels: ["off"] },
          ],
        },
      });
    if (path === "/api/chats/1/input" && request.method() === "POST") {
      inputs.push(request.postDataJSON());
      await inputGate;
      return route.fulfill({ status: 202, json: { id: "admitted" } });
    }
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return route.fulfill({
        json: {
          tangents: [tangent(2, "Running child", "running"), tangent(3, "Idle child", "idle")],
        },
      });
    if (path.endsWith("/questions"))
      return route.fulfill({
        json: {
          conversationId: path.split("/")[3],
          questions: path.includes("/3/")
            ? [
                {
                  questionId: "q-9",
                  taskId: 9,
                  revision: 1,
                  status: "pending",
                  actionable: true,
                  cancelled: false,
                  spec: {
                    message: "Child question",
                    fields: [{ id: "answer", kind: "text", label: "Answer", required: true }],
                  },
                },
              ]
            : [],
        },
      });
    if (path.endsWith("/workers")) {
      const id = path.split("/")[3];
      return route.fulfill({
        json: {
          hasUnsettled: true,
          helpers: [
            {
              requestId: `request-${id}`,
              taskId: `task-${id}`,
              childId: null,
              mode: "background",
              model: { provider: "test", modelId: `worker-${id}` },
              modelName: `Worker model ${id}`,
              stop: id === "2" && stopRequested ? "requested" : "none",
              status: id === "1" ? "unknown" : "running",
              answerEntryId: null,
              delivery: "notify-only",
            },
          ],
        },
      });
    }
    if (path === "/api/chats/2/workers/task-2/stop") {
      stopRequested = true;
      return route.fulfill({ status: 202, json: { status: "requested" } });
    }
    if (path === "/api/chats/2/workers/task-2/result")
      return route.fulfill({
        json: {
          taskId: "task-2",
          childId: "20",
          answerEntryId: "5",
          text: "Review this result",
          truncated: false,
          review: "unreviewed",
        },
      });
    if (path.endsWith("/attachments") && request.method() === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id: ids[upload++],
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    if (path.includes("/attachments/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1");
  const main = page.getByRole("region", { name: "Main chat: Main" });
  const input = (scope: ReturnType<Page["locator"]>) =>
    scope.getByRole("textbox", { name: "Message input" });
  await input(main).fill("main draft");
  await addFile(page, main, "main.png");
  await page.getByRole("button", { name: "Open tangent: Running child" }).click();
  await expect(page).toHaveURL(/tangent=2/);
  const side = page.getByRole("region", { name: "Tangent chat: Running child" });
  await input(side).fill("child draft");
  await addFile(page, side, "child.png");
  await expect.poll(() => requests.includes("GET /api/chats/2/questions")).toBe(true);
  await expect(main.getByText(/Worker model 1 · unknown/)).toBeVisible();
  await expect(side.getByText(/Worker model 2 · running/)).toBeVisible();
  await side.getByRole("button", { name: "Inspect worker task-2" }).click();
  await expect(side.getByRole("textbox", { name: "Worker result for review" })).toHaveValue(
    "Review this result",
  );
  await side.getByRole("button", { name: "Stop worker task-2" }).click();
  await expect(side.getByText(/stop requested/)).toBeVisible();
  await page.getByRole("button", { name: "Close tangent" }).click();
  await expect(page).toHaveURL(/\/chats\/1$/);
  await expect(input(main)).toHaveValue("main draft");
  await expect(main.getByRole("button", { name: "Remove main.png" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/tangent=2/);
  await expect(input(side)).toHaveValue("child draft");
  await expect(side.getByRole("button", { name: "Remove child.png" })).toBeVisible();
  await page.getByRole("button", { name: "Open tangent: Idle child" }).click();
  await expect(page).toHaveURL(/tangent=3/);
  await page.goBack();
  await expect(input(side)).toHaveValue("child draft");
  await page.goForward();
  await expect(page).toHaveURL(/tangent=3/);
  const idleSide = page.getByRole("region", { name: "Tangent chat: Idle child" });
  await input(idleSide).fill("/tangent secret");
  await input(idleSide).press("Enter");
  await expect(
    idleSide.getByText("Choose an available / command from the list; command text was not sent."),
  ).toBeVisible();
  expect(requests.filter((r) => /^POST \/api\/chats\/\d+\/(input|stop)$/.test(r))).toEqual([]);
  await idleSide.getByLabel("Answer").fill("held answer");
  await page.route("**/api/chats/1/tangents", (route) => route.fulfill({ status: 503 }));
  await expect(idleSide.getByText("Child question")).toBeVisible();
  await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Tangent chat: Idle child" })).toBeVisible();
  await expect(input(idleSide)).toHaveValue("/tangent secret");
  await expect(idleSide.getByRole("button", { name: "Stop worker task-3" })).toBeDisabled();
  await expect(idleSide.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(idleSide.getByRole("button", { name: "Decline" })).toBeDisabled();
  await expect(idleSide.getByText("held answer")).toBeVisible();
  await idleSide.getByRole("button", { name: "Tangent actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Conclude tangent" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(idleSide.getByRole("button", { name: "Tangent actions" })).toBeFocused();
  const childMutationsBefore = requests.filter((r) => r.startsWith("POST /api/chats/3/")).length;
  await input(idleSide)
    .press("Enter")
    .catch(() => {});
  await expect(input(idleSide)).toHaveValue("/tangent secret");
  await page.unroute("**/api/chats/1/tangents");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeEnabled();
  await expect(idleSide.getByRole("button", { name: "Stop worker task-3" })).toBeEnabled();
  await expect(idleSide.getByLabel("Answer")).toBeEnabled();
  await expect(idleSide.getByLabel("Answer")).toHaveValue("held answer");
  await expect(input(idleSide)).toHaveValue("/tangent secret");
  expect(requests.filter((r) => r.startsWith("POST /api/chats/3/"))).toHaveLength(
    childMutationsBefore,
  );
  await expect.poll(() => requests.includes("GET /api/model-policy")).toBe(true);
  await input(main).fill("/tangent Explore the architecture");
  await input(main).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(8, 8));
  await input(main).press("ArrowLeft");
  await input(main).press("ArrowRight");
  const palette = main.locator('[data-slot="composer-trigger-popover"]');
  await expect(palette.getByRole("option", { name: /\/tangent/ })).toBeVisible();
  await palette.getByRole("option", { name: /\/tangent/ }).click();
  await expect.poll(() => inputs.length).toBe(1);
  expect(inputs[0]).toMatchObject({
    mode: "reject",
    text: expect.stringContaining("Explore the architecture"),
  });
  expect(inputs[0]).toMatchObject({ text: expect.stringContaining("create_tangent") });
  expect(inputs[0]).toMatchObject({ images: [ids[0]] });
  await input(main).fill("newer draft");
  releaseInput();
  await expect(input(main)).toHaveValue("newer draft");
  await expect(page.locator('[data-slot="task-card"]')).toHaveCount(2);
  await page.goto("/chats/1?tangent=999");
  await expect(page.getByText("Tangent not found", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /Tangent chat:/ })).toHaveCount(0);
  await page.goto("/chats/1?tangent=wrong");
  await expect(page.getByText("Tangent not found", { exact: true })).toBeVisible();
  const starts: unknown[] = [];
  let unstarted = { ...tangent(3, "Idle child", "idle"), startState: "create-only" };
  const extraTangents: ReturnType<typeof tangent>[] = [];
  await page.route("**/api/chats/1/tangents", (route) =>
    route.fulfill({ json: { tangents: [unstarted, ...extraTangents] } }),
  );
  await page.route("**/api/chats/1/tangents/3/start", (route) => {
    starts.push(route.request().postDataJSON());
    if (starts.length === 1) return route.abort();
    unstarted = { ...unstarted, startState: "admitted" };
    return route.fulfill({ status: 202, json: { tangent: unstarted } });
  });
  await page.goto("/chats/1?tangent=3");
  const unstartedPane = page.getByRole("region", { name: "Tangent chat: Idle child" });
  await unstartedPane.getByRole("button", { name: "Review full handoff" }).click();
  await expect(unstartedPane.getByRole("textbox", { name: "Initial handoff" })).toHaveValue(
    /Investigate/,
  );
  await unstartedPane.getByRole("button", { name: "Review full handoff" }).click();
  await input(unstartedPane).fill("keep this draft");
  await expect(unstartedPane.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(starts).toEqual([]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Worker model" }).click();
  await page
    .getByRole("option", { name: /test\/cheap/ })
    .last()
    .click();
  await page.getByRole("button", { name: "Confirm thinking off" }).click();
  await page.getByRole("button", { name: "Save model tiers" }).click();
  await expect.poll(() => policyRevision).toBe(2);
  await page.keyboard.press("Escape");
  await expect(unstartedPane.getByRole("heading", { name: "Idle child · Model 3" })).toBeVisible();
  await unstartedPane.getByRole("button", { name: "Start tangent" }).click();
  await expect(unstartedPane.getByText(/Start could not be confirmed/)).toBeVisible();
  await unstartedPane.getByRole("button", { name: "Start tangent" }).click();
  await expect(unstartedPane.getByRole("button", { name: "Send message" })).toBeEnabled();
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  expect(starts).toHaveLength(2);
  expect(starts[1]).toEqual(starts[0]);
  const lifecycleRequests: unknown[] = [];
  await page.route("**/api/chats/1/tangents/3/lifecycle", (route) => {
    const body = route.request().postDataJSON() as { expected: string; next: string };
    lifecycleRequests.push(body);
    if (lifecycleRequests.length === 1 || body.next === "archived")
      return route.fulfill({ status: 409, json: { error: "Tangent has active work" } });
    unstarted = { ...unstarted, lifecycle: body.next, readOnly: body.next !== "open" };
    return route.fulfill({ json: { tangent: unstarted } });
  });
  await unstartedPane.getByRole("button", { name: "Tangent actions" }).click();
  await page.getByRole("menuitem", { name: "Conclude tangent" }).click();
  await expect(page.getByRole("alert")).toContainText("work is still active");
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  await unstartedPane.getByRole("button", { name: "Tangent actions" }).click();
  await page.getByRole("menuitem", { name: "Conclude tangent" }).click();
  await expect(unstartedPane.getByText("Tangent · concluded")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tangent: Idle child" })).toHaveCount(0);
  await unstartedPane.getByRole("button", { name: "Close tangent" }).click();
  expect(lifecycleRequests).toHaveLength(2);
  await page.getByRole("button", { name: "Completed and archived tangents" }).click();
  await page.getByRole("button", { name: /Idle child · Concluded/ }).click();
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  await unstartedPane.getByRole("button", { name: "Tangent actions" }).click();
  await page.getByRole("menuitem", { name: "Reopen tangent" }).click();
  await expect(unstartedPane.getByText("Tangent · open")).toBeVisible();
  await unstartedPane.getByRole("button", { name: "Tangent actions" }).click();
  await page.getByRole("menuitem", { name: "Archive tangent" }).click();
  await expect(page.getByRole("alert")).toContainText("work is still active");
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  let placed = false;
  let admitted = false;
  let accepted = false;
  let acceptCount = 0;
  let wrongRevision = true;
  const deliveries: unknown[] = [];
  let delayStatus = false;
  let lateStarted = false;
  let releaseLate!: () => void;
  const lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const unsafe = '<img src=x onerror="window.__unsafe=true">';
  unstarted = {
    ...unstarted,
    attention: "report-ready",
    latestHandoff: {
      ...unstarted.latestHandoff,
      revision: 2,
      kind: "return",
      delivery: "available",
      handoff: {
        ...handoff,
        goal: unsafe,
        evidence: "Synthetic evidence",
        limits: "Synthetic limits",
      },
    },
  };
  await page.route("**/api/chats/1/tangents/3/returns/2", async (route) => {
    if (delayStatus) {
      lateStarted = true;
      await lateGate;
    }
    await route
      .fulfill({
        json: {
          revision: wrongRevision ? 1 : 2,
          admitted,
          placed,
          submissionStatus: "queued",
          accepted,
        },
      })
      .catch(() => {});
  });
  await page.route("**/api/chats/1/tangents/3/deliver", (route) => {
    deliveries.push(route.request().postDataJSON());
    if (deliveries.length === 1)
      return route.fulfill({ status: 409, json: { error: "Context changed", currentHead: "21" } });
    if (deliveries.length === 2) return route.abort();
    if (deliveries.length === 3)
      return route.fulfill({ status: 409, json: { error: "Context changed", currentHead: "22" } });
    admitted = true;
    return route.fulfill({
      json: { revision: 2, delivery: "admitted", submissionId: 5, accepted: false },
    });
  });
  await page.route("**/api/chats/1/tangents/3/accept", (route) => {
    acceptCount++;
    if (acceptCount === 1) return route.fulfill({ status: 409, json: { error: "Changed" } });
    accepted = true;
    return route.fulfill({ json: { revision: 2, accepted: true } });
  });
  const report = unstartedPane.getByRole("region", { name: "Return report revision 2" });
  await report.getByRole("button", { name: "Review full handoff" }).click();
  const preview = report.getByRole("textbox", { name: "Return handoff for review" });
  await expect(preview).toBeVisible();
  expect(JSON.parse(await preview.inputValue())).toMatchObject({
    goal: unsafe,
    evidence: "Synthetic evidence",
    limits: "Synthetic limits",
  });
  expect(await page.evaluate(() => Reflect.has(window, "__unsafe"))).toBe(false);
  await report.getByRole("button", { name: "Review full handoff" }).click();
  await expect(report.getByRole("alert")).toContainText("Return status unavailable");
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeDisabled();
  wrongRevision = false;
  await expect(report.getByText("Available; not admitted")).toBeVisible();
  await report.getByRole("button", { name: "Bring findings back" }).click();
  await expect(report.getByText(/Current context head: 21/)).toBeVisible();
  expect(deliveries).toHaveLength(1);
  await report.getByRole("button", { name: "Deliver to current context" }).click();
  await expect(report.getByRole("button", { name: "Retry delivery" })).toBeVisible();
  await report.getByRole("button", { name: "Retry delivery" }).click();
  await expect(report.getByText(/Current context head: 22/)).toBeVisible();
  expect(deliveries[1]).toEqual(deliveries[2]);
  await report.getByRole("button", { name: "Deliver to current context" }).click();
  expect(deliveries[3]).toEqual({ revision: 2, expectedHead: "22", acknowledgeRetired: true });
  await expect(report.getByText("Admitted; not yet placed")).toBeVisible();
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeDisabled();
  await expect(unstartedPane.getByText("Tangent · open")).toBeVisible();
  placed = true;
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeEnabled();
  await report.getByRole("button", { name: "Accept reviewed return" }).click();
  await expect(report.getByText("Not accepted by parent review.", { exact: false })).toBeVisible();
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeEnabled();
  await report.getByRole("button", { name: "Accept reviewed return" }).click();
  await expect(report.getByText("Accepted by parent review.", { exact: false })).toBeVisible();
  expect(acceptCount).toBe(2);
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  delayStatus = true;
  extraTangents.push(tangent(2, "Other child", "idle"));
  await expect.poll(() => lateStarted).toBe(true);
  await page.getByRole("button", { name: "Open tangent: Other child" }).click();
  releaseLate();
  await expect(report).toBeHidden();
  await expect(page.getByRole("region", { name: "Return report revision 2" })).toHaveCount(0);
});

test("busy and archived main chats do not expose tangent commands or send their literal text", async ({
  page,
}) => {
  let archived = false;
  const inputs: string[] = [];
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
                messages: [],
                partial: "",
                busy: true,
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
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path.endsWith("/input")) inputs.push(path);
    if (path === "/api/chats")
      return route.fulfill({
        json: {
          rootId: "1",
          chats: [
            { id: "1", title: "Main", running: true, status: archived ? "archived" : "regular" },
          ],
        },
      });
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: 1,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: null,
          },
          choices: [],
        },
      });
    if (path.endsWith("/tangents")) return route.fulfill({ json: { tangents: [] } });
    if (path.endsWith("/workers"))
      return route.fulfill({ json: { helpers: [], hasUnsettled: false } });
    if (path.endsWith("/questions"))
      return route.fulfill({ json: { conversationId: "1", questions: [] } });
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1");
  const draft = page.getByRole("textbox", { name: "Message input" });
  await draft.fill("/tangent goal");
  await draft.press("Enter");
  await expect(
    page
      .locator('[data-slot="composer-trigger-popover"]')
      .getByRole("option", { name: /\/tangent/ }),
  ).toHaveCount(0);
  expect(inputs).toEqual([]);
  archived = true;
  await page.reload();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /\/tangent|\/side/ })).toHaveCount(0);
  expect(inputs).toEqual([]);
});

test("loading earlier child history keeps main history and both native drafts independent", async ({
  page,
}) => {
  const historyCalls: string[] = [];
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        super();
        const parsed = new URL(url, location.href);
        const id = Number(parsed.pathname.split("/")[3]);
        const view = parsed.searchParams.get("view");
        const messages = Array.from({ length: 30 }, (_, index) => {
          const entry = index + 31;
          return {
            id: `${entry}:0`,
            role: "user",
            text: `Chat ${id} turn ${entry}`,
            interrupted: false,
            source: { entryId: entry },
          };
        });
        queueMicrotask(() => {
          if (!this.closed)
            this.dispatchEvent(
              new MessageEvent("state", {
                data: JSON.stringify({
                  conversationId: id,
                  messages,
                  partial: "",
                  busy: false,
                  hasEarlier: true,
                  failure: null,
                  live: null,
                  controls: { canContinue: false, resetPending: false, queue: [] },
                  window: { entryIds: messages.map((message) => message.source.entryId) },
                  history: {
                    view,
                    epoch: "11111111-1111-4111-8111-111111111111",
                    revision: 1,
                    oldest: 31,
                    gaps: [],
                  },
                }),
              }),
            );
        });
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return route.fulfill({ json: { tangents: [tangent(2, "Running child", "running")] } });
    if (path.endsWith("/workers"))
      return route.fulfill({ json: { helpers: [], hasUnsettled: false } });
    if (path.endsWith("/questions"))
      return route.fulfill({ json: { conversationId: path.split("/")[3], questions: [] } });
    if (path === "/api/chats/2/history" && req.method() === "POST") {
      historyCalls.push(path);
      const data = req.postDataJSON() as { view: string };
      const messages = Array.from({ length: 60 }, (_, index) => {
        const entry = index + 1;
        return {
          id: `${entry}:0`,
          role: "user",
          text: `Chat 2 turn ${entry}`,
          interrupted: false,
          source: { entryId: entry },
        };
      });
      return route.fulfill({
        json: {
          conversationId: 2,
          messages,
          partial: "",
          busy: false,
          hasEarlier: false,
          failure: null,
          live: null,
          controls: { canContinue: false, resetPending: false, queue: [] },
          window: { entryIds: messages.slice(-30).map((message) => message.source.entryId) },
          history: {
            view: data.view,
            epoch: "11111111-1111-4111-8111-111111111111",
            revision: 2,
            oldest: 1,
            gaps: [],
          },
        },
      });
    }
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1?tangent=2");
  const main = page.getByRole("region", { name: "Main chat: Main" });
  const child = page.getByRole("region", { name: "Tangent chat: Running child" });
  await main.getByRole("textbox", { name: "Message input" }).fill("main history draft");
  await child.getByRole("textbox", { name: "Message input" }).fill("child history draft");
  const load = child.getByRole("button", { name: "Load earlier messages" });
  await load.scrollIntoViewIfNeeded();
  const anchor = child.locator('[data-durable-id="31:0"]');
  await anchor.evaluate((node) => node.setAttribute("data-history-probe", "original"));
  const before = (await anchor.boundingBox())!.y;
  await load.click();
  await expect(child.getByText("Chat 2 turn 1", { exact: true })).toBeVisible();
  await expect(anchor).toHaveAttribute("data-history-probe", "original");
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(6);
  await expect(main.locator("[data-durable-id]")).toHaveCount(30);
  await expect(child.locator("[data-durable-id]")).toHaveCount(60);
  await expect(main.getByRole("textbox", { name: "Message input" })).toHaveValue(
    "main history draft",
  );
  await expect(child.getByRole("textbox", { name: "Message input" })).toHaveValue(
    "child history draft",
  );
  expect(historyCalls).toEqual(["/api/chats/2/history"]);
});

test("templates and typed tool receipts stay scoped across native main and tangent drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1400 });
  const requests: string[] = [];
  const saved: Record<string, string[]> = {};
  page.on("request", (request) => {
    const match = /\/api\/chats\/(1|3)\/draft$/.exec(new URL(request.url()).pathname);
    if (request.method() !== "PUT" || !match?.[1]) return;
    const body = request.postDataJSON() as { content: { text: string } };
    (saved[match[1]] ??= []).push(body.content.text);
  });
  let upload = 0;
  let stopRequested = false;
  let policyRevision = 1;
  let workerSelection: { provider: string; modelId: string; thinkingLevel: string } | null = null;
  const inputs: unknown[] = [];
  const inputGate = Promise.resolve();
  await page.addInitScript(() => {
    class Synthetic extends EventTarget {
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        super();
        const id = Number(new URL(url, location.href).pathname.split("/")[3]);
        queueMicrotask(() => {
          if (!this.closed)
            this.dispatchEvent(
              new MessageEvent("state", {
                data: JSON.stringify({
                  conversationId: id,
                  messages:
                    id === 3
                      ? [
                          {
                            id: "1:0",
                            role: "assistant",
                            text: "",
                            interrupted: false,
                            outcome: "complete",
                            parts: [
                              {
                                id: "1:0:0",
                                type: "tool-call",
                                callId: "table",
                                name: "display_table",
                                arguments: {},
                                state: "complete",
                                output: "Table receipt.",
                                table: {
                                  version: 1,
                                  table: {
                                    columns: [{ id: "x", label: "X" }],
                                    rows: [{ x: "row" }],
                                  },
                                },
                              },
                              {
                                id: "1:0:1",
                                type: "tool-call",
                                callId: "edit",
                                name: "edit",
                                arguments: {},
                                state: "complete",
                                output: "Edit receipt.",
                                editDiff: {
                                  kind: "patch",
                                  patch: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-before\n+after\n",
                                },
                              },
                            ],
                          },
                        ]
                      : [],
                  partial: "",
                  busy: false,
                  hasEarlier: false,
                  failure: null,
                  controls: { canContinue: false, resetPending: false, queue: [] },
                }),
              }),
            );
        });
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "EventSource", { value: Synthetic });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/model-policy" && request.method() === "POST") {
      const body = request.postDataJSON() as { assignments: { worker: typeof workerSelection } };
      workerSelection = body.assignments.worker;
      policyRevision++;
      return route.fulfill({
        json: {
          revision: policyRevision,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: workerSelection,
          },
        },
      });
    }
    if (path === "/api/model-policy")
      return route.fulfill({
        json: {
          revision: policyRevision,
          assignments: {
            main: null,
            tangent: { provider: "test", modelId: "mid", thinkingLevel: "off" },
            worker: workerSelection,
          },
          choices: [
            { provider: "test", modelId: "mid", name: "Mid", thinkingLevels: ["off"] },
            { provider: "test", modelId: "cheap", name: "Cheap", thinkingLevels: ["off"] },
          ],
        },
      });
    if (path === "/api/chats/1/input" && request.method() === "POST") {
      inputs.push(request.postDataJSON());
      await inputGate;
      return route.fulfill({ status: 202, json: { id: "admitted" } });
    }
    if (path === "/api/chats")
      return route.fulfill({
        json: { rootId: "1", chats: [{ id: "1", title: "Main", running: false }] },
      });
    if (path === "/api/chats/1/tangents")
      return route.fulfill({
        json: {
          tangents: [tangent(2, "Running child", "running"), tangent(3, "Idle child", "idle")],
        },
      });
    const templateMatch = /^\/api\/chats\/(1|3)\/templates(?:\/([a-f0-9]+))?$/.exec(path);
    if (templateMatch) {
      const id = templateMatch[1]!;
      const template = {
        id: "a".repeat(64),
        fingerprint: "b".repeat(64),
        name: "example",
        path: "/example/.pi/prompts/example.md",
        truncated: false,
      };
      return route.fulfill({
        json: templateMatch[2]
          ? { conversationId: id, template, text: `Template ${id}` }
          : { conversationId: id, templates: [template], issues: [], omitted: 0 },
      });
    }
    if (path.endsWith("/questions"))
      return route.fulfill({
        json: {
          conversationId: path.split("/")[3],
          questions: path.includes("/3/")
            ? [
                {
                  questionId: "q-9",
                  taskId: 9,
                  revision: 1,
                  status: "pending",
                  actionable: true,
                  cancelled: false,
                  spec: {
                    message: "Child question",
                    fields: [{ id: "answer", kind: "text", label: "Answer", required: true }],
                  },
                },
              ]
            : [],
        },
      });
    if (path.endsWith("/workers")) {
      const id = path.split("/")[3];
      return route.fulfill({
        json: {
          hasUnsettled: true,
          helpers: [
            {
              requestId: `request-${id}`,
              taskId: `task-${id}`,
              childId: null,
              mode: "background",
              model: { provider: "test", modelId: `worker-${id}` },
              modelName: `Worker model ${id}`,
              stop: id === "2" && stopRequested ? "requested" : "none",
              status: id === "1" ? "unknown" : "running",
              answerEntryId: null,
              delivery: "notify-only",
            },
          ],
        },
      });
    }
    if (path === "/api/chats/2/workers/task-2/stop") {
      stopRequested = true;
      return route.fulfill({ status: 202, json: { status: "requested" } });
    }
    if (path === "/api/chats/2/workers/task-2/result")
      return route.fulfill({
        json: {
          taskId: "task-2",
          childId: "20",
          answerEntryId: "5",
          text: "Review this result",
          truncated: false,
          review: "unreviewed",
        },
      });
    if (path.endsWith("/attachments") && request.method() === "POST")
      return route.fulfill({
        status: 201,
        json: {
          id: ids[upload++],
          mimeType: "image/png",
          size: png.length,
          prepared: { mimeType: "image/png", changed: false, resized: false, converted: false },
        },
      });
    if (path.includes("/attachments/"))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    return route.abort();
  });
  await syntheticDrafts(page);
  await page.goto("/chats/1?tangent=3");
  const main = page.getByRole("region", { name: "Main chat: Main" });
  const child = page.getByRole("region", { name: "Tangent chat: Idle child" });
  for (const [scope, id] of [
    [main, "1"],
    [child, "3"],
  ] as const) {
    const box = scope.getByRole("textbox", { name: "Message input" });
    await addFile(page, scope, `scope-${id}.png`);
    await box.fill(`Draft ${id} /`);
    await scope.getByRole("option", { name: /templates/i }).click();
    await page.getByRole("option", { name: /example/ }).click();
    await page.getByRole("button", { name: "Append to draft" }).click();
    await expect(box).toHaveValue(`Draft ${id} \nTemplate ${id}`);
    await expect.poll(() => saved[id]).toContain(`Draft ${id} \nTemplate ${id}`);
    await expect(scope.getByRole("button", { name: `Remove scope-${id}.png` })).toBeVisible();
  }
  await child
    .getByRole("button", { name: "2 tool calls", exact: true })
    .last()
    .click({ timeout: 5000 });
  await child.getByRole("button", { name: /Used tool.*display_table/ }).click({ timeout: 5000 });
  await child.getByRole("button", { name: /Used tool.*edit/ }).click({ timeout: 5000 });
  await expect(child.locator('[data-slot="data-table"]')).toContainText("row");
  await expect(child.locator('[data-slot="code-diff"]')).toContainText("after");
  expect(requests.filter((r) => r.includes("/templates"))).toEqual(
    expect.arrayContaining(["GET /api/chats/1/templates", "GET /api/chats/3/templates"]),
  );
  expect(inputs).toHaveLength(0);
});
