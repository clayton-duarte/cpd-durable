import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import {
  createAttachmentService,
  imageFromHistoryPart,
  prepareImage,
  IMAGE_PREPARATION_LIMITS,
} from "../src/server/attachments.ts";
import {
  createImageAttachmentAdapter,
  restoreDetachedImages,
} from "../src/client/attachment-adapter.ts";
import { IMAGE_MAX_BYTES } from "../src/shared/attachments.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const png = await readFile(new URL("./fixtures/attachments/sample.png", import.meta.url));
const jpeg = await readFile(new URL("./fixtures/attachments/sample.jpg", import.meta.url));
const processor = await createNodePhotonImages({ idleMs: 50 });
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
  return {
    root,
    ids,
    service: createAttachmentService(root, authorization, processor),
    authorization,
  };
}
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const n of b) {
    c ^= n;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function largePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2100, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    png.subarray(0, 8),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((2100 * 4 + 1) * 2))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function rotatedJpeg() {
  // EXIF orientation 6: a 16x8 source displays upright as 8x16.
  const exif = Buffer.from(
    "45786966000049492a0008000000010012010300010000000600000000000000",
    "hex",
  );
  const size = Buffer.alloc(2);
  size.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    size,
    exif,
    jpeg.subarray(2),
  ]);
}

describe("image transport foundations", () => {
  it("does not restore text or removed refs after an edit while native insertion promises settle", async () => {
    let revision = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { text: "", attachments: [] as { id: string }[] };
    const composer = {
      getState: () => state,
      addAttachment: (attachment: { id?: string }) => {
        state.attachments.push({ id: attachment.id! });
        revision++;
        return gate;
      },
      setText: (text: string) => {
        state.text = text;
        revision++;
      },
    };
    const source = ["a", "b"].map((id) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      status: { type: "complete" as const },
      content: [{ type: "image" as const, image: "/api/test" }],
    }));
    const restoring = restoreDetachedImages(composer, source, "original", revision, () => revision);
    expect(state.attachments.map((item) => item.id)).toEqual(["a", "b"]);
    state.attachments.splice(0, 1);
    revision++;
    state.attachments.push({ id: "new" });
    revision++;
    state.text = "new text";
    revision++;
    state.text = "";
    revision++;
    release();
    await restoring;
    expect(state).toEqual({ text: "", attachments: [{ id: "b" }, { id: "new" }] });
  });
  it("stops restoring subsequent refs after a reentrant native composer change", async () => {
    let revision = 0;
    const state = { text: "", attachments: [] as { id: string }[] };
    const calls: string[] = [];
    const composer = {
      getState: () => state,
      addAttachment: async (attachment: { id?: string }) => {
        calls.push(attachment.id!);
        state.attachments.push({ id: attachment.id! });
        revision++;
        state.attachments = [{ id: "new" }];
        revision++;
      },
      setText: (text: string) => {
        state.text = text;
        revision++;
      },
    };
    const source = ["a", "b"].map((id) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      status: { type: "complete" as const },
      content: [{ type: "image" as const, image: "/api/test" }],
    }));
    await restoreDetachedImages(composer, source, "original", revision, () => revision);
    expect(calls).toEqual(["a"]);
    expect(state).toEqual({ text: "", attachments: [{ id: "new" }] });
  });
  it("uses the public Photon processor for PNG, JPEG, orientation, resizing and base64 limits", async () => {
    expect((await prepareImage(processor, png, "image/png")).data).toBe(png.toString("base64"));
    expect((await prepareImage(processor, jpeg, "image/jpeg")).data).toBe(jpeg.toString("base64"));
    const resized = await prepareImage(processor, largePng(), "image/png");
    expect(resized.resized?.from).toEqual({ width: 2100, height: 2 });
    expect(resized.resized?.to.width).toBe(2000);
    expect(resized.data.length).toBeLessThanOrEqual(IMAGE_PREPARATION_LIMITS.maxBytes);
    const upright = await prepareImage(processor, rotatedJpeg(), "image/jpeg");
    expect(upright.data).not.toBe(rotatedJpeg().toString("base64"));
    const constrained = await processor.prepare(
      Uint8Array.from(Buffer.from(upright.data, "base64")),
      upright.mimeType,
      { maxWidth: 8, maxHeight: 8, maxBytes: 100_000 },
    );
    expect(constrained?.resized?.from).toEqual({ width: 8, height: 16 });
    expect(
      await processor.prepare(Uint8Array.from(png), "image/png", {
        maxWidth: 10,
        maxHeight: 10,
        maxBytes: 1,
      }),
    ).toBeUndefined();
  });
  it("rejects malformed, mismatch, oversized, path traversal, duplicate and unsupported model", async () => {
    const { service } = await setup();
    await expect(service.upload("image/jpeg", png)).rejects.toThrow();
    await expect(service.upload("image/png", jpeg)).rejects.toThrow();
    await expect(service.upload("image/gif", png)).rejects.toThrow();
    await expect(service.upload("image/png", png.subarray(0, 30))).rejects.toThrow();
    const excessive = Buffer.from(png);
    excessive.writeUInt32BE(8193, 16);
    await expect(service.upload("image/png", excessive)).rejects.toThrow();
    await expect(service.upload("image/png", Buffer.alloc(IMAGE_MAX_BYTES + 1))).rejects.toThrow();
    await expect(
      imageFromHistoryPart(processor, { type: "image", mimeType: "image/png", data: "!!" }),
    ).rejects.toThrow();
    const ref = await service.upload("image/jpeg", jpeg);
    await expect(
      service.input({ text: "", images: [ref.id] }, { input: ["text"] }),
    ).rejects.toThrow();
    await expect(
      service.input({ text: "", images: [ref.id, ref.id] }, { input: ["image"] }),
    ).rejects.toThrow();
    await expect(service.readPending("../../secrets")).rejects.toThrow();
  });
  it("keeps originals across reopening, binds pending references to one conversation, and uses a single upload adapter", async () => {
    const { root, service, authorization } = await setup();
    const adapter = createImageAttachmentAdapter({
      upload: async (file) => service.upload(file.type, new Uint8Array(await file.arrayBuffer())),
      previewUrl: (id) => `/api/chats/1/attachments/${id}`,
    });
    const file = new File([jpeg], "image.jpg", { type: "image/jpeg" });
    const pending = await adapter.add({ file });
    if (Symbol.asyncIterator in pending) throw new Error("unexpected generator");
    expect((await adapter.send(pending)).id).toBe(pending.id);
    await adapter.remove(pending);
    const reopened = createAttachmentService(root, authorization, processor);
    expect(await reopened.readPending(pending.id)).toEqual(jpeg);
    await expect(
      createAttachmentService(
        root,
        { ...authorization, canReadPending: async () => false },
        processor,
      ).readPending(pending.id),
    ).rejects.toThrow();
    const rotated = rotatedJpeg();
    const oriented = await service.upload("image/jpeg", rotated);
    expect(oriented.prepared.changed).toBe(true);
    expect(await reopened.readPending(oriented.id)).toEqual(rotated);
  });
  it("admits real SDK image input, reads native tool output and retrieves it through fork-aware history", async () => {
    const { root, service } = await setup();
    const ref = await service.upload("image/png", png);
    await writeFile(join(root, "tool.png"), png);
    const provider = testModels();
    const registry = createRegistry();
    registry.install(createCodingTools({ images: processor }));
    const envs: NodeExecutionEnv[] = [];
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: provider.models,
        registry,
        env: ({ cwd }) => {
          const env = new NodeExecutionEnv({ cwd: cwd! });
          envs.push(env);
          return env;
        },
      },
      BACKGROUND_CONTEXT,
    );
    try {
      const model = { provider: PROVIDER_ID, modelId: MODEL_ID };
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd: root, model } });
      const first = await service.input(
        { text: "", images: [ref.id] },
        { input: ["text", "image"] },
      );
      const draft = {
        type: "input" as const,
        content: first,
        requestId: crypto.randomUUID(),
        whenBusy: "reject" as const,
      };
      const admitted = await conversation.submit(draft, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      expect((await conversation.submit(draft, BACKGROUND_CONTEXT)).id).toBe(admitted.id);
      await expect(
        conversation.submit({ ...draft, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT),
      ).rejects.toThrow();
      expect(await service.readPending(ref.id)).toEqual(png);
      expect(
        provider.calls[0]!.context.messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === "image" && p.data === png.toString("base64")),
        ),
      ).toBe(true);
      provider.calls[0]!.finish("first done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const second = await service.input(
        { text: "with image", images: [ref.id] },
        { input: ["image"] },
      );
      await conversation.submit({ type: "input", content: second }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const msg = provider.calls[1]!.context.messages.filter((m) => m.role === "user").at(-1)!;
      expect(msg.content).toEqual(second);
      provider.calls[1]!.tools([
        { id: "read-image", name: "read", arguments: { path: "tool.png" } },
      ]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
      const tool = provider.calls[2]!.context.messages.find(
        (m) => m.role === "toolResult" && m.toolCallId === "read-image",
      );
      expect(tool?.role).toBe("toolResult");
      if (!tool || tool.role !== "toolResult") throw new Error("missing tool result");
      const part = tool.content.find((p) => p.type === "image");
      expect((await imageFromHistoryPart(processor, part)).bytes).toEqual(png);
      // read returns one image; this synthetic projection contract preserves mixed ordering.
      const ordered = [{ type: "text", text: "before" }, part, { type: "text", text: "after" }];
      expect(ordered.map((item) => item?.type)).toEqual(["text", "image", "text"]);
      provider.calls[2]!.finish("done");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const context = await conversation.context(BACKGROUND_CONTEXT);
      const entry = context.entries.find((e) => e.kind === "pi.tool-result");
      expect(entry).toBeDefined();
      const fork = await conversation.fork(
        entry!.id,
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      const other = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: root, model } },
        BACKGROUND_CONTEXT,
      );
      const find = async (scope: typeof conversation) =>
        (await scope.context(BACKGROUND_CONTEXT)).entries.find((e) => e.id === entry!.id);
      const inherited = await find(fork);
      expect(inherited).toBeDefined();
      expect(await find(other)).toBeUndefined();
      const inheritedResult = inherited!.model?.find((m) => m.role === "toolResult");
      if (!inheritedResult || inheritedResult.role !== "toolResult")
        throw new Error("missing inherited result");
      expect(
        (
          await imageFromHistoryPart(
            processor,
            inheritedResult.content.find((p) => p.type === "image"),
          )
        ).bytes,
      ).toEqual(png);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await Promise.all(envs.map((env) => env.cleanup(BACKGROUND_CONTEXT)));
    }
  }, 20000);
});
