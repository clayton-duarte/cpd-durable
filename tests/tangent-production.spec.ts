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
});
