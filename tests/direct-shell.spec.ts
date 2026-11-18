import { test, expect } from "@playwright/test";

test("fresh double-prefix sends to shell and Stop targets its request", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  let request: { requestId: string; command: string; includeInContext: boolean } | undefined;
  let stopped = false;
  await page.route("**/api/chats/1/shell/stop", (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: request?.requestId });
    stopped = true;
    return route.fulfill({ json: { status: "marked" } });
  });
  await page.route("**/api/chats/1/shell**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/stop")) return route.fallback();
    if (route.request().method() === "POST") {
      request = route.request().postDataJSON() as typeof request;
      return route.fulfill({ json: { id: "7" }, status: 202 });
    }
    return route.fulfill({
      json:
        request && !stopped
          ? {
              ...request,
              conversationId: "1",
              taskId: "7",
              status: "running",
              output: "synthetic output",
              truncated: false,
            }
          : null,
    });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
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
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.fill("!!printf synthetic");
  await input.press("Enter");
  await expect.poll(() => request?.command).toBe("printf synthetic");
  expect(request?.includeInContext).toBe(false);
  await page.getByRole("button", { name: "1 tool call" }).click();
  await expect(page.getByRole("button", { name: /Running tool.*Direct shell/ })).toBeVisible();
  await page.getByRole("button", { name: /Running tool.*Direct shell/ }).click();
  await expect(page.getByText("synthetic output")).toBeVisible();
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect.poll(() => stopped).toBe(true);
});

test("uncertain shell retries the original identity without consuming a newer draft", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  const requests: unknown[] = [];
  await page.route("**/api/chats/1/shell**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: null });
    requests.push(route.request().postDataJSON());
    return requests.length === 1
      ? route.abort()
      : route.fulfill({ status: 202, json: { id: "5" } });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
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
  await page.goto("/chats/1");
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.fill("!printf one");
  await input.press("Enter");
  await expect(page.getByText("Delivery not confirmed")).toBeVisible();
  await input.fill("newer draft");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(input).toHaveValue("newer draft");
});

test("ignores a shell status from another chat", async ({ page }) => {
  let read = false;
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  await page.route("**/api/chats/1/shell**", (route) => {
    read = true;
    return route.fulfill({
      json: {
        conversationId: "2",
        taskId: "7",
        requestId: "11111111-1111-4111-8111-111111111111",
        command: "printf wrong",
        includeInContext: true,
        status: "running",
        output: "wrong chat",
        truncated: false,
      },
    });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
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
  await page.goto("/chats/1");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
  await expect.poll(() => read).toBe(true);
  await expect(page.getByText("wrong chat")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
});

test("a delayed old poll cannot replace a newer shell or change its Stop target", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: { rootId: "1", chats: [{ id: "1", title: "Original chat", running: false }] },
    }),
  );
  let release!: () => void;
  let started = false;
  let delivered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let request: { requestId: string; command: string; includeInContext: boolean } | undefined;
  let stopped: unknown;
  await page.route("**/api/chats/1/shell/stop", (route) => {
    stopped = route.request().postDataJSON();
    return route.fulfill({ json: { status: "marked" } });
  });
  await page.route("**/api/chats/1/shell**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stop")) return route.fallback();
    if (route.request().method() === "POST") {
      request = route.request().postDataJSON() as typeof request;
      return route.fulfill({ status: 202, json: { id: "22" } });
    }
    if (!url.searchParams.has("requestId")) {
      started = true;
      await gate;
      await route.fulfill({
        json: {
          conversationId: "1",
          taskId: "11",
          requestId: "11111111-1111-4111-8111-111111111111",
          command: "old",
          includeInContext: true,
          status: "running",
          output: "stale output",
          truncated: false,
        },
      });
      delivered = true;
      return;
    }
    return route.fulfill({
      json: {
        ...request,
        conversationId: "1",
        taskId: "22",
        status: "running",
        output: "new output",
        truncated: false,
      },
    });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId: 1,
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
  try {
    await page.goto("/chats/1");
    await expect.poll(() => started).toBe(true);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("!printf fresh");
    await input.press("Enter");
    await page.getByRole("button", { name: "1 tool call" }).click();
    await page.getByRole("button", { name: /Running tool.*Direct shell/ }).click();
    await expect(page.getByText("new output")).toBeVisible();
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(page.getByText("stale output")).toHaveCount(0);
    await expect(page.getByText("new output")).toBeVisible();
    await input.fill("unsent newer draft");
    await page.getByRole("button", { name: "Stop generating" }).click();
    await expect.poll(() => stopped).toEqual({ requestId: request?.requestId });
    await expect(input).toHaveValue("unsent newer draft");
  } finally {
    release();
  }
});

test("visible idle chat discovers remote shell tasks in succession and stops the selected one", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/chats/*/tangents", (route) => route.fulfill({ json: { tangents: [] } }));
  await page.route("**/api/chats/*/workers", (route) =>
    route.fulfill({ json: { helpers: [], hasUnsettled: false } }),
  );
  await page.route("**/api/chats", (route) =>
    route.fulfill({
      json: {
        rootId: "1",
        chats: [
          { id: "1", title: "Original chat", running: false },
          { id: "2", title: "Other chat", running: false },
        ],
      },
    }),
  );
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  let reads = 0;
  let remote: { requestId: string; taskId: string; command: string; output: string } | null = null;
  const stopped: unknown[] = [];
  await page.route("**/api/chats/1/shell/stop", (route) => {
    stopped.push(route.request().postDataJSON());
    remote = null;
    return route.fulfill({ json: { status: "marked" } });
  });
  await page.route("**/api/chats/1/shell**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/stop")) return route.fallback();
    reads++;
    return route.fulfill({
      json: remote
        ? {
            ...remote,
            conversationId: "1",
            includeInContext: false,
            status: "running",
            truncated: false,
          }
        : null,
    });
  });
  await page.addInitScript(() => {
    class Events extends EventTarget {
      constructor(url: string) {
        super();
        const conversationId = Number(
          new URL(url, location.href).pathname.match(/\/chats\/(\d+)\//)?.[1] ?? 1,
        );
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("state", {
              data: JSON.stringify({
                conversationId,
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
  await page.goto("/chats/1");
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  remote = { requestId: firstId, taskId: "11", command: "first", output: "first progress" };
  await expect(page.getByRole("button", { name: "1 tool call" })).toBeVisible();
  await page.getByRole("button", { name: "1 tool call" }).click();
  await page.getByRole("button", { name: /Running tool.*Direct shell/ }).click();
  await expect(page.getByText("first progress")).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect.poll(() => stopped).toEqual([{ requestId: firstId }]);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  remote = { requestId: secondId, taskId: "22", command: "second", output: "second progress" };
  await expect(page.getByRole("button", { name: "1 tool call" })).toBeVisible();
  await page.getByRole("button", { name: "1 tool call" }).click();
  await page.getByRole("button", { name: /Running tool.*Direct shell/ }).click();
  await expect(page.getByText("second progress")).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect.poll(() => stopped).toEqual([{ requestId: firstId }, { requestId: secondId }]);
  remote = {
    requestId: firstId,
    taskId: "33",
    command: "still running",
    output: "hidden progress",
  };
  await page.getByRole("button", { name: "Other chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
  const readsWhenHidden = reads;
  await page.waitForTimeout(2300);
  expect(reads).toBe(readsWhenHidden);
  expect(remote?.taskId).toBe("33");
});
