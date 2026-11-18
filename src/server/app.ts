import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  ConversationIdle,
  ResetEntry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  ControlSchema,
  InputSchema,
  WithdrawSchema,
  HistoryQuerySchema,
  HistoryLoadSchema,
} from "../shared/chat.ts";
import { createHistory } from "./history.ts";
import type { openChat } from "./chat.ts";
import { ChatIdSchema, CreateChatSchema, ChatActionSchema } from "../shared/chats.ts";
import { ChatLifecycleError } from "./chats.ts";
import type { ChatScope } from "./chats.ts";
import { CompactSchema } from "../shared/context.ts";

export function createApp(
  chat: Pick<Awaited<ReturnType<typeof openChat>>, "conversation" | "withdraw"> &
    Partial<Pick<Awaited<ReturnType<typeof openChat>>, "chats">>,
) {
  const app = new Hono();
  const histories = new Map<string, ReturnType<typeof createHistory>>();
  const allowedHosts = new Set([
    "127.0.0.1:3000",
    "localhost:3000",
    "127.0.0.1:5173",
    "localhost:5173",
  ]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  app.use("*", async (c, next) => {
    if (!allowedHosts.has(c.req.header("host") ?? new URL(c.req.url).host)) {
      return c.json({ error: "Host not allowed." }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return c.json({ error: "Origin not allowed." }, 403);
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Cross-site request not allowed." }, 403);
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
    return;
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 128_000,
      onError: (c) => c.json({ error: "Request too large." }, 413),
    }),
  );

  app.get("/api/chats", async (c) => {
    if (!chat.chats) return c.json({ error: "Chat catalog unavailable." }, 503);
    return c.json(await chat.chats.list());
  });
  app.post("/api/chats", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = CreateChatSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid chat request." }, 400);
    if (!chat.chats) return c.json({ error: "Chat catalog unavailable." }, 503);
    return c.json(await chat.chats.create(result.data.requestId), 201);
  });
  app.post("/api/chats/:chatId/manage", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const action = ChatActionSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!id.success || !action.success) return c.json({ error: "Invalid chat action." }, 400);
    if (!chat.chats) return c.json({ error: "Chat catalog unavailable." }, 503);
    await chat.chats.change(id.data, action.data.action);
    return c.json(await chat.chats.list());
  });
  const routes = new Hono<{
    Variables: { scope: ChatScope; history: ReturnType<typeof createHistory> };
  }>();
  routes.use("*", async (c, next) => {
    const id = c.req.param("chatId");
    if (id !== undefined && !ChatIdSchema.safeParse(id).success)
      return c.json({ error: "Chat not found." }, 404);
    const scope =
      id === undefined && !chat.chats
        ? {
            conversation: chat.conversation,
            archived: false,
            accounting: async () => {
              throw new Error("Accounting unavailable");
            },
            context: async () => {
              throw new Error("Context unavailable");
            },
            withdraw: chat.withdraw,
            admit: (draft: Parameters<ChatScope["admit"]>[0]) =>
              chat.conversation.submit(draft, BACKGROUND_CONTEXT),
          }
        : await chat.chats?.resolve(id ?? String(chat.conversation.id));
    if (!scope) return c.json({ error: "Chat not found." }, 404);
    if (scope.archived && c.req.method !== "GET" && !c.req.path.endsWith("/history"))
      return c.json({ error: "Restore this archived chat before sending or changing it." }, 409);
    const key = String(scope.conversation.id);
    let history = histories.get(key);
    if (!history) {
      history = createHistory(scope.conversation);
      histories.set(key, history);
    }
    c.set("scope", scope);
    c.set("history", history);
    await next();
    return;
  });

  routes.post("/input", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json")) {
      return c.json({ error: "Expected application/json." }, 415);
    }
    const result = InputSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid message." }, 400);
    try {
      const submission = await c.get("scope").admit({
        type: "input",
        content: result.data.text,
        requestId: result.data.requestId,
        whenBusy: result.data.mode ?? "reject",
        ...(result.data.mode === "steer" ? { whenIdle: "reject" as const } : {}),
      });
      return c.json({ id: String(submission.id) }, 202);
    } catch (error) {
      if (error instanceof ConversationBusy) {
        return c.json({ error: "The conversation is busy." }, 409);
      }
      if (error instanceof ConversationIdle) {
        return c.json(
          { error: "The response has ended. Choose Send now or Send after current response." },
          409,
        );
      }
      throw error;
    }
  });
  routes.get("/accounting", async (c) => c.json(await c.get("scope").accounting()));
  routes.get("/context", async (c) => c.json(await c.get("scope").context()));
  routes.post("/compact", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = CompactSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid compaction request." }, 400);
    const taskId = await c
      .get("scope")
      .conversation.compact(result.data.instructions || undefined, BACKGROUND_CONTEXT);
    return c.json({ taskId: String(taskId) }, 202);
  });

  routes.post("/control", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = ControlSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid control." }, 400);
    const control = result.data;
    try {
      // Same public reset entry as Conversation.reset(), admitted with a request ID for safe retry.
      const submission = await c.get("scope").admit(
        control.type === "continue"
          ? control
          : {
              type: "write",
              requestId: control.requestId,
              entry: {
                kind: ResetEntry.kind,
                head: "self",
                ...(control.handoff
                  ? {
                      model: [
                        { role: "user" as const, content: control.handoff, timestamp: Date.now() },
                      ],
                    }
                  : {}),
              },
            },
      );
      return c.json({ id: String(submission.id) }, 202);
    } catch (error) {
      if (error instanceof ConversationBusy)
        return c.json({ error: "The conversation is busy." }, 409);
      throw error;
    }
  });

  routes.post("/withdraw", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = WithdrawSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid submission." }, 400);
    const status = await c.get("scope").withdraw(Number(result.data.id) as SubmissionId);
    return c.json({ status });
  });

  routes.post("/stop", async (c) => {
    await c.get("scope").conversation.abort(BACKGROUND_CONTEXT);
    return c.body(null, 204);
  });

  routes.post("/history", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = HistoryLoadSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid history request." }, 400);
    const loading = c.get("history").load(result.data.view, result.data.gap);
    if (!loading)
      return c.json({ error: "History view expired. Reconnect before loading history." }, 410);
    return c.json(await loading);
  });

  routes.get("/events", (c) => {
    const query = HistoryQuerySchema.safeParse({ view: randomUUID(), ...c.req.query() });
    if (!query.success) return c.json({ error: "Invalid history view." }, 400);
    return streamSSE(
      c,
      async (stream) => {
        let unsubscribe: (() => Promise<void>) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          stream.onAbort(() => {
            void unsubscribe?.().catch(() => {});
          });
          if (stream.aborted) return;
          const subscription = await c
            .get("history")
            .subscribe(
              query.data.view,
              (state) => stream.writeSSE({ event: "state", data: JSON.stringify(state) }),
              query.data.oldest,
            );
          unsubscribe = subscription.unsubscribe;
          if (stream.aborted) return;
          heartbeat = setInterval(() => {
            void stream
              .writeSSE({ event: "ping", data: "" })
              .catch(() => unsubscribe?.().catch(() => {}));
          }, 15_000);
          await Promise.race([
            subscription.closed,
            new Promise<void>((resolve) => stream.onAbort(resolve)),
          ]);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          await unsubscribe?.();
        }
      },
      async (_error, stream) => {
        // Stream errors bypass Hono's onError and must not leak SDK diagnostics.
        await stream
          .writeSSE({
            event: "unavailable",
            data: "Conversation unavailable. Reconnecting…",
          })
          .catch(() => {});
      },
    );
  });

  app.route("/api/chats/:chatId", routes);
  app.route("/api", routes);
  app.onError((error, c) =>
    error instanceof ChatLifecycleError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Conversation unavailable. Try reconnecting." }, 503),
  );
  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}
