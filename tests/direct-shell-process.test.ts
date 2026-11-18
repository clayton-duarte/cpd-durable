import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("recovers an uncertain reservation across actual host processes without replaying compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cpd-shell-recovery-"));
  const script = fileURLToPath(new URL("./fixtures/direct-shell-host.ts", import.meta.url));
  const children: ChildProcess[] = [];
  const start = (mode: string) => {
    const child = fork(script, [mode, dir], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    return child;
  };
  try {
    const first = start("hold");
    expect((await once(first, "message"))[0]).toEqual({ event: "held" });
    const firstExit = once(first, "exit");
    first.kill("SIGKILL");
    await firstExit;
    const second = start("recover");
    const secondExit = once(second, "exit");
    const [message] = (await once(second, "message")) as [unknown];
    expect(message).toMatchObject({
      event: "recovered",
      before: { pending: true, recoveryRequiresRestart: false, taskKnown: false },
      release: { status: "released", outcome: "unknown" },
      status: { status: "complete", output: "process-fixture", includeInContext: false },
      providerCalls: 0,
    });
    expect((await secondExit)[0]).toBe(0);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
