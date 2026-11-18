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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vite-plus/test";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { CatalogDoc } from "../src/server/chats.ts";
import {
  createRegeneration,
  RegenerationError,
  type RegenerationCatalog,
} from "../src/server/regeneration.ts";
import { testModels } from "./models.ts";

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
      async reserveBranchRequest() {
        return () => {};
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
