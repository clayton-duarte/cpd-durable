import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelTierSettings } from "../src/client/model-tier-settings.tsx";
import {
  assertMainModelDecisionTx,
  assertModelPolicyTx,
  createModelPolicy,
} from "../src/server/model-policy.ts";
import { testModels } from "./models.ts";

const context = BACKGROUND_CONTEXT;
describe("model tier policy", () => {
  it("renders settings without accessing the API or sending a model request", () => {
    const api = { read: vi.fn(), save: vi.fn() };
    const html = renderToStaticMarkup(createElement(ModelTierSettings, { api }));
    expect(html).toContain("Model tiers");
    expect(html).toContain("Existing conversations are unchanged");
    expect(api.read).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });
  it("persists, rejects stale writes and admissions, and never changes existing agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-policy-"));
    const provider = testModels();
    const open = async () =>
      Harness.open(
        await openNodeSqliteStorage(join(dir, "state.sqlite")),
        {
          models: provider.models,
          registry: createRegistry(),
        },
        context,
      );
    let harness = await open();
    try {
      const chat = await harness.root(context);
      const before = await chat.agent(context);
      let policy = createModelPolicy(harness, provider.models);
      const first = await policy.read();
      const hostDefault = await policy.prepareMainCreation();
      expect(hostDefault.selection).toBeNull();
      expect(first.assignments).toEqual({ main: null, tangent: null, worker: null });
      await expect(policy.resolveModelForRole("worker")).rejects.toThrow("Select a model");
      await expect(policy.resolveModelForRole("worker", { workerTier: "mid" })).rejects.toThrow(
        "Select a model",
      );
      const a = first.choices[0]!;
      const b = first.choices[1]!;
      const one = { provider: a.provider, modelId: a.modelId, thinkingLevel: a.thinkingLevels[0]! };
      const two = { provider: b.provider, modelId: b.modelId, thinkingLevel: b.thinkingLevels[0]! };
      const assignments = { main: one, tangent: two, worker: one };
      const expected = { revision: first.revision, assignments: first.assignments };
      const saved = await policy.save({ expected, assignments });
      expect(saved.revision).toBe(1);
      await expect(
        harness.commit((tx) => assertMainModelDecisionTx(tx, hostDefault), context),
      ).rejects.toThrow("changed");
      const raceExpected = { revision: saved.revision, assignments: saved.assignments };
      const outcomes = await Promise.allSettled([
        policy.save({ expected: raceExpected, assignments: { ...assignments, main: two } }),
        policy.save({ expected: raceExpected, assignments: { ...assignments, main: null } }),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await chat.agent(context)).toEqual(before);
      const economical = await policy.resolveModelForRole("worker");
      expect(economical.selection).toEqual(one);
      expect((await policy.resolveModelForRole("worker", { workerTier: "mid" })).selection).toEqual(
        two,
      );
      await harness.commit((tx) => assertModelPolicyTx(tx, economical), context);
      await expect(policy.save({ expected, assignments })).rejects.toThrow();
      const current = await policy.read();
      await policy.save({
        expected: { revision: current.revision, assignments: current.assignments },
        assignments: { ...assignments, worker: null },
      });
      await expect(
        harness.commit((tx) => assertModelPolicyTx(tx, economical), context),
      ).rejects.toThrow("changed");
      await expect(policy.resolveModelForRole("worker")).rejects.toThrow("Select a model");
      expect((await policy.resolveModelForRole("worker", { workerTier: "mid" })).selection).toEqual(
        two,
      );
      await harness.close(context);
      harness = await open();
      policy = createModelPolicy(harness, provider.models);
      expect((await policy.read()).revision).toBe(3);
      expect((await policy.read()).assignments.worker).toBeNull();
      const spy = vi.spyOn(provider.models, "getAvailable").mockResolvedValue([]);
      await expect(policy.resolveModelForRole("tangent")).rejects.toThrow("unavailable");
      const state = await policy.read();
      await expect(
        policy.save({
          expected: { revision: state.revision, assignments: state.assignments },
          assignments,
        }),
      ).rejects.toThrow("unavailable");
      spy.mockRestore();
    } finally {
      await harness.close(context);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
