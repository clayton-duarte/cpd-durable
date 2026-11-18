import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/server/app.ts";
import { openChat } from "../src/server/chat.ts";
import { testModels } from "./models.ts";

describe("production worker composition", () => {
  it("launches configured workers from a main and tangent and guards lifecycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "production-workers-"));
    const provider = testModels();
    const host = await openChat(dir, provider.models, dir);
    try {
      const app = createApp(host);
      const policy = await host.modelPolicy.read();
      const choice = policy.choices[0]!;
      const selected = {
        provider: choice.provider,
        modelId: choice.modelId,
        thinkingLevel: choice.thinkingLevels[0]!,
      };
      await host.modelPolicy.save({
        expected: { revision: policy.revision, assignments: policy.assignments },
        assignments: { ...policy.assignments, worker: selected, tangent: selected },
      });
      const main = String(host.conversation.id);
      const post = (path: string, body: unknown) =>
        app.request(`http://localhost:3000${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const tangent = await post(`/api/chats/${main}/tangents`, {
        requestId: "child",
        parentId: Number(main),
        sourceId: Number(main),
        sourceEntryId: null,
        title: "Child",
        start: false,
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
      });
      expect(tangent.status).toBe(201);
      const child = String(((await tangent.json()) as { tangent: { id: number } }).tangent.id);
      const request = {
        mode: "background",
        delivery: "notify-only",
        assignment: "Investigate",
        context: "Synthetic",
      };
      expect(
        (await post(`/api/chats/${main}/workers`, { ...request, requestId: "main-worker" })).status,
      ).toBe(202);
      expect(
        (
          await post(`/api/chats/${child}/workers`, {
            ...request,
            requestId: "child-worker",
            modelRole: "mid",
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const view = (await (
        await app.request(`http://localhost:3000/api/chats/${child}/workers`)
      ).json()) as { helpers: { childId: string; model: unknown }[] };
      expect(view.helpers[0]!.model).toEqual({
        provider: selected.provider,
        modelId: selected.modelId,
      });
      expect(
        (
          await post(`/api/chats/${main}/tangents/${child}/lifecycle`, {
            expected: "open",
            next: "concluded",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(`/api/chats/${view.helpers[0]!.childId}/workers`, {
            ...request,
            requestId: "nested",
          })
        ).status,
      ).toBe(404);
      for (const call of provider.calls) call.finish("done");
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
