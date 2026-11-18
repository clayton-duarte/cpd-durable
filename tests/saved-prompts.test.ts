import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createSavedPrompts, SavedPromptsDoc } from "../src/server/saved-prompts.ts";
import { SAVED_PROMPT_LIMIT, SAVED_PROMPT_OPERATION_LIMIT } from "../src/shared/saved-prompts.ts";
import { testModels } from "./models.ts";

describe("session saved prompts", () => {
  let directory: string;
  let harness: Harness;
  let provider: ReturnType<typeof testModels>;
  async function open() {
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "test.sqlite")),
      { models: provider.models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-prompts-"));
    provider = testModels();
    await open();
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });
  const input = () => ({
    requestId: randomUUID(),
    id: randomUUID(),
    title: "Sample",
    text: "Literal ${value}",
  });

  it("persists across reopen without invoking a provider; results are detached", async () => {
    const service = createSavedPrompts(harness);
    const request = input();
    const receipt = await service.create(request);
    receipt.prompt.text = "changed locally";
    expect((await service.list()).items[0]?.text).toBe(request.text);
    await harness.close(BACKGROUND_CONTEXT);
    await open();
    expect((await createSavedPrompts(harness).list()).items).toEqual([
      { id: request.id, title: request.title, text: request.text, revision: 1 },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("enforces CAS and preserves original receipts across edits and deletion", async () => {
    const service = createSavedPrompts(harness);
    const create = input();
    const original = await service.create(create);
    const update = { ...create, requestId: randomUUID(), expectedRevision: 1, text: "Updated" };
    const changed = await service.update(update);
    expect(changed.prompt.revision).toBe(2);
    await expect(service.update({ ...update, requestId: randomUUID() })).rejects.toMatchObject({
      status: 409,
    });
    expect(await service.create(create)).toEqual(original);
    await expect(service.create({ ...create, text: "different" })).rejects.toMatchObject({
      status: 409,
    });
    const remove = { requestId: randomUUID(), id: create.id, expectedRevision: 2 };
    const deleted = await service.remove(remove);
    expect(deleted.deleted).toBe(true);
    expect(await service.remove(remove)).toEqual(deleted);
    expect(await service.update(update)).toEqual(changed);
    await expect(service.remove({ ...remove, requestId: randomUUID() })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.create({ ...create, requestId: randomUUID() })).rejects.toMatchObject({
      status: 409,
    });
    expect((await service.list()).items).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("allows only one of two simultaneous updates at the same revision", async () => {
    const service = createSavedPrompts(harness);
    const original = input();
    await service.create(original);
    const attempts = await Promise.allSettled([
      service.update({ ...original, requestId: randomUUID(), expectedRevision: 1, text: "One" }),
      service.update({ ...original, requestId: randomUUID(), expectedRevision: 1, text: "Two" }),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await service.list()).items[0]?.revision).toBe(2);
    expect(provider.calls).toHaveLength(0);
  });

  it("pages by stable opaque ID and enforces text and list bounds", async () => {
    const service = createSavedPrompts(harness);
    const requests = Array.from({ length: 23 }, input);
    for (const request of requests) await service.create(request);
    const first = await service.list(undefined, 20);
    const second = await service.list(first.nextCursor!, 20);
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      requests.map((item) => item.id).sort(),
    );
    await expect(service.create({ ...input(), text: "é".repeat(16385) })).rejects.toThrow();
    await expect(service.list(undefined, 21)).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });

  it("fails explicitly at item and durable receipt capacity", async () => {
    const service = createSavedPrompts(harness);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SavedPromptsDoc);
      doc.prompts = Array.from({ length: SAVED_PROMPT_LIMIT }, () => ({
        id: randomUUID(),
        title: "Sample",
        text: "",
        revision: 1,
      }));
    }, BACKGROUND_CONTEXT);
    await expect(service.create(input())).rejects.toMatchObject({
      status: 409,
      message: "Saved prompt capacity reached.",
    });
    await harness.commit(async (tx) => {
      const doc = await tx.doc(SavedPromptsDoc);
      doc.operations = Array.from({ length: SAVED_PROMPT_OPERATION_LIMIT }, () => ({
        requestId: randomUUID(),
        digest: "fixture",
        receipt: { prompt: doc.prompts[0]!, deleted: false },
      }));
    }, BACKGROUND_CONTEXT);
    await expect(service.create(input())).rejects.toMatchObject({
      status: 409,
      message: "Saved prompt operation capacity reached.",
    });
    expect(provider.calls).toHaveLength(0);
  });
});
