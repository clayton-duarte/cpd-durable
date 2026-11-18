import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat";
import { openChat } from "../src/server/chat";
import { createExecution } from "../src/server/execution";
import { testModels } from "./models";
import {
  createResourceExtension,
  discoverResources,
  loadSkill,
  MAX_RESOURCE_SECTION_BYTES,
} from "../src/server/resources/index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "resources-test-")));
  roots.push(root);
  const cwd = join(root, "项目", "nested");
  await mkdir(cwd, { recursive: true });
  return { root, cwd, parent: join(root, "项目") };
}
async function put(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}
const skill = (name: string, body = "body") =>
  `---\nname: ${name}\ndescription: Helpful guidance\n---\n${body}`;

describe("resource discovery", () => {
  it("uses real cwd ancestry, ordered instructions, and nearest duplicate wins", async () => {
    const { root, cwd, parent } = await setup();
    await put(join(root, "AGENTS.md"), "outer");
    await put(join(parent, "AGENTS.md"), "inner");
    await put(join(parent, ".pi/skills/a/SKILL.md"), skill("example", "parent"));
    await put(join(cwd, ".pi/skills/b/SKILL.md"), skill("example", "nearest"));
    const alias = join(root, "alias");
    await symlink(cwd, alias);
    const result = await discoverResources(alias);
    expect(result.cwd).toBe(cwd);
    expect(
      result.instructions.filter((item) => item.path.startsWith(root)).map((item) => item.text),
    ).toEqual(["outer", "inner"]);
    expect((await loadSkill(result, "example")).resource?.text).toContain("nearest");
    expect(result.issues.some((issue) => issue.reason.includes("duplicate skill"))).toBe(true);
  });
  it("isolates cwd, rejects bad metadata, does not scan arbitrary files, and exposes templates without submission", async () => {
    const { root, cwd } = await setup();
    const other = join(root, "other");
    await mkdir(other);
    await put(
      join(cwd, ".pi/skills/bad/SKILL.md"),
      "---\nname: bad\nname: bad\ndescription: x\n---\nsecret",
    );
    await put(join(cwd, ".pi/skills/good/SKILL.md"), skill("good", "full content"));
    await put(join(cwd, ".pi/prompts/review.md"), "review $1");
    await put(join(cwd, "credentials.md"), "private marker");
    const result = await discoverResources(cwd);
    expect(result.skills.map((s) => s.name)).toEqual(["good"]);
    expect(result.issues.some((i) => i.reason.includes("malformed"))).toBe(true);
    expect(result.templates[0]?.text).toBe("review $1");
    expect(JSON.stringify(result)).not.toContain("private marker");
    expect((await discoverResources(other)).skills).toEqual([]);
    expect((await loadSkill(result, "good")).resource?.text).toContain("full content");
    expect((await loadSkill(result, "absent")).issues[0]?.reason).toBe("skill not discovered");
  });
  it("snapshots discovery and refreshes explicitly; skill load reads current body", async () => {
    const { cwd } = await setup();
    const path = join(cwd, ".pi/skills/test/SKILL.md");
    await put(path, skill("test", "before"));
    const first = await discoverResources(cwd);
    await put(path, skill("test", "after"));
    expect((await loadSkill(first, "test")).resource?.text).toContain("after");
    await put(join(cwd, "AGENTS.md"), "new instructions");
    expect(first.instructions.some((i) => i.path === join(cwd, "AGENTS.md"))).toBe(false);
    expect(
      (await discoverResources(cwd)).instructions.some((i) => i.path === join(cwd, "AGENTS.md")),
    ).toBe(true);
  });
  it("reads explicitly configured roots and reports unreadable non-files", async () => {
    const { root, cwd } = await setup();
    await put(join(root, "extra", "special", "SKILL.md"), skill("special"));
    await mkdir(join(cwd, "AGENTS.md"));
    const result = await discoverResources(cwd, { skillDirs: [join(root, "extra")] });
    expect(result.skills.some((item) => item.name === "special")).toBe(true);
    expect(
      result.issues.some(
        (item) => item.path.endsWith("AGENTS.md") && item.reason.includes("unreadable"),
      ),
    ).toBe(true);
    await expect(discoverResources(join(root, "missing"))).rejects.toThrow();
  });
  it("bounds large file disclosure and registers actual SDK extension", async () => {
    const { cwd } = await setup();
    await put(join(cwd, "AGENTS.md"), "é".repeat(30000));
    const result = await discoverResources(cwd);
    const item = result.instructions.find((i) => i.path === join(cwd, "AGENTS.md"));
    expect(item?.truncated).toBe(true);
    expect(Buffer.byteLength(item?.text ?? "")).toBeLessThanOrEqual(32768);
    const registry = createRegistry();
    registry.install(createResourceExtension());
    expect(
      registry
        .snapshot()
        .tools()
        .some(({ tool }) => tool.name === "load_skill"),
    ).toBe(true);
    expect(
      registry
        .snapshot()
        .sections()
        .some(({ section }) => section.key === "project-resources"),
    ).toBe(true);
  });
  it("parses YAML scalar styles and reports ignored optional metadata", async () => {
    const { cwd } = await setup();
    await put(
      join(cwd, ".pi/skills/good/SKILL.md"),
      "---\nname: 'good'\ndescription: 'It''s useful'\nlicense: MIT\nmetadata:\n  owner: example\n---\nbody",
    );
    await put(
      join(cwd, ".pi/skills/bad/SKILL.md"),
      "---\nname: bad\ndescription: >\n  folded text\n---\nbody",
    );
    const result = await discoverResources(cwd);
    expect(result.skills).toEqual([
      expect.objectContaining({ name: "bad", description: "folded text\n" }),
      expect.objectContaining({ name: "good", description: "It's useful" }),
    ]);
    expect(result.issues.some((i) => i.reason.includes("metadata ignored"))).toBe(true);
  });
  it("accepts CRLF, Unicode, literal strings and comments without changing the loaded body", async () => {
    const { cwd } = await setup();
    const raw =
      "---\r\nname: literal # comment\r\ndescription: |\r\n  第一行\r\n  next line\r\nlicense: MIT\r\nallowed-tools: [read, bash]\r\n---\r\nBody\r\n";
    await put(join(cwd, ".pi/skills/literal/SKILL.md"), raw);
    const result = await discoverResources(cwd);
    expect(result.skills).toEqual([
      expect.objectContaining({ name: "literal", description: "第一行\nnext line\n" }),
    ]);
    expect(result.issues.some((i) => i.reason.includes("metadata ignored"))).toBe(true);
    expect((await loadSkill(result, "literal")).resource?.text).toBe(raw);
  });
  it("rejects duplicate keys, tags, aliases, deep nodes, unsafe keys and non-string fields", async () => {
    const { cwd } = await setup();
    const bad = [
      "name: x\nname: x\ndescription: ok",
      "name: x\ndescription: !custom hello",
      "name: x\ndescription: &a hello\nother: *a",
      `name: x\ndescription: ok\nother: ${"[".repeat(100)}x${"]".repeat(100)}`,
      "name: x\ndescription: ok\n__proto__: {polluted: true}",
      "name: x\ndescription: ok\nconstructor: bad",
      "name: x\ndescription: true",
      "name: x\ndescription: 123",
      "name: x\ndescription: {text: hi}",
      "name: 42\ndescription: ok",
      "name: x\ndescription: ok\n...\n---\nname: y",
      "name: x\ndescription: [unclosed",
      "",
      `name: x\ndescription: ok\nother: &huge ${"a".repeat(12000)}`,
    ];
    for (const [i, source] of bad.entries())
      await put(join(cwd, `.pi/skills/bad${i}/SKILL.md`), `---\n${source}\n---\nbody`);
    const result = await discoverResources(cwd);
    expect(result.skills).toEqual([]);
    expect(result.issues.filter((i) => i.reason.includes("malformed or unsupported"))).toHaveLength(
      bad.length,
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it("selects the nearest valid name when a nearer directory contains invalid metadata", async () => {
    const { cwd, parent } = await setup();
    await put(
      join(cwd, ".pi/skills/near/SKILL.md"),
      "---\nname: choice\ndescription: false\n---\ninvalid",
    );
    await put(join(parent, ".pi/skills/far/SKILL.md"), skill("choice", "valid"));
    const result = await discoverResources(cwd);
    expect((await loadSkill(result, "choice")).resource?.text).toContain("valid");
    expect(result.issues.some((i) => i.reason.includes("malformed"))).toBe(true);
  });
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO and its symlink without opening a reader",
    async () => {
      const { root, cwd } = await setup();
      const fifo = join(root, "fifo");
      execFileSync("mkfifo", [fifo]);
      await symlink(fifo, join(cwd, "AGENTS.md"));
      const result = await discoverResources(cwd);
      expect(
        result.issues.some(
          (i) => i.path === join(cwd, "AGENTS.md") && i.reason.includes("unreadable"),
        ),
      ).toBe(true);
    },
  );
  it("bounds the complete serialized section with nearest instructions and omission counts", async () => {
    const { root, parent, cwd } = await setup();
    await put(join(root, "AGENTS.md"), "outer" + "é".repeat(15000));
    await put(join(parent, "AGENTS.md"), "middle" + "é".repeat(15000));
    await put(join(cwd, "AGENTS.md"), "nearest" + "é".repeat(15000));
    for (let i = 0; i < 90; i++) {
      await put(
        join(cwd, `.pi/skills/s${i}/SKILL.md`),
        `---\nname: s${i}\ndescription: ${"x".repeat(1000)}\n---\nbody`,
      );
    }
    for (let i = 0; i < 50; i++) {
      await put(join(cwd, `.pi/skills/invalid${i}/SKILL.md`), "invalid");
    }
    const extension = createResourceExtension();
    const section = extension.sections![0]!;
    const env = new NodeExecutionEnv({ cwd });
    try {
      const text = await section.render(
        { env } as unknown as Parameters<typeof section.render>[0],
        BACKGROUND_CONTEXT,
      );
      expect(text).toBeDefined();
      expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(MAX_RESOURCE_SECTION_BYTES);
      const payload = JSON.parse(text!) as {
        instructions: { text: string }[];
        omittedInstructions: number;
        omittedSkills: number;
      };
      expect(payload.instructions.some((i) => i.text.startsWith("nearest"))).toBe(true);
      expect(payload.omittedInstructions).toBeGreaterThan(0);
      expect(payload.omittedSkills).toBeGreaterThan(0);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });
  it("reports directory and configured-root discovery limits", async () => {
    const { cwd } = await setup();
    for (let i = 0; i < 205; i++) await put(join(cwd, `.pi/skills/s${i}/SKILL.md`), skill(`s${i}`));
    const result = await discoverResources(cwd, {
      promptDirs: Array.from({ length: 35 }, (_, i) => `missing-${i}`),
    });
    expect(result.skills.length).toBe(200);
    expect(result.issues.some((i) => i.reason.includes("additional entries excluded"))).toBe(true);
    expect(result.issues.some((i) => i.reason.includes("3 configured prompt roots excluded"))).toBe(
      true,
    );
  });
  it("runs SDK request sections and load_skill in each conversation cwd and refreshes on subsequent requests", async () => {
    const { root, cwd } = await setup();
    const other = join(root, "other");
    await mkdir(other);
    await put(join(cwd, "AGENTS.md"), "cwd-one-before");
    await put(join(other, "AGENTS.md"), "cwd-two-only");
    const rawSkill =
      "---\r\nname: one\r\ndescription: >\r\n  folded skill\r\n  description\r\nlicense: MIT\r\n---\r\nskill-one-body\r\n";
    await put(join(cwd, ".pi/skills/one/SKILL.md"), rawSkill);
    const registry = createRegistry();
    registry.install(createResourceExtension());
    const provider = testModels();
    const environments: NodeExecutionEnv[] = [];
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: provider.models,
        registry,
        env: ({ cwd: directory }) => {
          const env = new NodeExecutionEnv({ cwd: directory! });
          environments.push(env);
          return env;
        },
      },
      BACKGROUND_CONTEXT,
    );
    const model = { provider: PROVIDER_ID, modelId: MODEL_ID };
    try {
      const first = await harness.root(BACKGROUND_CONTEXT, { agent: { cwd, model } });
      const second = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: other, model } },
        BACKGROUND_CONTEXT,
      );
      await first.submit({ type: "input", content: "first" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      const original = JSON.stringify(provider.calls[0]!.context.messages);
      expect(original).toContain("cwd-one-before");
      expect(original).toContain("folded skill description");
      expect(original).not.toContain("cwd-two-only");
      await put(join(cwd, "AGENTS.md"), "cwd-one-after");
      const updatedSkill = rawSkill.replace("folded skill", "refreshed skill");
      await put(join(cwd, ".pi/skills/one/SKILL.md"), updatedSkill);
      expect(JSON.stringify(provider.calls[0]!.context.messages)).toBe(original);
      provider.calls[0]!.tools([
        { id: "skill-call", name: "load_skill", arguments: { name: "one" } },
      ]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      const next = JSON.stringify(provider.calls[1]!.context.messages);
      expect(next).toContain("skill-one-body");
      expect(next).toContain(JSON.stringify(JSON.stringify(updatedSkill)).slice(1, -1));
      expect(next).toContain("refreshed skill description");
      expect(next).toContain("cwd-one-after");
      provider.calls[1]!.finish("done");
      await first.waitForIdle(BACKGROUND_CONTEXT);
      await second.submit({ type: "input", content: "second" }, BACKGROUND_CONTEXT);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(3));
      const secondPrompt = JSON.stringify(provider.calls[2]!.context.messages);
      expect(secondPrompt).toContain("cwd-two-only");
      expect(secondPrompt).not.toContain("cwd-one-after");
      provider.calls[2]!.tools([{ id: "missing", name: "load_skill", arguments: { name: "one" } }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(4));
      expect(JSON.stringify(provider.calls[3]!.context.messages)).toContain("skill not discovered");
      provider.calls[3]!.finish("done");
      await second.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await Promise.all(environments.map((env) => env.cleanup(BACKGROUND_CONTEXT)));
    }
  });
  it("installs resource guidance and skill loading in the actual host execution registry", async () => {
    const { root, cwd } = await setup();
    await put(join(cwd, "AGENTS.md"), "host-specific-project-guidance");
    await put(join(cwd, ".pi/skills/host/SKILL.md"), skill("host", "host-specific-skill-body"));
    const execution = createExecution(cwd);
    try {
      expect(execution.registry.snapshot().extension("cpd-resources")).toBeDefined();
      expect(
        execution.registry
          .snapshot()
          .tools()
          .map(({ tool }) => tool.name),
      ).toContain("load_skill");
    } finally {
      await execution.close();
    }
    const provider = testModels();
    const chat = await openChat(join(root, "data"), provider.models, cwd);
    try {
      await chat.conversation.submit(
        { type: "input", content: "Exercise resources" },
        BACKGROUND_CONTEXT,
      );
      await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
      const prompt = JSON.stringify(provider.calls[0]!.context.messages);
      expect(prompt).toContain("host-specific-project-guidance");
      expect(prompt).toContain("Helpful guidance");
      expect(prompt).not.toContain("host-specific-skill-body");
      provider.calls[0]!.tools([
        { id: "host-skill", name: "load_skill", arguments: { name: "host" } },
      ]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
      expect(JSON.stringify(provider.calls[1]!.context.messages)).toContain(
        "host-specific-skill-body",
      );
      provider.calls[1]!.finish("done");
      await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
      await chat.close();
    }
  });
});
