import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  UserEntry,
  createRegistry,
  type Conversation,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CatalogDoc } from "../src/server/chats.ts";
import {
  BranchOperationError,
  createBranchOperations,
  type BranchCatalogHooks,
} from "../src/server/branch-operations.ts";
import { testModels } from "./models.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { imageRequestDigest } from "../src/server/attachment-catalog.ts";

describe("durable edit branch foundation", () => {
  let directory: string;
  let harness: Harness;
  let root: Conversation;
  let provider: ReturnType<typeof testModels>;
  const hooks: BranchCatalogHooks = {
    async requireActive(tx, id) {
      const item = (await tx.doc(CatalogDoc)).items.find((entry) => entry.id === id);
      if (!item || item.status) throw new BranchOperationError("Chat unavailable.", 409);
    },
    async registerEdit(tx, branch) {
      const catalog = await tx.doc(CatalogDoc);
      catalog.items.push({
        id: branch.branchId,
        title: "Edited branch",
        named: true,
        requestId: null,
        ...(branch.forkEntryId === null
          ? {}
          : {
              parentId: branch.sourceId,
              forkEntryId: branch.forkEntryId,
              branchRootId: branch.sourceId,
            }),
      });
    },
  };
  async function open() {
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "test.sqlite")),
      {
        models: provider.models,
        registry: createRegistry(),
        settings: { compaction: { enabled: false } },
      },
      BACKGROUND_CONTEXT,
    );
    root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
    });
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-edit-"));
    provider = testModels();
    await open();
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.push({
        id: root.id,
        title: "Root",
        named: true,
        requestId: null,
      });
    }, BACKGROUND_CONTEXT);
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });
  async function append(text: string, conversation = root): Promise<EntryId> {
    return await harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(UserEntry, conversation.id, {
            model: [{ role: "user", content: text, timestamp: 0 }],
          })
        ).id,
      BACKGROUND_CONTEXT,
    );
  }
  function request(entryId: EntryId, sourceId = root.id, text = "Replacement") {
    return {
      sourceId: String(sourceId),
      entryId: String(entryId),
      requestId: crypto.randomUUID(),
      text,
    };
  }
  async function finish(index = 0) {
    await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThan(index));
    provider.calls[index]!.finish("Answer");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
  }

  it("edits a middle entry at its actual visible predecessor with historical fork configuration", async () => {
    await root.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    const first = await append("Before");
    await root.configure({ thinkingLevel: "low" }, BACKGROUND_CONTEXT);
    // Another conversation consumes IDs; arithmetic on the target is unsafe.
    await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const target = await append("Original");
    await append("After");
    const requestData = request(target);
    const operations = createBranchOperations(harness, hooks);
    const prepared = await operations.prepareEdit(requestData);
    expect(prepared).toMatchObject({
      status: "prepared",
      forkEntryId: String(first),
      configuration: "fork-boundary",
    });
    expect(provider.calls).toHaveLength(0);
    const result = await operations.admitEdit(requestData);
    expect(result.status).toBe("admitted");
    expect(result.submissionId).toBeDefined();
    const branch = (await harness.conversation(
      Number(result.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    expect((await branch.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const context = JSON.stringify(provider.calls[0]!.context);
    expect(context).toContain("Before");
    expect(context).toContain("Replacement");
    expect(context).not.toContain("Original");
    expect(context).not.toContain("After");
    await finish();
    expect((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(3);
  });

  it("first-entry edits use a new ownerless conversation and explicitly copy current saved configuration", async () => {
    const target = await append("First");
    await root.configure(
      { thinkingLevel: "high", instructions: "Current instruction" },
      BACKGROUND_CONTEXT,
    );
    const result = await createBranchOperations(harness, hooks).edit(request(target));
    expect(result).toMatchObject({
      forkEntryId: null,
      configuration: "source-current-at-creation",
      status: "admitted",
    });
    const branch = (await harness.conversation(
      Number(result.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    expect(await branch.agent(BACKGROUND_CONTEXT)).toMatchObject({
      thinkingLevel: "high",
      instructions: "Current instruction",
    });
    await finish();
    const entries = (await branch.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
    expect(entries.some((entry) => entry.id === target)).toBe(false);
  });

  it("edits inherited entries using the selected fork's visible predecessor", async () => {
    const first = await append("Ancestor first");
    const second = await append("Ancestor second");
    const fork = await harness.commit(async (tx) => {
      const record = await tx.forkConversation(root.id, second, {
        ownership: { kind: "ownerless" },
      });
      (await tx.doc(CatalogDoc)).items.push({
        id: record.id,
        title: "Fork",
        named: true,
        requestId: null,
      });
      return record;
    }, BACKGROUND_CONTEXT);
    const result = await createBranchOperations(harness, hooks).edit(request(second, fork.id));
    expect(result.forkEntryId).toBe(String(first));
    await finish();
    expect(JSON.stringify(provider.calls[0]!.context)).toContain("Ancestor first");
    expect(JSON.stringify(provider.calls[0]!.context)).not.toContain("Ancestor second");
  });

  it("retries concurrent identical requests idempotently and rejects changed payloads", async () => {
    const target = await append("Original");
    const input = request(target);
    const operations = createBranchOperations(harness, hooks);
    const results = await Promise.all(Array.from({ length: 5 }, () => operations.edit(input)));
    expect(new Set(results.map((item) => item.branchId)).size).toBe(1);
    expect(new Set(results.map((item) => item.submissionId)).size).toBe(1);
    await expect(operations.edit({ ...input, text: "Different" })).rejects.toThrow("identity");
    await finish();
    expect(provider.calls).toHaveLength(1);
    expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(2);
  });

  it("resumes a prepared edit after reopen with the same branch and SDK submission identity", async () => {
    const target = await append("Original");
    const input = request(target);
    const prepared = await createBranchOperations(harness, hooks).prepareEdit(input);
    await harness.close(BACKGROUND_CONTEXT);
    await open();
    expect(provider.calls).toHaveLength(0);
    const operations = createBranchOperations(harness, hooks);
    const accepted = await operations.edit(input);
    expect(accepted.branchId).toBe(prepared.branchId);
    expect((await operations.edit(input)).submissionId).toBe(accepted.submissionId);
    await finish();
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses admission if another action changed a prepared branch", async () => {
    const target = await append("Original");
    const input = request(target);
    const operations = createBranchOperations(harness, hooks);
    const prepared = await operations.prepareEdit(input);
    const branch = (await harness.conversation(
      Number(prepared.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    await append("Intervening action", branch);
    await expect(operations.admitEdit(input)).rejects.toThrow("changed before admission");
    expect(provider.calls).toHaveLength(0);
  });

  it("reopens an already admitted operation without starting another run", async () => {
    const input = request(await append("Original"));
    const accepted = await createBranchOperations(harness, hooks).edit(input);
    await finish();
    await harness.close(BACKGROUND_CONTEXT);
    await open();
    const retried = await createBranchOperations(harness, hooks).edit(input);
    expect(retried).toEqual(accepted);
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects archived source or result and ambiguous, foreign or non-user entries", async () => {
    const target = await append("Original");
    const operations = createBranchOperations(harness, hooks);
    const input = request(target);
    const prepared = await operations.prepareEdit(input);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find(
        (item) => item.id === Number(prepared.branchId),
      )!.status = "deleted";
    }, BACKGROUND_CONTEXT);
    await expect(operations.edit(input)).rejects.toThrow("unavailable");
    const ambiguous = await harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(root.id, {
            kind: "pi.user",
            model: [
              { role: "user", content: "one", timestamp: 0 },
              { role: "user", content: "two", timestamp: 0 },
            ],
          })
        ).id,
      BACKGROUND_CONTEXT,
    );
    await expect(operations.edit(request(ambiguous))).rejects.toThrow("safely");
    const imageEntry = await harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(UserEntry, root.id, {
            model: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Image input" },
                  { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                ],
                timestamp: 0,
              },
            ],
          })
        ).id,
      BACKGROUND_CONTEXT,
    );
    await expect(operations.edit(request(imageEntry))).rejects.toThrow("safely");
    const nonUser = await harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(root.id, {
            kind: "test.unknown",
            model: [{ role: "user", content: "Not a user entry", timestamp: 0 }],
          })
        ).id,
      BACKGROUND_CONTEXT,
    );
    await expect(operations.edit(request(nonUser))).rejects.toThrow("safely");
    await expect(operations.edit(request(999999 as EntryId))).rejects.toThrow("not visible");
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find((item) => item.id === root.id)!.status = "archived";
    }, BACKGROUND_CONTEXT);
    await expect(operations.edit(request(target))).rejects.toThrow("unavailable");
    expect(provider.calls).toHaveLength(0);
  });
});

it("production catalog and routes admit edits without bypassing the unified request fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-edit-route-"));
  const provider = testModels();
  const chat = await openChat(directory, provider.models, directory);
  try {
    const id = String(chat.conversation.id);
    const entry = await chat.conversation.commit(
      async (tx) =>
        tx.appendEntry(UserEntry, chat.conversation.id, {
          model: [{ role: "user", content: "Original", timestamp: 0 }],
        }),
      BACKGROUND_CONTEXT,
    );
    const app = createApp(chat);
    const eligibility = await app.request(
      `http://localhost:3000/api/chats/${id}/edit-eligibility/${entry.id}`,
    );
    expect(await eligibility.json()).toEqual({ eligible: true });
    const input = {
      sourceId: id,
      entryId: String(entry.id),
      requestId: crypto.randomUUID(),
      text: "Replacement",
    };
    const post = () =>
      app.request(`http://localhost:3000/api/chats/${id}/edit-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    const response = await post();
    expect(response.status).toBe(202);
    const receipt = (await response.json()) as { branchId: string; submissionId: string };
    expect(await (await post()).json()).toEqual(receipt);
    const branch = (await chat.chats.resolve(receipt.branchId))!;
    await expect(
      branch.admit(
        {
          type: "input",
          requestId: input.requestId,
          content: "Replacement",
          whenBusy: "reject",
        },
        { digest: imageRequestDigest({ text: "Replacement", images: [], mode: "reject" }) },
      ),
    ).rejects.toThrow("Request ID");
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("Answer");
    await branch.conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});
