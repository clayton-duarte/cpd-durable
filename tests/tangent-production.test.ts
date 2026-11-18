import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { TangentViewSchema } from "../src/shared/tangents.ts";
import { testModels } from "./models.ts";

describe("production tangent integration", () => {
  it("uses configured policy for the registered model tool and isolates the child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "production-tangent-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const policy = await host.modelPolicy.read();
      const choice = policy.choices.find((entry) => entry.thinkingLevels.length > 0)!;
      const selected = {
        provider: choice.provider,
        modelId: choice.modelId,
        thinkingLevel: choice.thinkingLevels[0]!,
      };
      await host.modelPolicy.save({
        expected: { revision: policy.revision, assignments: policy.assignments },
        assignments: { ...policy.assignments, tangent: selected },
      });
      const base = `http://localhost:3000/api/chats/${host.conversation.id}/tangents`;
      await host.conversation.submit(
        { type: "input", content: "Create a tangent" },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      const entries = await host.conversation.entries(
        { order: "ascending" },
        20,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const sourceEntryId = entries.items.at(-1)!.id;
      provider.calls[0]!.tools([
        {
          id: "tangent-tool",
          name: "create_tangent",
          arguments: {
            requestId: "production-tool",
            sourceEntryId,
            title: "Independent",
            start: true,
            handoff: {
              goal: "Investigate",
              decisions: [],
              constraints: [],
              exclusions: [],
              references: [],
              suggestedSkills: [],
              discretion: "",
              deliverable: "",
              evidence: "",
              limits: "",
            },
          },
        },
      ]);
      await vi.waitFor(() => expect(provider.calls.length).toBeGreaterThanOrEqual(3));
      const response = await app.request(base);
      const body = (await response.json()) as { tangents: unknown[] };
      const item = TangentViewSchema.parse(body.tangents[0]);
      expect(item.model).toMatchObject(selected);
      expect(item.startState).toBe("admitted");
      expect((await host.chats.list()).chats.some((entry) => entry.id === String(item.id))).toBe(
        false,
      );
      const child = await host.chats.resolve(String(item.id));
      expect((await child!.configuration()).selection).toEqual(selected);
      expect(
        (await app.request(`http://localhost:3000/api/chats/${item.id}/questions`)).status,
      ).toBe(200);
      await app.request(`http://localhost:3000/api/chats/${host.conversation.id}/stop`, {
        method: "POST",
      });
      const after = await app.request(`${base}/${item.id}`);
      expect(
        TangentViewSchema.parse(((await after.json()) as { tangent: unknown }).tangent).activity,
      ).toBe("running");
      await app.request(`http://localhost:3000/api/chats/${item.id}/stop`, { method: "POST" });
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
