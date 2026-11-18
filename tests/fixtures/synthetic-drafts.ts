import type { Page } from "@playwright/test";

/** Synthetic draft service for presentation fixtures; never contacts a host. */
export async function syntheticDrafts(page: Page) {
  const drafts = new Map<string, { revision: number; content: unknown }>();
  await page.route("**/api/chats/*/draft**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const chatId = path.split("/")[3]!;
    const current = drafts.get(chatId) ?? { revision: 0, content: { text: "", images: [] } };
    if (path.endsWith("/draft/attempts"))
      return route.fulfill({ json: { attempts: [], capped: false, nextCursor: null } });
    if (path.endsWith("/draft/attempt")) {
      const body = route.request().postDataJSON() as object;
      return route.fulfill({ json: { ...body, fingerprint: "a".repeat(64) } });
    }
    if (!path.endsWith("/draft")) return route.fulfill({ status: 404, json: {} });
    if (route.request().method() === "GET") return route.fulfill({ json: current });
    const body = route.request().postDataJSON() as { expectedRevision: number; content: unknown };
    if (body.expectedRevision !== current.revision) return route.fulfill({ status: 409, json: {} });
    const next = { revision: current.revision + 1, content: body.content };
    drafts.set(chatId, next);
    return route.fulfill({ json: next });
  });
}
