import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vite-plus/test";
import { createTableExtension } from "../src/server/structured-table.ts";
import { TableDetailsSchema, TableInputSchema } from "../src/shared/structured-table.ts";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

const table = {
  columns: [
    { id: "name", label: "Name", type: "string" as const },
    { id: "value", label: "Value" },
  ],
  rows: [
    { name: "café", value: 3 },
    { name: "雪", value: false },
    { name: "", value: null },
  ],
  source: "Caller supplied",
};

describe("typed table formatter", () => {
  it("rejects unsafe keys, incompatible cells, non-scalars and oversized inputs", () => {
    expect(TableInputSchema.safeParse(table).success).toBe(true);
    expect(
      TableInputSchema.safeParse({ ...table, columns: [...table.columns, table.columns[0]] })
        .success,
    ).toBe(false);
    expect(TableInputSchema.safeParse({ ...table, rows: [{ unknown: "x" }] }).success).toBe(false);
    expect(TableInputSchema.safeParse({ ...table, rows: [{ name: 42 }] }).success).toBe(false);
    expect(TableInputSchema.safeParse({ ...table, rows: [{ value: Infinity }] }).success).toBe(
      false,
    );
    expect(TableInputSchema.safeParse({ ...table, rows: [{ value: {} }] }).success).toBe(false);
    expect(
      TableInputSchema.safeParse({ ...table, rows: [JSON.parse('{"constructor":"x"}')] }).success,
    ).toBe(false);
    expect(
      TableInputSchema.safeParse({ ...table, rows: [JSON.parse('{"__proto__":"x"}')] }).success,
    ).toBe(false);
    expect(
      TableInputSchema.safeParse({ ...table, rows: [{ name: "<b>unsafe</b>" }] }).success,
    ).toBe(false);
    expect(
      TableInputSchema.safeParse({ ...table, rows: Array.from({ length: 201 }, () => ({})) })
        .success,
    ).toBe(false);
    expect(
      TableInputSchema.safeParse({
        ...table,
        rows: Array.from({ length: 10 }, () => ({ name: "雪".repeat(3000) })),
      }).success,
    ).toBe(false);
  });

  it("returns and persists actual SDK details across reopen without extra provider calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpd-table-"));
    const provider = testModels();
    const registry = createRegistry();
    registry.install(createTableExtension());
    const open = async () =>
      Harness.open(
        await openNodeSqliteStorage(join(dir, "test.sqlite")),
        { models: provider.models, registry },
        BACKGROUND_CONTEXT,
      );
    let harness = await open();
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID } },
      });
      harness.resume();
      await conversation.submit(
        { type: "input", content: "Synthetic table test." },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      provider.calls[0]!.tools([{ id: "table-call", name: "display_table", arguments: table }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const result = provider.calls[1]!.context.messages.findLast(
        (item) => item.role === "toolResult",
      );
      expect(result).toMatchObject({
        role: "toolResult",
        toolName: "display_table",
        isError: false,
      });
      if (!result || result.role !== "toolResult") throw new Error("Missing tool result");
      expect(TableDetailsSchema.parse(result.details)).toEqual({ version: 1, table });
      provider.calls[1]!.finish("Finished.");
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const before = await conversation.watch(BACKGROUND_CONTEXT);
      const entries = before.value.entries;
      await before.stop();
      await harness.close(BACKGROUND_CONTEXT);
      harness = await open();
      const reopened = await harness.root(BACKGROUND_CONTEXT);
      const watch = await reopened.watch(BACKGROUND_CONTEXT);
      try {
        expect(watch.value.entries).toEqual(entries);
      } finally {
        await watch.stop();
      }
      expect(provider.calls).toHaveLength(2);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
