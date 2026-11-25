import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { ConfigurationSchema, type Selection } from "../src/shared/configuration.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { testModels } from "./models.ts";

describe("durable model configuration", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let provider: ReturnType<typeof testModels>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-config-"));
    provider = testModels();
    chat = await openChat(directory, provider.models, directory);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function read(id = String(chat.conversation.id)) {
    const response = await createApp(chat).request(
      `http://localhost:3000/api/chats/${id}/configuration`,
    );
    expect(response.status).toBe(200);
    return ConfigurationSchema.parse(await response.json());
  }
  function save(expected: Selection, selection: Selection, id = String(chat.conversation.id)) {
    return createApp(chat).request(`http://localhost:3000/api/chats/${id}/configuration`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected, selection }),
    });
  }
  it("lists authenticated supported choices, persists model/thinking per chat, and retains reopen selection", async () => {
    const initial = await read();
    const choice = initial.choices.find((choice) => choice.modelId !== initial.selection.modelId)!;
    expect(choice).toBeDefined();
    const next = {
      provider: choice.provider,
      modelId: choice.modelId,
      thinkingLevel: choice.thinkingLevels.filter((level) => level !== "max").at(-1)!,
    };
    const second = await chat.chats.create(crypto.randomUUID());
    expect((await save(initial.selection, next)).status).toBe(200);
    expect((await read(second.id)).selection).toEqual(initial.selection);
    expect((await read()).selection).toEqual(next);
    expect((await save(initial.selection, next)).status).toBe(200);
    await chat.close();
    chat = await openChat(directory, testModels().models, directory);
    expect((await read()).selection).toEqual(next);
    expect((await chat.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual({
      provider: next.provider,
      modelId: next.modelId,
    });
  });
  it("rejects unknown choices/efforts, stale writes, archived mutation and deleted reads", async () => {
    const initial = await read();
    const choice = initial.choices.find((choice) => choice.modelId !== initial.selection.modelId)!;
    const next = {
      provider: choice.provider,
      modelId: choice.modelId,
      thinkingLevel: choice.thinkingLevels[0]!,
    };
    expect((await save(initial.selection, { ...next, provider: "not-configured" })).status).toBe(
      409,
    );
    expect((await save(initial.selection, { ...next, modelId: "unknown" })).status).toBe(409);
    expect((await save(initial.selection, next)).status).toBe(200);
    const third = initial.choices.find(
      (choice) => choice.modelId !== next.modelId && choice.modelId !== initial.selection.modelId,
    )!;
    const other = {
      provider: third.provider,
      modelId: third.modelId,
      thinkingLevel: third.thinkingLevels[0]!,
    };
    expect((await save(initial.selection, other)).status).toBe(409);
    await chat.chats.change(String(chat.conversation.id), "archive");
    expect((await save(next, initial.selection)).status).toBe(409);
    await chat.chats.change(String(chat.conversation.id), "delete");
    expect((await save(next, initial.selection)).status).toBe(404);
  });
  it("changes subsequent request configuration without mutating an in-flight request or transcript", async () => {
    const initial = await read();
    await chat.conversation.submit({ type: "input", content: "Work" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    const choice = initial.choices.find((choice) => choice.modelId !== initial.selection.modelId)!;
    const next = {
      provider: choice.provider,
      modelId: choice.modelId,
      thinkingLevel: choice.thinkingLevels[0]!,
    };
    const originalPrompt = JSON.stringify(provider.calls[0]!.context);
    expect((await save(initial.selection, next)).status).toBe(200);
    expect(JSON.stringify(provider.calls[0]!.context)).toBe(originalPrompt);
    provider.calls[0]!.finish("First");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await chat.conversation.submit({ type: "input", content: "Next" }, BACKGROUND_CONTEXT);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    expect(JSON.stringify(provider.calls[1]!.context)).toContain(next.modelId);
    provider.calls[1]!.finish("Second");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });
  it("rejects thinking on a model whose server catalogue reports no reasoning", async () => {
    const initial = await read();
    const model = provider.models.getModels()[0]!;
    const spy = vi
      .spyOn(provider.models, "getAvailable")
      .mockResolvedValue([{ ...model, reasoning: false }]);
    try {
      const choice = (await read()).choices[0]!;
      expect(choice.thinkingLevels).toEqual(["off"]);
      expect(
        (
          await save(initial.selection, {
            provider: choice.provider,
            modelId: choice.modelId,
            thinkingLevel: "high",
          })
        ).status,
      ).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });
  it("does not list models for an unconfigured provider", async () => {
    await chat.close();
    const models = createModels({
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(opencodeGoProvider());
    chat = await openChat(directory, models, directory);
    expect((await read()).choices).toEqual([]);
  });
  it("advertises Max for display but rejects it even when the provider supports it", async () => {
    const model = provider.models.getModels()[0]!;
    const spy = vi
      .spyOn(provider.models, "getAvailable")
      .mockResolvedValue([{ ...model, reasoning: true, thinkingLevelMap: { max: "max" } }]);
    try {
      const { selection, choices } = await read();
      const choice = choices[0]!;
      expect(choice.thinkingLevels).toContain("max");
      expect(
        (
          await save(selection, {
            provider: choice.provider,
            modelId: choice.modelId,
            thinkingLevel: "max",
          })
        ).status,
      ).toBe(409);
      const { revision, assignments } = await chat.modelPolicy.read();
      await expect(
        chat.modelPolicy.save({
          expected: { revision, assignments },
          assignments: {
            ...assignments,
            main: { provider: choice.provider, modelId: choice.modelId, thinkingLevel: "max" },
          },
        }),
      ).rejects.toThrow("unavailable");
      expect(provider.calls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
