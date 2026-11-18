import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationBusy,
  ConversationIdle,
  ResetEntry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
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
import {
  ChatIdSchema,
  CreateChatSchema,
  ChatActionSchema,
  RenameChatSchema,
  ForkChatSchema,
} from "../shared/chats.ts";
import { ChatLifecycleError } from "./chats.ts";
import type { ChatScope } from "./chats.ts";
import { CompactSchema } from "../shared/context.ts";
import { ConfigurationChangeSchema } from "../shared/configuration.ts";
import {
  HistorySearchRequestSchema,
  HistoryExportRequestSchema,
  type TranscriptReport,
} from "../shared/history-operations.ts";
import { searchTranscripts } from "./search.ts";
import { exportTranscripts, transcriptExportJson, transcriptExportMarkdown } from "./export.ts";
import type { ResolveTranscript } from "./transcript-reader.ts";
import {
  admissionDigest,
  AdmissionIdentityError,
  imageRequestDigest,
} from "./attachment-catalog.ts";
import { AttachmentAccessError } from "./attachment-routes.ts";
import { AttachmentError, AttachmentNotFound } from "./attachments.ts";
import { QuestionAnswerSchema } from "../shared/questions.ts";
import { answerQuestion, questionProjection } from "./question-routes.ts";
import { BranchIdentityError } from "./branch-identity.ts";
import { RegenerationError } from "./regeneration.ts";
import { RegenerationRequestSchema, RecentRegenerationsSchema } from "../shared/regeneration.ts";
import { BranchOperationError } from "./branch-operations.ts";
import {
  EditBranchRequestSchema,
  RecentEditOperationsSchema,
} from "../shared/branch-operations.ts";

export function createApp(
  chat: Pick<Awaited<ReturnType<typeof openChat>>, "conversation" | "withdraw"> &
    Partial<Pick<Awaited<ReturnType<typeof openChat>>, "chats" | "attachments">>,
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
  const jsonLimit = bodyLimit({
    maxSize: 128_000,
    onError: (c) => c.json({ error: "Request too large." }, 413),
  });
  const limitRequests = createMiddleware((c, next) =>
    c.req.method === "POST" && /^\/api\/chats\/[1-9]\d*\/attachments$/.test(c.req.path)
      ? next()
      : jsonLimit(c, next),
  );
  app.use("/api/*", limitRequests);
  if (chat.attachments) app.route("/", chat.attachments.routes);

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
  // These POST endpoints are read-only: no submission, task admission, or transcript writes.
  // The explicit allowlist is checked against the catalog before resolving any conversation.
  async function authorizedResolver(ids: string[]): Promise<ResolveTranscript | undefined> {
    const chats = chat.chats;
    if (!chats) return undefined;
    const catalog = await chats.list();
    if (ids.some((id) => !catalog.chats.some((item) => item.id === id))) return undefined;
    return async (id) => {
      if (!ids.includes(id)) return undefined;
      const resolved = await chats.resolve(id);
      return resolved && { conversation: resolved.conversation, archived: resolved.archived };
    };
  }
  // Catalog membership can change while a bounded scan is running. Refuse to
  // publish its result if a selected chat was deleted or changed archive state.
  async function stillAuthorized(report: TranscriptReport): Promise<boolean> {
    if (!chat.chats) return false;
    const catalog = await chat.chats.list();
    return report.conversations.every((item) => {
      const current = catalog.chats.find((entry) => entry.id === item.conversationId);
      return (
        current !== undefined &&
        (current.status === "archived") === item.archived &&
        (report.scope.includeArchived || current.status !== "archived")
      );
    });
  }
  app.post("/api/history-operations/search", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const request = HistorySearchRequestSchema.safeParse(
      await c.req.json<unknown>().catch(() => null),
    );
    if (!request.success) return c.json({ error: "Invalid history search." }, 400);
    const resolver = await authorizedResolver(request.data.scope.conversationIds);
    if (!resolver) return c.json({ error: "History scope unavailable." }, 404);
    const result = await searchTranscripts(request.data.scope, resolver, request.data.search, {
      signal: c.req.raw.signal,
    });
    if (!(await stillAuthorized(result.report)))
      return c.json({ error: "History scope changed. Refresh and try again." }, 409);
    return c.json(result);
  });
  app.post("/api/history-operations/export", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const request = HistoryExportRequestSchema.safeParse(
      await c.req.json<unknown>().catch(() => null),
    );
    if (!request.success) return c.json({ error: "Invalid history export." }, 400);
    const resolver = await authorizedResolver(request.data.scope.conversationIds);
    if (!resolver) return c.json({ error: "History scope unavailable." }, 404);
    const result = await exportTranscripts(request.data.scope, resolver, {
      signal: c.req.raw.signal,
    });
    if (!(await stillAuthorized(result.report)))
      return c.json({ error: "History scope changed. Refresh and try again." }, 409);
    return c.json({
      format: request.data.format,
      content:
        request.data.format === "json"
          ? transcriptExportJson(result)
          : transcriptExportMarkdown(result),
      report: result.report,
    });
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
  app.post("/api/chats/:chatId/rename", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const result = RenameChatSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!id.success || !result.success) return c.json({ error: "Invalid rename." }, 400);
    if (!chat.chats) return c.json({ error: "Chat catalog unavailable." }, 503);
    await chat.chats.rename(id.data, result.data.title, result.data.expected);
    return c.json(await chat.chats.list());
  });
  app.post("/api/chats/:chatId/fork", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const result = ForkChatSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!id.success || !result.success) return c.json({ error: "Invalid fork." }, 400);
    if (!chat.chats) return c.json({ error: "Chat catalog unavailable." }, 503);
    return c.json(await chat.chats.fork(id.data, result.data.requestId, result.data.at), 201);
  });
  app.get("/api/chats/:chatId/regeneration-eligibility/:entryId", async (c) => {
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const entry = ChatIdSchema.safeParse(c.req.param("entryId"));
    if (!id.success || !entry.success || !chat.chats)
      return c.json({ error: "Chat unavailable." }, 404);
    return c.json({ eligible: await chat.chats.canRegenerate(id.data, entry.data) });
  });
  app.get("/api/chats/:chatId/regenerations/:entryId", async (c) => {
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const entry = ChatIdSchema.safeParse(c.req.param("entryId"));
    if (!id.success || !entry.success || !chat.chats)
      return c.json({ error: "Chat unavailable." }, 404);
    return c.json(
      RecentRegenerationsSchema.parse(await chat.chats.recentRegenerations(id.data, entry.data)),
    );
  });
  app.post("/api/chats/:chatId/regenerate", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const request = RegenerationRequestSchema.safeParse(
      await c.req.json<unknown>().catch(() => null),
    );
    if (!id.success || !request.success || id.data !== request.data.sourceId)
      return c.json({ error: "Invalid regeneration request." }, 400);
    if (!chat.chats) return c.json({ error: "Chat unavailable." }, 503);
    return c.json(await chat.chats.regenerate(request.data), 202);
  });
  app.get("/api/chats/:chatId/edit-eligibility/:entryId", async (c) => {
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const at = ChatIdSchema.safeParse(c.req.param("entryId"));
    if (!id.success || !at.success || !chat.chats)
      return c.json({ error: "Chat unavailable." }, 404);
    return c.json({ eligible: await chat.chats.canEdit(id.data, at.data) });
  });
  app.get("/api/chats/:chatId/edit-operations/:entryId", async (c) => {
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const at = ChatIdSchema.safeParse(c.req.param("entryId"));
    if (!id.success || !at.success || !chat.chats)
      return c.json({ error: "Chat unavailable." }, 404);
    return c.json(
      RecentEditOperationsSchema.parse(await chat.chats.recentEditOperations(id.data, at.data)),
    );
  });
  app.post("/api/chats/:chatId/edit-branch", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const id = ChatIdSchema.safeParse(c.req.param("chatId"));
    const result = EditBranchRequestSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!id.success || !result.success || result.data.sourceId !== id.data)
      return c.json({ error: "Invalid edit request." }, 400);
    if (!chat.chats) return c.json({ error: "Chat unavailable." }, 503);
    return c.json(await chat.chats.editBranch(result.data), 202);
  });
  routes.use("*", async (c, next) => {
    const id = c.req.param("chatId");
    if (id !== undefined && !ChatIdSchema.safeParse(id).success)
      return c.json({ error: "Chat not found." }, 404);
    const scope =
      id === undefined && !chat.chats
        ? {
            conversation: chat.conversation,
            archived: false,
            assertWritable: async () => {},
            accounting: async () => {
              throw new Error("Accounting unavailable");
            },
            context: async () => {
              throw new Error("Context unavailable");
            },
            configuration: async () => {
              throw new Error("Configuration unavailable");
            },
            configure: async () => {
              throw new Error("Configuration unavailable");
            },
            withdraw: chat.withdraw,
            admit: async (_draft: Parameters<ChatScope["admit"]>[0]) => {
              throw new Error("Transactional admission unavailable.");
            },
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
      if (result.data.images?.length) {
        if (!chat.attachments) return c.json({ error: "Images unavailable." }, 503);
        return c.json(
          await chat.attachments.admit(String(c.get("scope").conversation.id), {
            ...result.data,
            images: result.data.images,
          }),
          202,
        );
      }
      const submission = await c.get("scope").admit(
        {
          type: "input",
          content: result.data.text,
          requestId: result.data.requestId,
          whenBusy: result.data.mode ?? "reject",
          ...(result.data.mode === "steer" ? { whenIdle: "reject" as const } : {}),
        },
        {
          digest: imageRequestDigest({
            text: result.data.text,
            images: [],
            mode: result.data.mode ?? "reject",
          }),
        },
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
  routes.get("/questions", async (c) => {
    if (c.req.param("chatId") === undefined) return c.json({ error: "Chat not found." }, 404);
    return c.json(await questionProjection(c.get("scope")));
  });
  routes.post("/questions/resolve", async (c) => {
    if (c.req.param("chatId") === undefined) return c.json({ error: "Chat not found." }, 404);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = QuestionAnswerSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid question answer." }, 400);
    return c.json({ status: await answerQuestion(c.get("scope"), result.data) });
  });
  routes.get("/accounting", async (c) => c.json(await c.get("scope").accounting()));
  routes.get("/context", async (c) => c.json(await c.get("scope").context()));
  routes.get("/configuration", async (c) => c.json(await c.get("scope").configuration()));
  routes.post("/configuration", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected application/json." }, 415);
    const result = ConfigurationChangeSchema.safeParse(
      await c.req.json<unknown>().catch(() => null),
    );
    if (!result.success) return c.json({ error: "Invalid configuration." }, 400);
    await c.get("scope").configure(result.data.expected, result.data.selection);
    return c.json(await c.get("scope").configuration());
  });
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
        {
          digest: admissionDigest([
            "control",
            control.type,
            control.type === "reset" ? control.handoff : null,
          ]),
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
    error instanceof ChatLifecycleError ||
    error instanceof AttachmentAccessError ||
    error instanceof RegenerationError ||
    error instanceof BranchOperationError
      ? c.json({ error: error.message }, error.status)
      : error instanceof AdmissionIdentityError || error instanceof BranchIdentityError
        ? c.json({ error: "Request ID does not match its original action." }, 409)
        : error instanceof AttachmentNotFound
          ? c.json({ error: "Image not found." }, 404)
          : error instanceof AttachmentError
            ? c.json({ error: error.message }, 400)
            : c.json({ error: "Conversation unavailable. Try reconnecting." }, 503),
  );
  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}
