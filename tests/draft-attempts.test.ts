import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import {
  draftAttemptFingerprint,
  DraftAttemptConflict,
  readDraftAttempt,
  recordDraftAttempt,
  type DraftAttemptPayload,
} from "../src/server/draft-attempts.ts";
import { testModels } from "./models.ts";

describe("draft attempt metadata", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  let payload: DraftAttemptPayload;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "draft-attempt-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
    payload = {
      requestId: crypto.randomUUID(),
      draftRevision: 4,
      text: "  synthetic input  ",
      images: [],
      mode: "reject",
    };
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  const record = (input: DraftAttemptPayload) => ({
    ...input,
    fingerprint: draftAttemptFingerprint(input),
  });
  const save = (input: DraftAttemptPayload) =>
    chat.conversation.commit(
      (tx) => recordDraftAttempt(tx, chat.conversation.id, record(input)),
      BACKGROUND_CONTEXT,
    );
  const read = (id: string) =>
    chat.conversation.commit(
      (tx) => readDraftAttempt(tx, chat.conversation.id, id),
      BACKGROUND_CONTEXT,
    );

  it("records idempotently and rejects changed semantic payloads", async () => {
    const first = await save(payload);
    expect(await save(payload)).toEqual(first);
    for (const change of [
      { text: "synthetic input" },
      { draftRevision: 5 },
      { mode: "followUp" as const },
      { images: [crypto.randomUUID()] },
    ]) {
      await expect(save({ ...payload, ...change })).rejects.toBeInstanceOf(DraftAttemptConflict);
    }
    await expect(
      chat.conversation.commit(
        (tx) =>
          recordDraftAttempt(tx, chat.conversation.id, { ...first, fingerprint: "0".repeat(64) }),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await read(payload.requestId)).toEqual({ record: first, admission: "unknown" });
  });

  it("validates bounded payloads and copies image references", async () => {
    const image = crypto.randomUUID();
    const input = { ...payload, images: [image] };
    const saved = await save(input);
    input.images.push(crypto.randomUUID());
    saved.images.push(crypto.randomUUID());
    expect((await read(payload.requestId))?.record.images).toEqual([image]);
    await expect(
      save({ ...payload, requestId: crypto.randomUUID(), text: "x".repeat(32_001) }),
    ).rejects.toThrow();
    await expect(
      save({ ...payload, requestId: crypto.randomUUID(), images: [image, image] }),
    ).rejects.toThrow();
  });

  it("retains unknown intent on reopen without invoking the provider", async () => {
    const saved = await save(payload);
    await chat.close();
    chat = await openChat(directory, provider.models, directory);
    expect(await read(payload.requestId)).toEqual({ record: saved, admission: "unknown" });
    expect(provider.calls).toHaveLength(0);
  });

  it("reads SDK admission after submission without triggering another provider call", async () => {
    const saved = await save(payload);
    expect((await read(payload.requestId))?.admission).toBe("unknown");
    expect(provider.calls).toHaveLength(0);
    const id = await chat.conversation.commit(
      (tx) =>
        chat.conversation.submit(tx, {
          type: "input",
          requestId: payload.requestId,
          content: payload.text.trim(),
          whenBusy: payload.mode,
        }),
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(await read(payload.requestId)).toEqual({
      record: saved,
      admission: "admitted",
      submissionId: String(id),
    });
    expect(provider.calls).toHaveLength(1);
    provider.calls[0]!.finish("done");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("starts forks without inherited attempts", async () => {
    await save(payload);
    await chat.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "test.saved",
          model: [{ role: "user", content: "boundary", timestamp: Date.now() }],
        },
      },
      BACKGROUND_CONTEXT,
    );
    const entry = (await chat.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]!;
    const fork = await chat.conversation.fork(
      entry.id,
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    expect(
      await fork.commit(
        (tx) => readDraftAttempt(tx, fork.id, payload.requestId),
        BACKGROUND_CONTEXT,
      ),
    ).toBeUndefined();
    expect((await read(payload.requestId))?.admission).toBe("unknown");
    expect(provider.calls).toHaveLength(0);
  });
});
