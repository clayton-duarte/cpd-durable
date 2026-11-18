import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import {
  AttachmentIdSchema,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_PIXELS,
  IMAGE_PREPARED_BASE64_MAX,
  ImageInputSchema,
  ImageMimeSchema,
  type ImageReference,
} from "../shared/attachments.ts";

export class AttachmentError extends Error {}
const invalid = (): never => {
  throw new AttachmentError("Invalid or unsupported image.");
};
type ImageMime = ImageReference["mimeType"];
export const IMAGE_PREPARATION_LIMITS = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: IMAGE_PREPARED_BASE64_MAX,
} as const;

/** Inspect headers before the SDK decodes: this is an allocation guard, not a decoder or sandbox.
 * Only PNG and JPEG are advertised. The SDK performs actual decode and orientation. */
function dimensions(bytes: Buffer, mime: ImageMime): { width: number; height: number } {
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) return invalid();
  if (mime === "image/png") {
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(8) !== 13
    )
      return invalid();
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos++] !== 0xff) return invalid();
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00)
      return invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) return invalid();
    const len = bytes.readUInt16BE(pos);
    if (len < 2 || pos + len > bytes.length) return invalid();
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (len < 8) return invalid();
      return { height: bytes.readUInt16BE(pos + 3), width: bytes.readUInt16BE(pos + 5) };
    }
    pos += len;
  }
  return invalid();
}
function sniff(bytes: Buffer): ImageMime {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 137 && bytes[1] === 80) return "image/png";
  return invalid();
}
export async function prepareImage(
  processor: ImageProcessor,
  bytes: Uint8Array,
  mimeType: string,
): Promise<PreparedImage> {
  const mime = ImageMimeSchema.safeParse(mimeType);
  if (!mime.success) return invalid();
  const b = Buffer.from(bytes);
  const { width, height } = dimensions(b, mime.data);
  if (
    !width ||
    !height ||
    width > IMAGE_MAX_DIMENSION ||
    height > IMAGE_MAX_DIMENSION ||
    width * height > IMAGE_MAX_PIXELS
  )
    return invalid();
  // Buffer.slice() shares pooled memory; the SDK worker transfers Uint8Array.slice().
  const prepared = await processor.prepare(Uint8Array.from(b), mime.data, IMAGE_PREPARATION_LIMITS);
  if (
    !prepared ||
    !ImageMimeSchema.safeParse(prepared.mimeType).success ||
    prepared.data.length > IMAGE_PREPARED_BASE64_MAX
  )
    return invalid();
  return prepared;
}

/** Bindings belong to the caller's durable conversation doc/catalog, not another transcript DB.
 * Pending refs are draft-scoped and must not be copied to forks. Saved history is authorized
 * using the requesting conversation's SDK view, not an originating-chat assumption.
 * Original files and saved SDK model content are retained; draft removal and catalog
 * tombstones do not delete them. No automatic deletion is implemented. */
export interface AttachmentAuthorization {
  bindPending(id: string): Promise<void>;
  canReadPending(id: string): Promise<boolean>;
}
export function createAttachmentService(
  root: string,
  authorization: AttachmentAuthorization,
  processor: ImageProcessor,
) {
  const directory = join(root, "attachments");
  const pathFor = (id: string) => join(directory, AttachmentIdSchema.parse(id));
  return {
    async upload(mimeType: string, bytes: Uint8Array): Promise<ImageReference> {
      const prepared = await prepareImage(processor, bytes, mimeType);
      const mime = ImageMimeSchema.parse(mimeType);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const file = await open(pathFor(id), "wx", 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      // Binding failure leaves a retained orphan, not an actionable reference.
      await authorization.bindPending(id);
      return {
        id,
        mimeType: mime,
        size: bytes.length,
        prepared: {
          mimeType: ImageMimeSchema.parse(prepared.mimeType),
          changed: prepared.data !== Buffer.from(bytes).toString("base64"),
          resized: !!prepared.resized,
          converted: !!prepared.convertedFrom,
        },
      };
    },
    async readPending(id: string): Promise<Buffer> {
      AttachmentIdSchema.parse(id);
      if (!(await authorization.canReadPending(id))) throw new AttachmentError("Image not found.");
      return readFile(pathFor(id));
    },
    async input(
      value: unknown,
      model: { input: readonly string[] } | null,
    ): Promise<(TextContent | ImageContent)[]> {
      const input = ImageInputSchema.parse(value);
      if (input.images.length && !model?.input.includes("image"))
        throw new AttachmentError("The selected model does not support images.");
      const parts: (TextContent | ImageContent)[] = input.text
        ? [{ type: "text", text: input.text }]
        : [];
      for (const id of input.images) {
        const bytes = await this.readPending(id);
        const prepared = await prepareImage(processor, bytes, sniff(bytes));
        parts.push({ type: "image", mimeType: prepared.mimeType, data: prepared.data });
      }
      return parts;
    },
  };
}

/** Caller must resolve the part from the requesting conversation's authorized fork-aware SDK
 * history, never a client-provided payload or URL. Return the producer's exact bytes, not the
 * processor's transformed output. Bounds prevent an unbounded base64 allocation. */
export async function imageFromHistoryPart(
  processor: ImageProcessor,
  part: unknown,
): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
  if (
    !part ||
    typeof part !== "object" ||
    !("type" in part) ||
    part.type !== "image" ||
    !("mimeType" in part) ||
    !("data" in part) ||
    typeof part.data !== "string"
  )
    return invalid();
  const mime = ImageMimeSchema.safeParse(part.mimeType);
  if (!mime.success) return invalid();
  const data = part.data;
  if (
    data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return invalid();
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return invalid();
  await prepareImage(processor, bytes, mime.data);
  return { bytes, mimeType: mime.data };
}
