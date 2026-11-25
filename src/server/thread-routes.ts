import { Hono } from "hono";
import { ZodError } from "zod";
import type { ConversationId, EntryId, Harness } from "@earendil-works/pi-durable";
import { ChatIdSchema } from "../shared/chats.ts";
import {
  CreateThreadSchema,
  ThreadListSchema,
  ThreadSourceResponseSchema,
} from "../shared/threads.ts";
import {
  ThreadExists,
  createMessageThread,
  listThreads,
  readThreadSource,
  threadView,
  type ThreadHooks,
} from "./threads.ts";
import { ChatLifecycleError } from "./chats.ts";
import { ModelPolicyError } from "./model-policy.ts";

class UnsupportedMedia extends Error {}

export function createThreadRoutes(harness: Harness, hooks: ThreadHooks) {
  const routes = new Hono();
  const id = (value: string | undefined) => Number(ChatIdSchema.parse(value)) as ConversationId;
  const entry = (value: string | undefined) => Number(ChatIdSchema.parse(value)) as EntryId;
  async function body(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new UnsupportedMedia();
    const value: unknown = await request.json().catch(() => {
      throw new ZodError([]);
    });
    return value;
  }
  const base = "/api/chats/:mainId/threads";
  // Listing never forks, admits input or starts a run.
  routes.get(base, async (c) => {
    const threads = await listThreads(harness, id(c.req.param("mainId")), hooks);
    return c.json(ThreadListSchema.parse({ threads }));
  });
  routes.get(`${base}/source/:entryId`, async (c) => {
    const source = await readThreadSource(
      harness,
      id(c.req.param("mainId")),
      entry(c.req.param("entryId")),
      hooks,
    );
    return c.json(ThreadSourceResponseSchema.parse({ source }));
  });
  routes.post(base, async (c) => {
    const parentId = id(c.req.param("mainId"));
    const request = CreateThreadSchema.parse(await body(c.req.raw));
    if (request.parentId !== String(parentId))
      return c.json({ error: "Thread source does not match the chat." }, 400);
    const created = await createMessageThread(harness, request, hooks);
    const thread = await threadView(harness, parentId, created.id as ConversationId, hooks);
    if (!thread) throw new Error("Created thread unavailable");
    return c.json({ thread, admitted: created.firstSubmissionId !== undefined }, 201);
  });
  routes.onError((error, c) =>
    error instanceof ThreadExists
      ? c.json({ error: error.message, existingThreadId: String(error.id) }, 409)
      : error instanceof UnsupportedMedia
        ? c.json({ error: "Expected application/json." }, 415)
        : error instanceof ZodError
          ? c.json({ error: "Invalid thread request." }, 400)
          : error instanceof ChatLifecycleError
            ? c.json({ error: error.message }, error.status)
            : error instanceof ModelPolicyError
              ? c.json({ error: error.message }, 409)
              : c.json({ error: "Thread request unavailable or changed." }, 409),
  );
  return routes;
}
