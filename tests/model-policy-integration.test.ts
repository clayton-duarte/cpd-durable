import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { ModelPolicyViewSchema } from "../src/shared/model-policy.ts";
import { testModels } from "./models.ts";

describe("model settings host integration", () => {
  it("protects settings and applies new tiers to existing, archived and new chats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "policy-host-"));
    const provider = testModels();
    let host = await openChat(dir, provider.models, dir);
    try {
      let app = createApp(host);
      const get = () => app.request("http://localhost:3000/api/model-policy");
      const post = (body: unknown) =>
        app.request("http://localhost:3000/api/model-policy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await app.request("http://evil.test/api/model-policy")).status).toBe(403);
      expect(
        (
          await app.request("http://localhost:3000/api/model-policy", {
            headers: { origin: "http://evil.test" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request("http://localhost:3000/api/model-policy", {
            headers: { "sec-fetch-site": "cross-site" },
          })
        ).status,
      ).toBe(403);
      expect((await post({})).status).toBe(400);
      const response = await get();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const initial = ModelPolicyViewSchema.parse(await response.json());
      const root = await host.chats.resolve(String(host.conversation.id));
      const before = await root!.configuration();
      const empty = await host.chats.create("first");
      await host.chats.rename(empty.id, "Archived", empty.title);
      await host.chats.change(empty.id, "archive");
      const reusable = await host.chats.create("reusable");
      const option = initial.choices.find((choice) => choice.modelId !== before.selection.modelId)!;
      const selection = {
        provider: option.provider,
        modelId: option.modelId,
        thinkingLevel: option.thinkingLevels[0]!,
      };
      const expected = { revision: initial.revision, assignments: initial.assignments };
      const assignments = { ...initial.assignments, main: selection };
      expect((await post({ expected, assignments })).status).toBe(200);
      expect((await post({ expected, assignments })).status).toBe(409);
      expect((await root!.configuration()).selection).toEqual(selection);
      expect((await host.chats.create("reuse")).id).toBe(reusable.id);
      expect((await (await host.chats.resolve(empty.id))!.configuration()).selection).toEqual(
        selection,
      );
      await host.chats.rename(reusable.id, "Named", "New chat");
      const created = await host.chats.create("new");
      expect(created.id).not.toBe(reusable.id);
      expect((await (await host.chats.resolve(created.id))!.configuration()).selection).toEqual(
        selection,
      );
      const saved = ModelPolicyViewSchema.parse(await (await get()).json());
      const { provider: providerId, modelId } = selection;
      expect(
        (
          await post({
            expected: { revision: saved.revision, assignments: saved.assignments },
            assignments: { ...saved.assignments, main: { provider: providerId, modelId } },
          })
        ).status,
      ).toBe(200);
      expect((await (await host.chats.resolve(created.id))!.configuration()).selection).toEqual({
        provider: providerId,
        modelId,
        thinkingLevel: "default",
      });
      expect(provider.calls).toHaveLength(0);
      await host.close();
      host = await openChat(dir, provider.models, dir);
      app = createApp(host);
      expect(ModelPolicyViewSchema.parse(await (await get()).json()).assignments.main).toEqual({
        ...selection,
        thinkingLevel: "default",
      });
      expect((await (await host.chats.resolve(created.id))!.configuration()).selection).toEqual({
        ...selection,
        thinkingLevel: "default",
      });
    } finally {
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
