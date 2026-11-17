import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationBusy, type Conversation } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { InputSchema } from "../shared/chat.ts";
import { present } from "./presentation.ts";

export function createApp(conversation: Conversation) {
  const app = new Hono();
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

  app.post("/api/input", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json")) {
      return c.json({ error: "Expected application/json." }, 415);
    }
    const result = InputSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid message." }, 400);
    try {
      const submission = await conversation.submit(
        {
          type: "input",
          content: result.data.text,
          requestId: result.data.requestId,
          whenBusy: "reject",
        },
        BACKGROUND_CONTEXT,
      );
      return c.json({ id: String(submission.id) }, 202);
    } catch (error) {
      if (error instanceof ConversationBusy) {
        return c.json({ error: "The conversation is busy." }, 409);
      }
      throw error;
    }
  });

  app.post("/api/stop", async (c) => {
    await conversation.abort(BACKGROUND_CONTEXT);
    return c.body(null, 204);
  });

  app.get("/api/events", (c) =>
    streamSSE(
      c,
      async (stream) => {
        const watch = await conversation.watch(BACKGROUND_CONTEXT);
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          stream.onAbort(() => {
            void watch.stop();
          });
          if (stream.aborted) return;
          await stream.writeSSE({ event: "state", data: JSON.stringify(present(watch.value)) });
          watch.start(async (call) => {
            if (call.kind === "value") {
              await stream.writeSSE({ event: "state", data: JSON.stringify(present(call.value)) });
            }
          });
          heartbeat = setInterval(() => {
            void stream.writeSSE({ event: "ping", data: "" }).catch(() => watch.stop());
          }, 15_000);
          await watch.closed;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          await watch.stop();
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
    ),
  );

  app.onError((_error, c) => c.json({ error: "Conversation unavailable. Try reconnecting." }, 503));
  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}
