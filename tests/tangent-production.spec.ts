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
  expect(requests.filter((r) => /POST .*\/(input|stop)$/.test(r))).toEqual([]);
  await page.route("**/api/chats/1/tangents", (route) => route.fulfill({ status: 503 }));
  await expect(page.getByText("Tangents unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Tangent chat: Idle child" })).toBeVisible();
  await page.unroute("**/api/chats/1/tangents");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open tangent: Running child" })).toBeEnabled();
  await page.goto("/chats/1?tangent=999");
  await expect(page.getByText("Tangent not found", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /Tangent chat:/ })).toHaveCount(0);
  await page.goto("/chats/1?tangent=wrong");
  await expect(page.getByText("Tangent not found", { exact: true })).toBeVisible();
});
