import { Hono } from "hono";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  EntryId,
  Harness,
  SubmissionDraft,
  Tx,
} from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import {
  AttachmentIdSchema,
  IMAGE_MAX_BYTES,
  ImageInputSchema,
  ImageMimeSchema,
  SavedImageReferenceSchema,
} from "../shared/attachments.ts";
import { AttachmentError, createAttachmentService, imageFromHistoryPart } from "./attachments.ts";
import type { createPendingImageCatalog } from "./attachment-catalog.ts";
import { imageRequestDigest } from "./attachment-catalog.ts";

export class AttachmentAccessError extends Error {
  readonly status: 404 | 409;
  constructor(status: 404 | 409) {
    super(status === 404 ? "Chat not found." : "Chat is archived.");
    this.status = status;
  }
}
export type AttachmentScope = {
  conversation: Conversation;
  archived: boolean;
  /** Check lifecycle against the chat catalog inside the given SDK transaction;
   * throw AttachmentAccessError(404) for missing/deleted, (409) for archived. */
  assertWritable(tx: Tx): Promise<void>;
};
export type ResolvedImageModel = { key: string; input: readonly string[] };
export type ImageAdmission = Extract<SubmissionDraft, { type: "input" }>;
export type AttachmentBackendOptions = {
  harness: Harness;
  root: string;
  processor: ImageProcessor;
  /** Must reject deleted/missing/inaccessible chats, including catalog tombstones. */
  resolve(chatId: string): Promise<AttachmentScope | undefined>;
  catalog(harness: Harness, scope: AttachmentScope): ReturnType<typeof createPendingImageCatalog>;
  /** Resolve from server-owned effective configuration, never the request body. */
  model(scope: AttachmentScope): Promise<ResolvedImageModel | null>;
  /** Must atomically recheck lifecycle and model key when admitting, using the host's existing
   * admission transaction. The callback owns SDK idempotency: never create a submission directly.
   * Do not retire refs on uncertain admission; retry the same request and refs unchanged. */
  admit(
    scope: AttachmentScope,
    draft: ImageAdmission,
    expectedModelKey: string | null,
    digest: string,
  ): Promise<{ id: string }>;
};
const RequestSchema = z.strictObject({
  text: z.string(),
  images: z.array(AttachmentIdSchema),
  requestId: z.uuid(),
  mode: z.enum(["reject", "followUp", "steer"]).optional(),
});
const chatId = /^[1-9]\d*$/;
const coordinate = /^(?:0|[1-9]\d*)$/;

/** Read a capped raw body incrementally. No URL fetching or multipart/file path interpretation. */
async function readUpload(request: Request): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > IMAGE_MAX_BYTES)) throw new RangeError();
  if (!request.body) throw new AttachmentError("Empty image.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new RangeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Mount behind the existing Host/Origin/sec-fetch/no-store middleware. The parent's 128 KB
 * JSON limiter must exclude only POST .../attachments; this handler applies its own 5 MiB cap. */
export function createAttachmentBackend(options: AttachmentBackendOptions) {
  const routes = new Hono();
  const resolve = async (id: string): Promise<AttachmentScope | undefined> => {
    if (!chatId.test(id) || !Number.isSafeInteger(Number(id))) return undefined;
    const scope = await options.resolve(id);
    return scope && String(scope.conversation.id) === id ? scope : undefined;
  };
  const catalog = (scope: AttachmentScope) => options.catalog(options.harness, scope);
  const service = (scope: AttachmentScope) =>
    createAttachmentService(options.root, catalog(scope).authorization, options.processor);
  routes.post("/api/chats/:chatId/attachments", async (c) => {
    const scope = await resolve(c.req.param("chatId"));
    if (!scope) return c.json({ error: "Not found." }, 404);
    if (scope.archived) return c.json({ error: "Restore this chat before uploading." }, 409);
    const mime = ImageMimeSchema.safeParse(c.req.header("content-type"));
    if (!mime.success) return c.json({ error: "Only PNG and JPEG images are supported." }, 415);
    try {
      return c.json(await service(scope).upload(mime.data, await readUpload(c.req.raw)), 201);
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: "Image too large." }, 413);
      if (error instanceof AttachmentError)
        return c.json({ error: "Invalid or unsupported image." }, 400);
      if (error instanceof AttachmentAccessError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
  routes.get("/api/chats/:chatId/attachments/:id", async (c) => {
    const scope = await resolve(c.req.param("chatId"));
    const id = AttachmentIdSchema.safeParse(c.req.param("id"));
    if (!scope || !id.success) return c.json({ error: "Not found." }, 404);
    const item = await catalog(scope).get(id.data);
    if (!item) return c.json({ error: "Not found." }, 404);
    try {
      const bytes = await service(scope).readPending(id.data);
      return new Response(Uint8Array.from(bytes), {
        headers: {
          "Content-Type": item.mimeType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    } catch {
      return c.json({ error: "Not found." }, 404);
    }
  });
  routes.get("/api/chats/:chatId/images/:entryId/:modelIndex/:partIndex", async (c) => {
    const scope = await resolve(c.req.param("chatId"));
    const values = [c.req.param("entryId"), c.req.param("modelIndex"), c.req.param("partIndex")];
    if (!scope || values.some((v) => !coordinate.test(v)))
      return c.json({ error: "Not found." }, 404);
    const ref = SavedImageReferenceSchema.safeParse({
      entryId: Number(values[0]),
      modelIndex: Number(values[1]),
      partIndex: Number(values[2]),
    });
    if (!ref.success) return c.json({ error: "Not found." }, 404);
    const entryId = ref.data.entryId as EntryId;
    const entries = await scope.conversation.entries(
      { minEntryId: entryId, maxEntryId: entryId },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const entry = entries.items[0];
    if (!entry || entry.id !== entryId || !["pi.user", "pi.tool-result"].includes(entry.kind))
      return c.json({ error: "Not found." }, 404);
    const message = entry.model?.[ref.data.modelIndex];
    if (
      !message ||
      !(
        (entry.kind === "pi.user" && message.role === "user") ||
        (entry.kind === "pi.tool-result" && message.role === "toolResult")
      ) ||
      !Array.isArray(message.content)
    )
      return c.json({ error: "Not found." }, 404);
    try {
      const image = await imageFromHistoryPart(
        options.processor,
        message.content[ref.data.partIndex],
      );
      return new Response(Uint8Array.from(image.bytes), {
        headers: {
          "Content-Type": image.mimeType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    } catch {
      return c.json({ error: "Not found." }, 404);
    }
  });
  return {
    routes,
    /** Called from the host input route; no separate draft authority or retry log. */
    async admit(chatId: string, raw: unknown) {
      const scope = await resolve(chatId);
      if (!scope) throw new AttachmentError("Chat not found.");
      if (scope.archived) throw new AttachmentError("Chat is archived.");
      const input = RequestSchema.parse(raw);
      const valid = ImageInputSchema.parse({ text: input.text, images: input.images });
      const model = await options.model(scope);
      const content = await service(scope).input({ text: input.text, images: input.images }, model);
      const draft: ImageAdmission = {
        type: "input",
        content,
        requestId: input.requestId,
        whenBusy: input.mode ?? "reject",
        ...(input.mode === "steer" ? { whenIdle: "reject" as const } : {}),
      };
      const digest = imageRequestDigest({ ...valid, mode: input.mode ?? "reject" });
      return options.admit(scope, draft, model?.key ?? null, digest);
    },
  };
}
