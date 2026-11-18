import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  AttachmentIdSchema,
  IMAGE_MAX_BYTES,
  ImageInputSchema,
  type ImageReference,
} from "../shared/attachments.ts";

export class AttachmentError extends Error {}
const invalid = (): never => {
  throw new AttachmentError("Invalid or unsupported PNG image.");
};
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG structural and compressed scanline validation; no transcoding or metadata stripping. */
export function validatePng(bytes: Uint8Array): void {
  const b = Buffer.from(bytes);
  if (b.length > IMAGE_MAX_BYTES || b.length < 45 || !b.subarray(0, 8).equals(signature)) invalid();
  let pos = 8,
    width = 0,
    height = 0,
    rowBytes = 0,
    ended = false,
    sawData = false,
    dataEnded = false,
    palette = false,
    colorType = -1,
    bitDepth = 0;
  const chunks: Buffer[] = [];
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    if (len > b.length - pos - 12) invalid();
    const type = b.toString("ascii", pos + 4, pos + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    if (type[0] === type[0]?.toUpperCase() && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))
      invalid();
    const payload = b.subarray(pos + 8, pos + 8 + len);
    if (crc32(b.subarray(pos + 4, pos + 8 + len)) !== b.readUInt32BE(pos + 8 + len)) invalid();
    if (pos === 8) {
      if (type !== "IHDR" || len !== 13) invalid();
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      const depth = payload[8]!,
        color = payload[9]!;
      colorType = color;
      bitDepth = depth;
      const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        !depths[color]?.includes(depth) ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        invalid();
      rowBytes = Math.ceil((width * channels[color]! * depth) / 8);
      if ((rowBytes + 1) * height > 64 * 1024 * 1024) invalid();
    } else if (type === "IHDR") invalid();
    if (type === "PLTE") {
      if (palette || sawData || colorType === 0 || colorType === 4 || !len || len % 3 || len > 768)
        invalid();
      if (colorType === 3 && len / 3 > 2 ** bitDepth) invalid();
      palette = true;
    }
    if (type === "IDAT") {
      if (dataEnded || (colorType === 3 && !palette)) invalid();
      sawData = true;
      chunks.push(payload);
    } else if (sawData && type !== "IEND") dataEnded = true;
    if (type === "IEND") {
      if (len !== 0 || !sawData || pos + 12 !== b.length) invalid();
      ended = true;
      break;
    }
    pos += len + 12;
  }
  if (!ended) invalid();
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (rowBytes + 1) * height });
  } catch {
    return invalid();
  }
  if (raw.length !== (rowBytes + 1) * height) invalid();
  for (let y = 0; y < height; y++) if (raw[y * (rowBytes + 1)]! > 4) invalid();
}

/** The caller's durable conversation doc/catalog owns bindings; no local transcript or catalog is created.
 * A pending ref must be bound only to its originating draft. Forks must not inherit pending refs.
 * Saved-message access must be authorized via the requesting conversation's SDK history, including inherited entries.
 * Bytes are retained indefinitely: neither removal from a draft nor a catalog tombstone deletes them. */
export interface AttachmentAuthorization {
  bindPending(id: string): Promise<void>;
  canReadPending(id: string): Promise<boolean>;
}
export function createAttachmentService(root: string, authorization: AttachmentAuthorization) {
  const directory = join(root, "attachments");
  const pathFor = (id: string) => join(directory, AttachmentIdSchema.parse(id));
  return {
    async upload(mimeType: string, bytes: Uint8Array): Promise<ImageReference> {
      if (mimeType !== "image/png") throw new AttachmentError("Only PNG images are supported.");
      validatePng(bytes);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const file = await open(pathFor(id), "wx", 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      // A failed binding leaves an unreferenced retained file, never an actionable ref.
      await authorization.bindPending(id);
      return { id, mimeType: "image/png", size: bytes.length };
    },
    async readPending(id: string): Promise<Buffer> {
      AttachmentIdSchema.parse(id);
      if (!(await authorization.canReadPending(id))) throw new AttachmentError("Image not found.");
      const bytes = await readFile(pathFor(id));
      validatePng(bytes);
      return bytes;
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
      for (const id of input.images)
        parts.push({
          type: "image",
          mimeType: "image/png",
          data: (await this.readPending(id)).toString("base64"),
        });
      return parts;
    },
  };
}

/** Resolve from an already authorized SDK history entry, never a client-supplied payload or URL.
 * Use entry/model/content indices checked against the current conversation's inherited SDK view. */
export function imageFromHistoryPart(part: unknown): { bytes: Buffer; mimeType: "image/png" } {
  if (
    !part ||
    typeof part !== "object" ||
    !("type" in part) ||
    part.type !== "image" ||
    !("mimeType" in part) ||
    part.mimeType !== "image/png" ||
    !("data" in part) ||
    typeof part.data !== "string"
  )
    return invalid();
  const data = part.data;
  if (
    data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return invalid();
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return invalid();
  validatePng(bytes);
  return { bytes, mimeType: "image/png" };
}
