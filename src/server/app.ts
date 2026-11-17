import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  ConversationIdle,
  ResetEntry,
  type ConversationView,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { ControlSchema, InputSchema, WithdrawSchema } from "../shared/chat.ts";
import { present } from "./presentation.ts";
import type { openChat } from "./chat.ts";

export function createApp({
  conversation,
  withdraw,
}: Pick<Awaited<ReturnType<typeof openChat>>, "conversation" | "withdraw">) {
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
          whenBusy: result.data.mode ?? "reject",
          ...(result.data.mode === "steer" ? { whenIdle: "reject" as const } : {}),
        },
        BACKGROUND_CONTEXT,
      );
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

  app.post("/api/control", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = ControlSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid control." }, 400);
    const control = result.data;
    try {
      // Same public reset entry as Conversation.reset(), admitted with a request ID for safe retry.
      const submission = await conversation.submit(
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
        BACKGROUND_CONTEXT,
      );
      return c.json({ id: String(submission.id) }, 202);
    } catch (error) {
      if (error instanceof ConversationBusy)
        return c.json({ error: "The conversation is busy." }, 409);
      throw error;
    }
  });

  app.post("/api/withdraw", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = WithdrawSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid submission." }, 400);
    const status = await withdraw(Number(result.data.id) as SubmissionId);
    return c.json({ status });
  });

  app.post("/api/stop", async (c) => {
    await conversation.abort(BACKGROUND_CONTEXT);
    return c.body(null, 204);
  });

  async function snapshot(view: ConversationView) {
    const state = present(view);
    if (!state.busy && state.controls && !state.controls.resetPending) {
      const context = await conversation.context(BACKGROUND_CONTEXT);
      const last = context.messages.findLast((message) => message.role !== "system");
      state.controls.canContinue = last?.role === "user" || last?.role === "toolResult";
    }
    return state;
  }

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
          await stream.writeSSE({
            event: "state",
            data: JSON.stringify(await snapshot(watch.value)),
          });
          watch.start(async (call) => {
            if (call.kind === "value") {
              await stream.writeSSE({
                event: "state",
                data: JSON.stringify(await snapshot(call.value)),
              });
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
