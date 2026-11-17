import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

const children: ChildProcess[] = [];
const directories: string[] = [];

function start(dataDir: string, key = "test-only") {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, CPD_DATA_DIR: dataDir, OPENCODE_API_KEY: key },
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
  const first = start(directory);
  await vi.waitFor(() => expect(first.output()).toContain("CPD Durable:"), { timeout: 10_000 });
  const secondDirectory = join(directory, "second-host");
  const second = start(secondDirectory);
  await once(second.child, "exit");
  expect(second.child.exitCode).toBe(1);
  await expect(stat(secondDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  const killed = once(first.child, "exit");
  first.child.kill("SIGKILL");
  await killed;
  const resumed = start(directory);
  await vi.waitFor(() => expect(resumed.output()).toContain("CPD Durable:"), { timeout: 10_000 });
  expect((await stat(join(directory, "session.sqlite"))).mode & 0o777).toBe(0o600);
  // Startup alone must not send anything to the real provider.
  const response = await fetch("http://127.0.0.1:3000/api/events");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing SSE body");
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"messages":[]');
  await reader.cancel();
});

it("missing credentials fail closed before creating session files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpd-config-test-"));
  directories.push(directory);
  const data = join(directory, "not-created");
  const host = start(data, "");
  await once(host.child, "exit");
  expect(host.child.exitCode).toBe(1);
  expect(host.output()).toContain("Set OPENCODE_API_KEY");
  await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
});
