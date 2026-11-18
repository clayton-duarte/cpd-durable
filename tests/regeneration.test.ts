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
    expect(prepared).toMatchObject({ status: "prepared", forkEntryId: String(user.id) });
    expect((await regeneration.recent(root.id, answer.id)).operations[0]).toMatchObject({
      requestId: request.requestId,
    });
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
    expect((await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(2);
    await harness.commit(async (tx) => {
      (await tx.doc(CatalogDoc)).items.find(
        (row) => row.id === (Number(prepared.branchId) as ConversationId),
      )!.status = "deleted";
    }, BACKGROUND_CONTEXT);
    expect((await regeneration.recent(root.id, answer.id)).operations).toHaveLength(0);
    await expect(regeneration.admit(request)).rejects.toThrow("Unavailable");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});
