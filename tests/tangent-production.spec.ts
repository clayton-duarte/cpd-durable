import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

async function addFile(page: Page, scope: ReturnType<Page["locator"]>, name: string) {
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "Add Attachment" }).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer: png });
  await expect(scope.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}

test("production route keeps native chats and drafts through tangent navigation", async ({
  page,
}) => {
  const requests: string[] = [];
  let upload = 0;
  let stopRequested = false;
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
      return route.fulfill({ json: { conversationId: path.split("/")[3], questions: [] } });
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
  await expect(main.getByText(/unknown · Worker model 1/)).toBeVisible();
  await expect(side.getByText(/running · Worker model 2/)).toBeVisible();
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
  await page.route("**/api/chats/1/tangents", (route) => route.fulfill({ status: 503 }));
  await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Tangent chat: Idle child" })).toBeVisible();
  await page.unroute("**/api/chats/1/tangents");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeEnabled();
  await expect.poll(() => requests.includes("GET /api/model-policy")).toBe(true);
  await input(main).fill("/ Explore the architecture");
  await input(main).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 1));
  await input(main).press("ArrowLeft");
  await input(main).press("ArrowRight");
  const palette = main.locator('[data-slot="composer-trigger-popover"]');
  await expect(palette.getByRole("option", { name: /\/tangent/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /\/side/ })).toBeVisible();
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
  await expect(unstartedPane.getByRole("textbox", { name: "Initial handoff" })).toHaveValue(
    /Investigate/,
  );
  await input(unstartedPane).fill("keep this draft");
  await expect(unstartedPane.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(starts).toEqual([]);
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
  await unstartedPane.getByRole("button", { name: "Conclude tangent" }).click();
  await expect(page.getByRole("alert")).toContainText("work is still active");
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  await unstartedPane.getByRole("button", { name: "Conclude tangent" }).click();
  await expect(unstartedPane.getByText("Lifecycle: concluded")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tangent: Idle child" })).toHaveCount(0);
  await unstartedPane.getByRole("button", { name: "Close tangent" }).click();
  expect(lifecycleRequests).toHaveLength(2);
  await page.getByRole("button", { name: "Completed and archived tangents" }).click();
  await page.getByRole("button", { name: /Idle child · Concluded/ }).click();
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  await unstartedPane.getByRole("button", { name: "Reopen tangent" }).click();
  await expect(unstartedPane.getByText("Lifecycle: open")).toBeVisible();
  await unstartedPane.getByRole("button", { name: "Archive tangent" }).click();
  await expect(page.getByRole("alert")).toContainText("work is still active");
  await expect(input(unstartedPane)).toHaveValue("keep this draft");
  let placed = false;
  let accepted = false;
  let acceptCount = 0;
  let wrongRevision = true;
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
      delivery: "admitted",
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
          admitted: true,
          placed,
          submissionStatus: "queued",
          accepted,
        },
      })
      .catch(() => {});
  });
  await page.route("**/api/chats/1/tangents/3/accept", (route) => {
    acceptCount++;
    if (acceptCount === 1) return route.fulfill({ status: 409, json: { error: "Changed" } });
    accepted = true;
    return route.fulfill({ json: { revision: 2, accepted: true } });
  });
  const report = unstartedPane.getByRole("region", { name: "Return report revision 2" });
  const preview = report.getByRole("textbox", { name: "Return handoff for review" });
  await expect(preview).toBeVisible();
  expect(JSON.parse(await preview.inputValue())).toMatchObject({
    goal: unsafe,
    evidence: "Synthetic evidence",
    limits: "Synthetic limits",
  });
  expect(await page.evaluate(() => Reflect.has(window, "__unsafe"))).toBe(false);
  await expect(report.getByRole("alert")).toContainText("Return status unavailable");
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeDisabled();
  wrongRevision = false;
  await expect(report.getByText("Admitted; not yet placed")).toBeVisible();
  await expect(report.getByRole("button", { name: "Accept reviewed return" })).toBeDisabled();
  await expect(unstartedPane.getByText("Lifecycle: open")).toBeVisible();
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
