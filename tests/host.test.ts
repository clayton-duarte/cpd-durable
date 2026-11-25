import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

const children: ChildProcess[] = [];
const directories: string[] = [];

function start(dataDir: string, piDir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: {
      ...process.env,
      CPD_DATA_DIR: dataDir,
      PI_CODING_AGENT_DIR: piDir,
      OPENCODE_API_KEY: "",
      OPENAI_API_KEY: "",
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a second host before opening storage and restarts after a hard kill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-host-test-"));
  directories.push(directory);
  const piDir = join(directory, "pi");
  await mkdir(piDir);
  await writeFile(
    join(piDir, "auth.json"),
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "test-only",
        refresh: "test-only",
        expires: Date.now() + 3600000,
      },
      anthropic: { type: "api_key", key: "test-only" },
    }),
  );
  const first = start(directory, piDir);
  await vi.waitFor(() => expect(first.output()).toContain("CPD Durable:"), { timeout: 10_000 });
  const policy = await fetch("http://127.0.0.1:3000/api/model-policy");
  expect(policy.ok).toBe(true);
  const body = (await policy.json()) as { choices: { provider: string }[] };
  expect(body.choices.map(({ provider }) => provider)).toEqual(
    expect.arrayContaining(["openai", "anthropic"]),
  );
  expect(JSON.stringify(body)).not.toContain("test-only");
  const secondDirectory = join(directory, "second-host");
  const second = start(secondDirectory, piDir);
  await once(second.child, "exit");
  expect(second.child.exitCode).toBe(1);
  await expect(stat(secondDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  const killed = once(first.child, "exit");
  first.child.kill("SIGKILL");
  await killed;
  const resumed = start(directory, piDir);
  await vi.waitFor(() => expect(resumed.output()).toContain("CPD Durable:"), { timeout: 10_000 });
  expect((await stat(join(directory, "session.sqlite"))).mode & 0o777).toBe(0o600);
  // Startup alone must not send anything to the real provider.
  const response = await fetch("http://127.0.0.1:3000/api/events");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"messages":[]');
  await reader.cancel();
});

it("invalid server configuration fails before creating session files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-config-test-"));
  directories.push(directory);
  const piDir = join(directory, "not-created");
  const host = start("", piDir);
  await once(host.child, "exit");
  expect(host.child.exitCode).toBe(1);
  expect(host.output()).toContain("Invalid CPD server configuration");
  await expect(stat(piDir)).rejects.toMatchObject({ code: "ENOENT" });
});
