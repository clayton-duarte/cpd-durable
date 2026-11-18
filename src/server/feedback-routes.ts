import { Hono } from "hono";
import type { Conversation } from "@earendil-works/pi-durable";
import { z } from "zod";
import { changeFeedback, FeedbackError, readFeedback } from "./feedback.ts";

const id = /^[1-9]\d{0,15}$/;
const index = /^(?:0|[1-9]\d{0,15})$/;

export function createFeedbackRoutes(resolve: (id: string) => Promise<Conversation | undefined>) {
  const routes = new Hono();
  const base = "/api/chats/:chatId/feedback/:entryId/:modelIndex";
  async function scope(chatId: string, entryId: string, modelIndex: string) {
    if (!id.test(chatId) || !id.test(entryId) || !index.test(modelIndex)) return undefined;
    const conversation = await resolve(chatId);
    return conversation
      ? { conversation, target: { entryId: Number(entryId), modelIndex: Number(modelIndex) } }
      : undefined;
  }
  routes.onError((error, c) => {
    if (error instanceof FeedbackError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: "Invalid feedback request." }, 400);
    return c.json({ error: "Feedback unavailable." }, 409);
  });
  routes.get(base, async (c) => {
    const found = await scope(
      c.req.param("chatId"),
      c.req.param("entryId"),
      c.req.param("modelIndex"),
    );
    if (!found) return c.json({ error: "Feedback target unavailable." }, 404);
    return c.json(await readFeedback(found.conversation, found.target));
  });
  routes.post(base, async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const found = await scope(
      c.req.param("chatId"),
      c.req.param("entryId"),
      c.req.param("modelIndex"),
    );
    if (!found) return c.json({ error: "Feedback target unavailable." }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    return c.json(await changeFeedback(found.conversation, found.target, body));
  });
  return routes;
}
