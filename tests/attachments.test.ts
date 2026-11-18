import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createAttachmentService,
  imageFromHistoryPart,
  validatePng,
} from "../src/server/attachments.ts";
import { createImageAttachmentAdapter } from "../src/client/attachment-adapter.ts";
import { IMAGE_MAX_BYTES } from "../src/shared/attachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cpd-attachment-test-"));
  roots.push(root);
  const ids = new Set<string>();
  const authorization = {
    bindPending: async (id: string) => {
      ids.add(id);
    },
    canReadPending: async (id: string) => ids.has(id),
  };
  return { root, ids, service: createAttachmentService(root, authorization), authorization };
}
describe("image transport foundations", () => {
  it("uploads, reopens and composes SDK image input; enforces conversation binding", async () => {
    const { root, service, authorization } = await setup();
    const ref = await service.upload("image/png", png);
    const reopened = createAttachmentService(root, authorization);
    const image = { type: "image", mimeType: "image/png", data: png.toString("base64") };
    expect(
      await reopened.input({ text: "", images: [ref.id] }, { input: ["text", "image"] }),
    ).toEqual([image]);
    expect(await reopened.input({ text: "hello", images: [ref.id] }, { input: ["image"] })).toEqual(
      [{ type: "text", text: "hello" }, image],
    );
    await expect(
      reopened.input({ text: "", images: [ref.id] }, { input: ["text"] }),
    ).rejects.toThrow();
    await expect(
      reopened.input({ text: "", images: [ref.id, ref.id] }, { input: ["image"] }),
    ).rejects.toThrow();
    await expect(
      createAttachmentService(root, {
        ...authorization,
        canReadPending: async () => false,
      }).readPending(ref.id),
    ).rejects.toThrow();
    await expect(reopened.readPending("../../secrets")).rejects.toThrow();
  });
  it("rejects MIME, corruption, oversized and noncanonical base64", async () => {
    const { service } = await setup();
    await expect(service.upload("image/jpeg", png)).rejects.toThrow();
    await expect(service.upload("image/png", Buffer.alloc(IMAGE_MAX_BYTES + 1))).rejects.toThrow();
    const bad = Buffer.from(png);
    bad[20] = bad[20]! ^ 1;
    expect(() => validatePng(bad)).toThrow();
    expect(() =>
      imageFromHistoryPart({ type: "image", mimeType: "image/png", data: "!!" }),
    ).toThrow();
  });
  it("returns actual SDK history image bytes without origin-chat assumptions", () => {
    const parts = [
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
      { type: "text", text: "after" },
    ];
    expect(imageFromHistoryPart(parts[1]).bytes).toEqual(png);
    expect(parts.map((p) => p.type)).toEqual(["text", "image", "text"]);
  });
  it("uses the same adapter for files from either source and retains immutable refs on send", async () => {
    const { service } = await setup();
    const adapter = createImageAttachmentAdapter({
      upload: async (file) => service.upload(file.type, new Uint8Array(await file.arrayBuffer())),
      previewUrl: (id) => `/api/chats/1/attachments/${id}`,
    });
    const file = new File([png], "image.png", { type: "image/png" });
    const a = await adapter.add({ file });
    if (Symbol.asyncIterator in a) throw new Error("unexpected generator");
    const sent = await adapter.send(a);
    expect(sent.id).toBe(a.id);
    expect(sent.content[0]).toEqual({ type: "image", image: `/api/chats/1/attachments/${a.id}` });
    await adapter.remove(a);
    expect(await service.readPending(a.id)).toEqual(png);
  });
});
