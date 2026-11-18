import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  UserEntry,
  AssistantEntry,
  createRegistry,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { CatalogDoc } from "../src/server/chats.ts";
import {
  createRegeneration,
  RegenerationError,
  type RegenerationCatalog,
} from "../src/server/regeneration.ts";
import { testModels } from "./models.ts";
import { BranchIdentityDoc, reserveBranchIdentity } from "../src/server/branch-identity.ts";
import {
  admissionDigest,
  checkAdmissionRequest,
  imageRequestDigest,
} from "../src/server/attachment-catalog.ts";
import type { Conversation } from "@earendil-works/pi-durable";

it("forks before a final answer, admits once, and recovers without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-regen-"));
  const provider = testModels();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "test.sqlite")),
    {
      models: provider.models,
      registry: createRegistry(),
      settings: { compaction: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
    });
    const hooks: RegenerationCatalog = {
      async requireActive(tx, id) {
        const item = (await tx.doc(CatalogDoc)).items.find((row) => row.id === id);
        if (!item || item.status) throw new RegenerationError("Unavailable", 404);
      },
      async reserveBranchRequest(tx, request) {
        return reserveBranchIdentity(tx, request.requestId, "regenerate");
      },
      async register(tx, branch) {
        (await tx.doc(CatalogDoc)).items.push({
          id: branch.branchId,
          title: "Regenerated",
          named: true,
          requestId: null,
        });
      },
    };
    const user = await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.push({
        id: root.id,
        title: "Source",
        named: true,
        requestId: null,
      });
      return tx.appendEntry(UserEntry, root.id, {
        model: [{ role: "user", content: "Question", timestamp: 0 }],
      });
    }, BACKGROUND_CONTEXT);
    const other = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await harness.commit(
      (tx) =>
        tx.appendEntry(UserEntry, other.id, {
          model: [{ role: "user", content: "Other conversation", timestamp: 0 }],
        }),
      BACKGROUND_CONTEXT,
    );
    const metadata = await harness.commit(
      (tx) => tx.appendEntry(root.id, { kind: "test.metadata", data: { label: "marker" } }),
      BACKGROUND_CONTEXT,
    );
    const answer = await harness.commit(
      async (tx) =>
        tx.appendEntry(AssistantEntry, root.id, {
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Original answer" }],
              api: "openai-completions",
              provider: PROVIDER_ID,
              model: MODEL_ID,
              stopReason: "stop",
              timestamp: 0,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    const request = {
      sourceId: String(root.id),
      entryId: String(answer.id),
      requestId: crypto.randomUUID(),
    };
    const regeneration = createRegeneration(harness, hooks);
    const prepared = await regeneration.prepare(request);
    expect(prepared).toMatchObject({ status: "prepared", forkEntryId: String(metadata.id) });
    expect(metadata.id).toBeGreaterThan(user.id);
    expect((await regeneration.recent(root.id, answer.id)).operations[0]).toMatchObject({
      requestId: request.requestId,
    });
    expect(provider.calls).toHaveLength(0);
    const changedRequest = { ...request, requestId: crypto.randomUUID() };
    const changed = await regeneration.prepare(changedRequest);
    const changedBranch = (await harness.conversation(
      Number(changed.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    await changedBranch.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    await expect(regeneration.admit(changedRequest)).rejects.toThrow("changed before admission");
    const resetRequest = { ...request, requestId: crypto.randomUUID() };
    const reset = await regeneration.prepare(resetRequest);
    const resetBranch = (await harness.conversation(
      Number(reset.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    await resetBranch.reset(undefined, BACKGROUND_CONTEXT);
    await expect(regeneration.admit(resetRequest)).rejects.toThrow("changed before admission");
    expect(provider.calls).toHaveLength(0);
    const admissions = await Promise.all(
      Array.from({ length: 3 }, () => regeneration.admit(request)),
    );
    expect(admissions.every((value) => value.submissionId === admissions[0]?.submissionId)).toBe(
      true,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    expect(JSON.stringify(provider.calls[0]!.context)).toContain("Question");
    expect(JSON.stringify(provider.calls[0]!.context)).not.toContain("Original answer");
    provider.calls[0]!.finish("New answer");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await regeneration.admit(request)).branchId).toBe(prepared.branchId);
    expect(provider.calls).toHaveLength(1);
    expect((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(3);
    const secondAnswer = await harness.commit(
      (tx) => tx.appendEntry(AssistantEntry, root.id, { model: answer.model! }),
      BACKGROUND_CONTEXT,
    );
    await expect(
      regeneration.prepare({
        sourceId: String(root.id),
        entryId: String(secondAnswer.id),
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("not unanswered");
    const assistantMessage = answer.model?.[0];
    if (!assistantMessage || assistantMessage.role !== "assistant")
      throw new Error("Missing answer");
    await harness.commit(
      (tx) =>
        tx.appendEntry(AssistantEntry, root.id, {
          model: [
            {
              ...assistantMessage,
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    const toolResult = await harness.commit(
      (tx) =>
        tx.appendEntry(root.id, {
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "read",
              content: [{ type: "text", text: "Prior tool result" }],
              isError: false,
              timestamp: 0,
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    const toolAnswer = await harness.commit(
      (tx) => tx.appendEntry(AssistantEntry, root.id, { model: answer.model! }),
      BACKGROUND_CONTEXT,
    );
    const toolRequest = {
      sourceId: String(root.id),
      entryId: String(toolAnswer.id),
      requestId: crypto.randomUUID(),
    };
    const inherited = await harness.commit(async (tx) => {
      const child = await tx.forkConversation(root.id, toolAnswer.id, {
        ownership: { kind: "ownerless" },
      });
      (await tx.doc(CatalogDoc)).items.push({
        id: child.id,
        title: "Inherited",
        named: true,
        requestId: null,
      });
      return child;
    }, BACKGROUND_CONTEXT);
    const inheritedPrepared = await regeneration.prepare({
      ...toolRequest,
      sourceId: String(inherited.id),
      requestId: crypto.randomUUID(),
    });
    expect(inheritedPrepared.forkEntryId).toBe(String(toolResult.id));
    const toolPrepared = await regeneration.prepare(toolRequest);
    expect(toolPrepared.forkEntryId).toBe(String(toolResult.id));
    await regeneration.admit(toolRequest);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(JSON.stringify(provider.calls[1]!.context)).toContain("Prior tool result");
    provider.calls[1]!.finish("Revised tool answer");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find(
        (row) => row.id === (Number(prepared.branchId) as ConversationId),
      )!.status = "deleted";
    }, BACKGROUND_CONTEXT);
    expect(
      (await regeneration.recent(root.id, answer.id)).operations.map((item) => item.requestId),
    ).not.toContain(request.requestId);
    await expect(regeneration.admit(request)).rejects.toThrow("Unavailable");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("regeneration durable identity and recovery", () => {
  let directory: string;
  let harness: Harness;
  let root: Conversation;
  let answerId: number;
  let provider: ReturnType<typeof testModels>;
  const hooks: RegenerationCatalog = {
    async requireActive(tx, id) {
      const item = (await tx.doc(CatalogDoc)).items.find((row) => row.id === id);
      if (!item || item.status) throw new RegenerationError("Unavailable", 404);
    },
    async reserveBranchRequest(tx, request) {
      return reserveBranchIdentity(tx, request.requestId, "regenerate");
    },
    async register(tx, branch) {
      (await tx.doc(CatalogDoc)).items.push({
        id: branch.branchId,
        title: "Regenerated",
        named: true,
        requestId: null,
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
    directory = await mkdtemp(join(tmpdir(), "cpd-regen-case-"));
    provider = testModels();
    await open();
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.push({
        id: root.id,
        title: "Root",
        named: true,
        requestId: null,
      });
      await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: "user", content: "Question", timestamp: 0 }],
      });
    }, BACKGROUND_CONTEXT);
    answerId = (
      await harness.commit(
        (tx) =>
          tx.appendEntry(AssistantEntry, root.id, {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Answer" }],
                api: "openai-completions",
                provider: PROVIDER_ID,
                model: MODEL_ID,
                stopReason: "stop",
                timestamp: 0,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              },
            ],
          }),
        BACKGROUND_CONTEXT,
      )
    ).id;
  });
  afterEach(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  });
  const input = () => ({
    sourceId: String(root.id),
    entryId: String(answerId),
    requestId: crypto.randomUUID(),
  });

  it.each(["input", "control", "image"])(
    "rejects an existing %s admission identity",
    async (kind) => {
      const request = input();
      await harness.commit(async (tx) => {
        const digest =
          kind === "control"
            ? admissionDigest(["control", "continue", null])
            : imageRequestDigest({
                text: "Existing input",
                images: kind === "image" ? ["image-id"] : [],
                mode: "reject",
              });
        const record = await checkAdmissionRequest(tx, root.id, request.requestId, digest);
        record();
      }, BACKGROUND_CONTEXT);
      await expect(createRegeneration(harness, hooks).prepare(request)).rejects.toThrow(
        "Request ID",
      );
      expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);
    },
  );

  it.each(["create", "fork"])("rejects a catalog %s request identity", async (kind) => {
    const request = input();
    await harness.commit(async (tx) => {
      const catalog = await tx.doc(CatalogDoc);
      if (kind === "create") catalog.requests = [{ requestId: request.requestId, id: root.id }];
      else
        catalog.forks = [
          { requestId: request.requestId, parentId: root.id, at: answerId, id: root.id },
        ];
    }, BACKGROUND_CONTEXT);
    await expect(createRegeneration(harness, hooks).prepare(request)).rejects.toThrow("identity");
    expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(1);
  });

  it("reopens a prepared operation, reads without admission and resumes the same submission", async () => {
    const request = input();
    const first = await createRegeneration(harness, hooks).prepare(request);
    expect(
      (await harness.snapshot(BranchIdentityDoc, BACKGROUND_CONTEXT))?.requests,
    ).toContainEqual({
      id: request.requestId,
      action: "regenerate",
    });
    await expect(
      harness.commit(
        (tx) => reserveBranchIdentity(tx, request.requestId, "fork"),
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("identity");
    await harness.close(BACKGROUND_CONTEXT);
    await open();
    const service = createRegeneration(harness, hooks);
    expect((await service.recent(root.id, answerId as EntryId)).operations).toEqual([
      { ...first, requestId: request.requestId },
    ]);
    expect(provider.calls).toHaveLength(0);
    const admitted = await service.admit(request);
    expect(admitted.branchId).toBe(first.branchId);
    expect(await service.admit(request)).toEqual(admitted);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("New answer");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(await service.admit(request)).toEqual(admitted);
    expect(provider.calls).toHaveLength(1);
    expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(2);
  });

  it.each(["archived", "deleted"] as const)(
    "rejects %s source and hides unavailable result without resurrecting it",
    async (status) => {
      const request = input();
      const service = createRegeneration(harness, hooks);
      const prepared = await service.prepare(request);
      await harness.commit(async (tx) => {
        (await tx.doc(CatalogDoc)).items.find(
          (item) => item.id === Number(prepared.branchId),
        )!.status = status;
      }, BACKGROUND_CONTEXT);
      expect((await service.recent(root.id, answerId as EntryId)).operations).toEqual([]);
      await expect(service.admit(request)).rejects.toThrow("Unavailable");
      await expect(service.prepare(request)).rejects.toThrow("Unavailable");
      await harness.commit(async (tx) => {
        (await tx.doc(CatalogDoc)).items.find((item) => item.id === root.id)!.status = status;
      }, BACKGROUND_CONTEXT);
      await expect(service.recent(root.id, answerId as EntryId)).rejects.toThrow("Unavailable");
      await expect(service.admit(request)).rejects.toThrow("Unavailable");
      expect(provider.calls).toHaveLength(0);
      expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(2);
    },
  );

  it("rejects conflicting source or entry for an existing operation identity", async () => {
    const request = input();
    const service = createRegeneration(harness, hooks);
    await service.prepare(request);
    await expect(service.admit({ ...request, entryId: "999999" })).rejects.toThrow(
      "Preparation unavailable",
    );
    await expect(service.admit({ ...request, sourceId: "999999" })).rejects.toThrow(
      "Preparation unavailable",
    );
    expect((await service.recent(root.id, 999999 as EntryId)).operations).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("coalesces concurrent preparation into one ownerless branch", async () => {
    const request = input();
    const service = createRegeneration(harness, hooks);
    const prepared = await Promise.all(Array.from({ length: 4 }, () => service.prepare(request)));
    expect(new Set(prepared.map((item) => item.branchId)).size).toBe(1);
    expect((await harness.snapshot(CatalogDoc, BACKGROUND_CONTEXT))!.items).toHaveLength(2);
    expect(provider.calls).toHaveLength(0);
  });

  it("linearizes concurrent configuration and admission without bypassing the guard", async () => {
    const request = input();
    const service = createRegeneration(harness, hooks);
    const prepared = await service.prepare(request);
    const branch = (await harness.conversation(
      Number(prepared.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const original = harness.conversation.bind(harness);
    const spy = vi.spyOn(harness, "conversation").mockImplementation(async (id, context) => {
      const result = await original(id, context);
      if (id === branch.id) {
        reached();
        await blocked;
      }
      return result;
    });
    const admission = service.admit(request);
    await entered;
    await branch.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    release();
    await expect(admission).rejects.toThrow("changed before admission");
    spy.mockRestore();
    expect(provider.calls).toHaveLength(0);
  });

  it("examines the SDK compaction boundary without inventing context", async () => {
    await root.configure({ compaction: { keepRecentTokens: 1 } }, BACKGROUND_CONTEXT);
    for (let index = 0; index < 6; index++)
      await root.submit(
        {
          type: "write",
          entry: {
            kind: "test.context",
            model: [{ role: "user", content: `History ${index} `.repeat(100), timestamp: index }],
          },
        },
        BACKGROUND_CONTEXT,
      );
    await root.compact(undefined, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    provider.calls[0]!.finish("Compacted summary");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(async () =>
      expect((await root.context(BACKGROUND_CONTEXT)).head).toBeDefined(),
    );
    const previousAnswer = (
      await root.entries(
        { minEntryId: answerId as EntryId, maxEntryId: answerId as EntryId },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      )
    ).items[0]!;
    await harness.commit(
      (tx) =>
        tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: "After compaction", timestamp: 0 }],
        }),
      BACKGROUND_CONTEXT,
    );
    const target = await harness.commit(
      (tx) =>
        tx.appendEntry(AssistantEntry, root.id, {
          model: previousAnswer.model!,
        }),
      BACKGROUND_CONTEXT,
    );
    const request = { ...input(), entryId: String(target.id) };
    const service = createRegeneration(harness, hooks);
    const prepared = await service.prepare(request);
    const branch = (await harness.conversation(
      Number(prepared.branchId) as ConversationId,
      BACKGROUND_CONTEXT,
    ))!;
    const actual = await branch.context(BACKGROUND_CONTEXT);
    const expected = await root.context(BACKGROUND_CONTEXT, {
      at: Number(prepared.forkEntryId) as EntryId,
    });
    expect(actual.messages).toEqual(expected.messages);
    expect(actual.head?.id).toEqual(expected.head?.id);
    expect(actual.head).toBeDefined();
    expect(JSON.stringify(actual.messages)).toContain("After compaction");
    expect(provider.calls).toHaveLength(1);
    await service.admit(request);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(JSON.stringify(provider.calls[1]!.context)).toContain("After compaction");
    provider.calls[1]!.finish("New answer");
    await harness.waitForIdle(BACKGROUND_CONTEXT);
  });
});
