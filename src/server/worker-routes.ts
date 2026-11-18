import { Hono } from "hono";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  collectHelperResult,
  inspectHelpers,
  launchHelper,
  type WorkerDependencies,
} from "./helpers.ts";

export type WorkerRouteScope = { conversation: Conversation; policy: WorkerDependencies };
export type WorkerRoutesDependencies = {
  harness: Harness;
  resolve(id: string): Promise<WorkerRouteScope | undefined>;
  assertReadable(tx: Tx, id: ConversationId): Promise<void>;
  modelName?(provider: string, modelId: string): string | undefined;
};

/** Mount on a Hono app with the normal host/origin and request-size protections. */
export function createWorkerRoutes(deps: WorkerRoutesDependencies) {
  const routes = new Hono();
  const id = /^[1-9]\d{0,19}$/;
  async function scope(chatId: string) {
    if (!id.test(chatId)) return undefined;
    return deps.resolve(chatId);
  }
  async function readable(parent: Conversation) {
    await parent.commit((tx) => deps.assertReadable(tx, parent.id), BACKGROUND_CONTEXT);
  }
  routes.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid worker request." }, 400);
    const status =
      "status" in error && (error.status === 404 || error.status === 409) ? error.status : 409;
    return c.json(
      {
        error:
          status === 404
            ? "Chat not found."
            : "Worker operation unavailable. Check settings and chat state.",
      },
      status,
    );
  });
  routes.get("/api/chats/:chatId/workers", async (c) => {
    const found = await scope(c.req.param("chatId"));
    if (!found) return c.json({ error: "Chat not found." }, 404);
    await readable(found.conversation);
    const view = await inspectHelpers(deps.harness, found.conversation);
    return c.json({
      ...view,
      helpers: view.helpers.map((helper) => ({
        ...helper,
        modelName: helper.model
          ? (deps.modelName?.(helper.model.provider, helper.model.modelId) ?? null)
          : null,
      })),
    });
  });
  routes.post("/api/chats/:chatId/workers", async (c) => {
    const found = await scope(c.req.param("chatId"));
    if (!found) return c.json({ error: "Chat not found." }, 404);
    const body: unknown = await c.req.json();
    const taskId = await launchHelper(found.conversation, body, found.policy);
    return c.json({ taskId, status: "admitted" }, 202);
  });
  routes.get("/api/chats/:chatId/workers/:taskId/result", async (c) => {
    const found = await scope(c.req.param("chatId"));
    if (!found || !id.test(c.req.param("taskId")))
      return c.json({ error: "Worker not found." }, 404);
    await readable(found.conversation);
    const result = await collectHelperResult(
      deps.harness,
      found.conversation,
      c.req.param("taskId"),
    );
    return result ? c.json(result) : c.json({ error: "Worker result unavailable." }, 404);
  });
  return routes;
}
