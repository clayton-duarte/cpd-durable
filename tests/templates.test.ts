import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import { TemplateContentSchema, TemplateListSchema } from "../src/shared/templates.ts";
import { testModels } from "./models.ts";

describe("conversation prompt templates", () => {
  it("scopes discovery to SDK cwd, reads no prompts, and rejects stale content and deleted chats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpd-template-test-"));
    const cwd = join(dir, "project");
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    const path = join(cwd, ".pi", "prompts", "review.md");
    await writeFile(path, "Review $1 literally");
    await writeFile(join(cwd, ".pi", "prompts", "long.md"), "x".repeat(40000));
    await symlink(path, join(cwd, ".pi", "prompts", "alias.md"));
    execFileSync("mkfifo", [join(cwd, ".pi", "prompts", "pipe.md")]);
    const provider = testModels();
    const chat = await openChat(join(dir, "data"), provider.models, cwd);
    try {
      const app = createApp(chat);
      const id = String(chat.conversation.id);
      const url = `http://localhost:3000/api/chats/${id}/templates`;
      const response = await app.request(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const list = TemplateListSchema.parse(await response.json());
      const entry = list.templates.find((template) => template.name === "review")!;
      expect(list.templates.find((template) => template.name === "long")?.truncated).toBe(true);
      expect(list.templates.some((template) => template.name === "alias")).toBe(true);
      expect(list.templates.some((template) => template.name === "pipe")).toBe(false);
      expect(list.issues.some((issue) => issue.path.endsWith("pipe.md"))).toBe(true);
      expect(entry.path).toBe(await realpath(path));
      const selection = `${url}/${entry.id}?fingerprint=${entry.fingerprint}`;
      const content = await app.request(selection);
      expect(TemplateContentSchema.parse(await content.json()).text).toBe("Review $1 literally");
      expect(provider.calls).toHaveLength(0);
      await writeFile(path, "Changed");
      expect((await app.request(selection)).status).toBe(409);
      expect(
        (await app.request(`${url}/..%2Fsecrets?fingerprint=${entry.fingerprint}`)).status,
      ).not.toBe(200);
      expect(
        (await app.request(url, { headers: { origin: "http://invalid.example" } })).status,
      ).toBe(403);
      await chat.chats.change(id, "archive");
      expect((await app.request(url)).status).toBe(200);
      await chat.chats.change(id, "delete");
      expect((await app.request(url)).status).toBe(404);
    } finally {
      await chat.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
