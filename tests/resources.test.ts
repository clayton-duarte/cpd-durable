import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createRegistry } from "@earendil-works/pi-durable";
import {
  createResourceExtension,
  discoverResources,
  loadSkill,
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
});
