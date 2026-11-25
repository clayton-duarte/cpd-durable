import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { supportsThinking, type Selection } from "../shared/configuration.ts";
import {
  AssignmentsSchema,
  ModelChoicesSchema,
  ModelPolicyChangeSchema,
  ModelPolicySchema,
  ModelRoleSchema,
  type ModelChoice,
  type ModelPolicy,
  type ModelRole,
} from "../shared/model-policy.ts";
import { modelChoices, sameSelection } from "./configuration.ts";

export const ModelPolicyDoc = defineDoc<ModelPolicy>({
  kind: "cpd.model-policy",
  version: 1,
  scope: "session",
  initial: () => ({ revision: 0, assignments: { main: null, tangent: null, worker: null } }),
  checkpointWhen: () => true,
});

export class ModelPolicyError extends Error {
  readonly status = 409;
}

function sameNullable(a: Selection | null, b: Selection | null): boolean {
  return a === null ? b === null : b !== null && sameSelection(a, b);
}
function samePolicy(a: ModelPolicy, b: ModelPolicy): boolean {
  return (
    a.revision === b.revision &&
    (["main", "tangent", "worker"] as const).every((role) =>
      sameNullable(a.assignments[role], b.assignments[role]),
    )
  );
}
function validate(selection: Selection, choices: readonly ModelChoice[]) {
  const choice = choices.find(
    (item) => item.provider === selection.provider && item.modelId === selection.modelId,
  );
  if (!choice || !supportsThinking(choice.thinkingLevels, selection.thinkingLevel))
    throw new ModelPolicyError(
      "Model or thinking level is unavailable. Select an available model in Settings.",
    );
}

/** Read inside the caller's SDK transaction when composing creation or admission. */
export async function readModelPolicyTx(tx: Tx): Promise<ModelPolicy> {
  return ModelPolicySchema.parse(await tx.doc(ModelPolicyDoc));
}

/** Recheck the previously resolved revision and selection in the launch transaction. */
export async function assertModelPolicyTx(tx: Tx, resolved: ResolvedModel): Promise<void> {
  const current = await readModelPolicyTx(tx);
  if (
    current.revision !== resolved.revision ||
    !sameNullable(current.assignments[resolved.assignment], resolved.selection)
  )
    throw new ModelPolicyError("Model settings changed. Refresh and try again.");
}

export type ResolvedModel = {
  selection: Selection;
  revision: number;
  assignment: ModelRole;
};

export type MainModelDecision = { revision: number; selection: Selection | null };

/** Null means the explicitly retained host default, not a resolved model tier. */
export async function assertMainModelDecisionTx(tx: Tx, decision: MainModelDecision) {
  const current = await readModelPolicyTx(tx);
  if (
    current.revision !== decision.revision ||
    !sameNullable(current.assignments.main, decision.selection)
  )
    throw new ModelPolicyError("Model settings changed. Refresh and try again.");
}

export function createModelPolicy(
  harness: Harness,
  models: Models,
  apply: (tx: Tx, policy: ModelPolicy) => Promise<void>,
) {
  async function choices() {
    return ModelChoicesSchema.parse(await modelChoices(models));
  }
  return {
    async prepareMainCreation(): Promise<MainModelDecision> {
      const policy = await harness.commit((tx) => readModelPolicyTx(tx), BACKGROUND_CONTEXT);
      if (policy.assignments.main) validate(policy.assignments.main, await choices());
      return { revision: policy.revision, selection: policy.assignments.main };
    },
    async read() {
      const available = await choices();
      const policy = await harness.commit((tx) => readModelPolicyTx(tx), BACKGROUND_CONTEXT);
      return { ...policy, choices: available };
    },
    async save(input: unknown) {
      const change = ModelPolicyChangeSchema.parse(input);
      const next = AssignmentsSchema.parse(change.assignments);
      const available = await choices();
      for (const value of Object.values(next)) if (value) validate(value, available);
      return harness.commit(async (tx) => {
        const current = await tx.doc(ModelPolicyDoc);
        if (!samePolicy(ModelPolicySchema.parse(current), change.expected))
          throw new ModelPolicyError("Model settings changed. Refresh and review your choices.");
        if (current.revision >= Number.MAX_SAFE_INTEGER)
          throw new ModelPolicyError("Model settings revision exhausted.");
        current.assignments = next;
        current.revision++;
        const saved = ModelPolicySchema.parse(current);
        await apply(tx, saved);
        return saved;
      }, BACKGROUND_CONTEXT);
    },
    async resolveModelForRole(
      role: ModelRole,
      options?: { workerTier?: "economical" | "mid" },
    ): Promise<ResolvedModel> {
      ModelRoleSchema.parse(role);
      if (
        options?.workerTier !== undefined &&
        options.workerTier !== "economical" &&
        options.workerTier !== "mid"
      )
        throw new ModelPolicyError("Unknown worker tier.");
      if (options?.workerTier !== undefined && role !== "worker")
        throw new ModelPolicyError("Worker tier applies only to workers.");
      const available = await choices();
      const policy = await harness.commit((tx) => readModelPolicyTx(tx), BACKGROUND_CONTEXT);
      const assignment = role === "worker" && options?.workerTier === "mid" ? "tangent" : role;
      const selection = policy.assignments[assignment];
      if (!selection)
        throw new ModelPolicyError(`Select a model for ${assignment} in Settings before starting.`);
      validate(selection, available);
      return { selection, revision: policy.revision, assignment };
    },
  };
}
