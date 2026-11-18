import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { workingDirectory } from "../src/server/execution.ts";
import { present } from "../src/server/presentation.ts";
import { ChatStateSchema } from "../src/shared/chat.ts";
import { testModels } from "./models.ts";

describe("native host tools through the durable scheduler", () => {
  let directory: string;
  let cwd: string;
  let provider: ReturnType<typeof testModels>;
  let chat: Awaited<ReturnType<typeof openChat>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-native-tools-"));
    cwd = join(directory, "work");
    await mkdir(cwd);
    provider = testModels();
    chat = await openChat(join(directory, "data"), provider.models, cwd);
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function snapshot() {
    const watch = await chat.conversation.watch(BACKGROUND_CONTEXT);
    try {
      return ChatStateSchema.parse(present(watch.value));
    } finally {
      await watch.stop();
    }
  }
  async function start() {
    await chat.conversation.submit(
      { type: "input", content: "Exercise synthetic tools." },
      BACKGROUND_CONTEXT,
    );
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  }

  it("expands the home default and explicit home-relative working directories", () => {
    expect(workingDirectory()).toBe(homedir());
    expect(workingDirectory("~/example")).toBe(join(homedir(), "example"));
  });

  it("writes, reads, edits and runs shell commands, including paths outside cwd", async () => {
    await start();
    const rounds = [
      { name: "write", arguments: { path: "sample.txt", content: "before" } },
      { name: "read", arguments: { path: "sample.txt" } },
      {
        name: "edit",
        arguments: { path: "sample.txt", edits: [{ oldText: "before", newText: "after" }] },
      },
      {
        name: "bash",
        arguments: { command: "pwd; cat sample.txt; printf 'outside' > ../outside.txt" },
      },
    ];
    for (const [index, round] of rounds.entries()) {
      provider.calls[index]!.tools([{ id: `call-${index}`, ...round }]);
      await vi.waitFor(() => expect(provider.calls).toHaveLength(index + 2));
    }
    const next = provider.calls.at(-1)!;
    expect(next.context.messages.filter((message) => message.role === "toolResult")).toHaveLength(
      4,
    );
    expect(JSON.stringify(next.context.messages)).toContain("before");
    expect(JSON.stringify(next.context.messages)).toContain("after");
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("after");
    expect(await readFile(join(directory, "outside.txt"), "utf8")).toBe("outside");
    next.finish("Done.");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const state = await snapshot();
    const tools = state.messages
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "tool-call");
    expect(tools.map((part) => [part.name, part.state])).toEqual(
      rounds.map((round) => [round.name, "complete"]),
    );
    expect(tools[3]?.output).toContain(cwd);
    expect(tools.every((part) => part.resultEntryId !== undefined)).toBe(true);
  });

  it("streams shell output and Stop cancels the owned process without an approval step", async () => {
    await start();
    provider.calls[0]!.tools([
      {
        id: "slow",
        name: "bash",
        arguments: { command: "printf 'started\\n'; sleep 30; printf 'unexpected\\n'" },
      },
    ]);
    await vi.waitFor(async () => {
      const parts = (await snapshot()).messages.flatMap((message) => message.parts ?? []);
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          state: "running",
          output: expect.stringContaining("started") as unknown,
        }),
      );
    });
    await chat.conversation.abort(BACKGROUND_CONTEXT);
    const parts = (await snapshot()).messages.flatMap((message) => message.parts ?? []);
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-call", state: "cancelled" }),
    );
    expect(JSON.stringify(parts)).not.toContain("unexpected\n");
    expect((await snapshot()).busy).toBe(false);
  });

  it("keeps nonzero exits as failed tool results, then lets the model continue", async () => {
    await start();
    provider.calls[0]!.tools([
      {
        id: "failure",
        name: "bash",
        arguments: { command: "printf 'synthetic failure\\n'; exit 7" },
      },
    ]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    const parts = (await snapshot()).messages.flatMap((message) => message.parts ?? []);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        state: "error",
        output: expect.stringContaining("code 7") as unknown,
      }),
    );
    provider.calls[1]!.finish("The command failed.");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
  });

  it("reopens existing history and clears the old empty tool selection without replaying completed writes", async () => {
    await start();
    provider.calls[0]!.tools([
      { id: "once", name: "bash", arguments: { command: "printf 'once\\n' >> receipt.txt" } },
    ]);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
    provider.calls[1]!.finish("Saved.");
    await chat.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await chat.conversation.configure({ tools: [], modelTools: [] }, BACKGROUND_CONTEXT);
    const before = await snapshot();
    await chat.close();
    chat = await openChat(join(directory, "data"), provider.models, cwd);
    expect(
      (await chat.conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
    ).toContain("bash");
    expect((await snapshot()).messages).toEqual(before.messages);
    expect(await readFile(join(cwd, "receipt.txt"), "utf8")).toBe("once\n");
    expect(provider.calls).toHaveLength(2);
  });
});
