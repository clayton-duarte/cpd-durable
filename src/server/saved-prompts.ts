import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import {
  CreateSavedPromptSchema,
  ListSavedPromptsSchema,
  RemoveSavedPromptSchema,
  SAVED_PROMPT_LIMIT,
  SAVED_PROMPT_OPERATION_LIMIT,
  UpdateSavedPromptSchema,
  type CreateSavedPrompt,
  type RemoveSavedPrompt,
  type SavedPrompt,
  type UpdateSavedPrompt,
} from "../shared/saved-prompts.ts";

type Receipt = { prompt: SavedPrompt; deleted: boolean };
type Operation = { requestId: string; digest: string; receipt: Receipt };
const copyPrompt = (p: SavedPrompt): SavedPrompt => ({
  id: p.id,
  title: p.title,
  text: p.text,
  revision: p.revision,
});
const copyReceipt = (r: Receipt): Receipt => ({ prompt: copyPrompt(r.prompt), deleted: r.deleted });
// Private application metadata shared by all chats in this SDK session.
export const SavedPromptsDoc = defineDoc<{ prompts: SavedPrompt[]; operations: Operation[] }>({
  kind: "cpd.saved-prompts",
  version: 1,
  scope: "session",
  initial: () => ({ prompts: [], operations: [] }),
  checkpointWhen: () => true,
});

export class SavedPromptError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

export function createSavedPrompts(harness: Harness) {
  async function mutate(
    action: "create" | "update" | "remove",
    input: CreateSavedPrompt | UpdateSavedPrompt | RemoveSavedPrompt,
  ): Promise<Receipt> {
    const digest = createHash("sha256")
      .update(JSON.stringify([action, input]))
      .digest("hex");
    return harness.commit(async (tx) => {
      const doc = await tx.doc(SavedPromptsDoc);
      const previous = doc.operations.find((operation) => operation.requestId === input.requestId);
      if (previous) {
        if (previous.digest !== digest)
          throw new SavedPromptError("Request identity mismatch.", 409);
        return copyReceipt(previous.receipt);
      }
      if (doc.operations.length >= SAVED_PROMPT_OPERATION_LIMIT)
        throw new SavedPromptError("Saved prompt operation capacity reached.", 409);
      const index = doc.prompts.findIndex((item) => item.id === input.id);
      let receipt: Receipt;
      if (action === "create") {
        if (index !== -1) throw new SavedPromptError("Prompt identity already exists.", 409);
        // Prevent reuse after deletion, so an old identity never denotes a new record.
        if (doc.operations.some((operation) => operation.receipt.prompt.id === input.id))
          throw new SavedPromptError("Prompt identity already used.", 409);
        if (doc.prompts.length >= SAVED_PROMPT_LIMIT)
          throw new SavedPromptError("Saved prompt capacity reached.", 409);
        const value = CreateSavedPromptSchema.parse(input);
        const prompt = { id: value.id, title: value.title, text: value.text, revision: 1 };
        doc.prompts.push(prompt);
        receipt = { prompt, deleted: false };
      } else {
        const old = doc.prompts[index];
        if (!old) throw new SavedPromptError("Saved prompt not found.", 404);
        const value =
          action === "update"
            ? UpdateSavedPromptSchema.parse(input)
            : RemoveSavedPromptSchema.parse(input);
        if (old.revision !== value.expectedRevision)
          throw new SavedPromptError("Saved prompt revision conflict.", 409);
        if (action === "update") {
          const update = UpdateSavedPromptSchema.parse(input);
          if (old.revision === Number.MAX_SAFE_INTEGER)
            throw new SavedPromptError("Saved prompt revision exhausted.", 409);
          const prompt = {
            id: old.id,
            title: update.title,
            text: update.text,
            revision: old.revision + 1,
          };
          doc.prompts[index] = prompt;
          receipt = { prompt, deleted: false };
        } else {
          receipt = { prompt: copyPrompt(old), deleted: true };
          doc.prompts.splice(index, 1);
        }
      }
      doc.operations.push({
        requestId: input.requestId,
        digest,
        receipt: copyReceipt(receipt),
      });
      return copyReceipt(receipt);
    }, BACKGROUND_CONTEXT);
  }
  return {
    async list(cursor?: string, limit = 20) {
      const options = ListSavedPromptsSchema.parse({
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      const doc = await harness.snapshot(SavedPromptsDoc, BACKGROUND_CONTEXT);
      const sorted = (doc?.prompts ?? [])
        .filter((item) => !options.cursor || item.id > options.cursor)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const items = sorted.slice(0, options.limit).map(copyPrompt);
      return { items, nextCursor: sorted.length > options.limit ? items.at(-1)!.id : null };
    },
    async create(input: CreateSavedPrompt) {
      return mutate("create", CreateSavedPromptSchema.parse(input));
    },
    async update(input: UpdateSavedPrompt) {
      return mutate("update", UpdateSavedPromptSchema.parse(input));
    },
    async remove(input: RemoveSavedPrompt) {
      return mutate("remove", RemoveSavedPromptSchema.parse(input));
    },
  };
}
