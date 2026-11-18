import { type Conversation, type Harness } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { z } from "zod";
import {
  createHandoffService,
  deliverHandoff,
  HandoffHeadChanged,
  type HandoffGuards,
} from "./handoffs.ts";

export function createHandoffRoutes(options: {
  harness: Harness;
  guards: HandoffGuards;
  resolve(id: string): Promise<Conversation | undefined>;
}) {
  const routes = new Hono();
  const query = z.strictObject({
    parentId: z.coerce.number().int().positive().safe(),
    childId: z.coerce.number().int().positive().safe(),
    assignmentId: z.string().min(1).max(128),
  });
  async function service(id: string) {
    if (!/^[1-9]\d{0,15}$/.test(id)) return undefined;
    const actor = await options.resolve(id);
    return actor ? createHandoffService(options.harness, actor, options.guards) : undefined;
  }
  routes.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid handoff request." }, 400);
    if (error instanceof HandoffHeadChanged)
      return c.json(
        {
          error:
            "Context changed. Review and explicitly acknowledge the current context before delivery.",
          currentParentHead: error.parentHead,
          currentChildHead: error.childHead,
        },
        409,
      );
    const status = "status" in error && error.status === 404 ? 404 : 409;
    return c.json(
      {
        error:
          status === 404
            ? "Handoff unavailable."
            : "Handoff unavailable or changed. Refresh and retry.",
      },
      status,
    );
  });
  routes.get("/api/chats/:chatId/handoffs", async (c) => {
    const actor = await service(c.req.param("chatId"));
    if (!actor) return c.json({ error: "Chat not found." }, 404);
    const input = query.parse(c.req.query());
    return c.json({ records: await actor.list(input.parentId, input.childId, input.assignmentId) });
  });
  routes.post("/api/chats/:chatId/handoffs/:action", async (c) => {
    const id = c.req.param("chatId");
    const actor = await service(id);
    if (!actor) return c.json({ error: "Chat not found." }, 404);
    const action = c.req.param("action");
    if (action === "deliver") {
      const conversation = await options.resolve(id);
      if (!conversation) return c.json({ error: "Chat not found." }, 404);
      const input: unknown = await c.req.json();
      return c.json(
        await deliverHandoff(options.harness, conversation, options.guards, input),
        202,
      );
    }
    const input: unknown = await c.req.json();
    if (action === "record") return c.json(await actor.record(input), 201);
    if (action === "collect") return c.json(await actor.collect(input));
    if (action === "review") return c.json(await actor.review(input));
    return c.json({ error: "Handoff action not found." }, 404);
  });
  return routes;
}
