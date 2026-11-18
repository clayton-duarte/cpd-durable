import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, ResetEntry, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openChat } from "../src/server/chat.ts";
import { createApp } from "../src/server/app.ts";
import {
  exportTranscripts,
  transcriptExportJson,
  transcriptExportMarkdown,
} from "../src/server/export.ts";
import { searchTranscripts } from "../src/server/search.ts";
import {
  freezeTranscriptScope,
  scanTranscripts,
  type ResolveTranscript,
} from "../src/server/transcript-reader.ts";
import type { TranscriptScope } from "../src/shared/history-operations.ts";
import { testModels } from "./models.ts";

describe("logical transcript operations", () => {
  let directory: string;
  let chat: Awaited<ReturnType<typeof openChat>>;
  let resolve: ResolveTranscript;
  let root: string;
  let scope: TranscriptScope;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpd-operations-"));
    chat = await openChat(directory, testModels().models, directory);
    root = String(chat.conversation.id);
    scope = { conversationIds: [root], includeArchived: false };
    resolve = async (id) => {
      const item = await chat.chats.resolve(id);
      return item && { conversation: item.conversation, archived: item.archived };
    };
  });
  afterEach(async () => {
    await chat.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function seed(count: number) {
    await chat.conversation.commit(async (tx) => {
      for (let index = 0; index < count; index++) {
        await tx.appendEntry(UserEntry, chat.conversation.id, {
          model: [{ role: "user", content: `Turn ${index} needle 😀`, timestamp: index }],
        });
      }
    }, BACKGROUND_CONTEXT);
  }
  const search = (query: string, maxResults = 1000) =>
    searchTranscripts(scope, resolve, { query, maxResults, caseSensitive: false });

  it("scans beyond 50 entries and preserves IDs, literal Unicode matches and exact result caps", async () => {
    await seed(130);
    const result = await search("NEEDLE");
    expect(result.report).toMatchObject({
      status: "complete",
      partial: false,
      scannedEntries: 130,
    });
    expect(result.hits).toHaveLength(130);
    expect(result.hits[0]).toMatchObject({
      conversationId: root,
      originConversationId: root,
      start: 7,
      end: 13,
      match: "needle",
      partIndex: 0,
      before: "Turn 0 ",
      after: " 😀",
    });
    expect(result.hits[0]!.messageId).toBe(`${result.hits[0]!.entryId}:0`);
    const exact = await search("😀", 130);
    expect(exact.report.status).toBe("complete");
    expect(exact.hits[0]).toMatchObject({ start: 14, end: 16 });
    expect((await search(".*")).hits).toEqual([]);
    const capped = await search("needle", 5);
    expect(capped.hits).toHaveLength(5);
    expect(capped.report).toMatchObject({ status: "capped", partial: true });
  });

  it("repeats inherited fork history with origin attribution and respects the inclusive cutoff", async () => {
    await seed(3);
    const entries = (
      await chat.conversation.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT)
    ).items;
    const fork = await chat.chats.fork(root, crypto.randomUUID(), String(entries[1]!.id));
    const selected = { conversationIds: [root, fork.id], includeArchived: false };
    const result = await exportTranscripts(selected, resolve);
    expect(
      result.entries.map((entry) => [
        entry.conversationId,
        entry.originConversationId,
        entry.entryId,
      ]),
    ).toEqual([
      ...entries.map((entry) => [root, root, entry.id]),
      ...entries.slice(0, 2).map((entry) => [fork.id, root, entry.id]),
    ]);
    expect(result.inheritedHistory).toBe("repeated-per-conversation");
    expect(result.restorableBackup).toBe(false);
  });

  it("retains raw pre-reset/compaction entries and never exports private diagnostics or reasoning", async () => {
    await seed(1);
    await chat.conversation.commit(async (tx) => {
      await tx.appendEntry(ResetEntry, chat.conversation.id, { head: "self" });
      await tx.appendEntry(CompactionEntry, chat.conversation.id, {
        data: { reason: "manual" },
        head: "self",
        model: [{ role: "user", content: "Summary text", timestamp: 0 }],
      });
      await tx.appendEntry(chat.conversation.id, {
        kind: "pi.assistant",
        data: { private: "SECRET_ENTRY_DATA" },
        model: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "SECRET_REASONING" },
              { type: "text", text: "Public ``` answer" },
            ],
            api: "openai-completions",
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
            errorMessage: "SECRET_PROVIDER_DIAGNOSTIC",
          },
        ],
      });
      await tx.appendEntry(chat.conversation.id, {
        kind: "pi.tool-result",
        data: { diagnostics: [{ message: "SECRET_DIAGNOSTIC" }] },
        model: [
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }],
            isError: false,
            timestamp: 0,
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
    const result = await exportTranscripts(scope, resolve);
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "reset",
      "compaction",
      "assistant",
      "other",
    ]);
    expect(result.entries[0]!.messages[0]!.textParts[0]!.text).toContain("Turn 0");
    const output = transcriptExportJson(result) + transcriptExportMarkdown(result);
    for (const secret of [
      "SECRET_ENTRY_DATA",
      "SECRET_REASONING",
      "SECRET_PROVIDER_DIAGNOSTIC",
      "SECRET_DIAGNOSTIC",
      "SECRET_TOOL_OUTPUT",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("````text");
    expect((await search("SECRET")).hits).toEqual([]);
  });

  it("preserves source part boundaries and limits snippets without leaking excluded content", async () => {
    const entry = await chat.conversation.commit(
      async (tx) =>
        tx.appendEntry(chat.conversation.id, {
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                { type: "text", text: `${"😀".repeat(50)} foo` },
                { type: "thinking", thinking: "PRIVATE_REASONING" },
                { type: "text", text: `bar ${"🚀".repeat(50)}` },
                {
                  type: "toolCall",
                  id: "call",
                  name: "read",
                  arguments: { path: "PRIVATE_ARGUMENT" },
                },
                { type: "text", text: "last" },
              ],
              api: "openai-completions",
              provider: "test",
              model: "test",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 0,
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    expect((await search("foobar")).hits).toEqual([]);
    expect((await search("barlast")).hits).toEqual([]);
    const foo = (await search("foo")).hits[0]!;
    const bar = (await search("bar")).hits[0]!;
    expect(foo).toMatchObject({
      entryId: entry.id,
      messageId: `${entry.id}:0`,
      partIndex: 0,
      start: 101,
      end: 104,
      after: "",
    });
    expect(bar).toMatchObject({
      entryId: entry.id,
      messageId: `${entry.id}:0`,
      partIndex: 2,
      start: 0,
      end: 3,
      before: "",
    });
    expect(Array.from(foo.before)).toHaveLength(40);
    expect(Array.from(bar.after)).toHaveLength(40);
    expect(foo.before).toBe(`${"😀".repeat(39)} `);
    expect(bar.after).toBe(` ${"🚀".repeat(39)}`);
    const exported = await exportTranscripts(scope, resolve);
    expect(exported.entries[0]!.messages[0]!.textParts.map((part) => part.partIndex)).toEqual([
      0, 2, 4,
    ]);
    const output = JSON.stringify([foo, bar, exported]) + transcriptExportMarkdown(exported);
    expect(output).not.toContain("PRIVATE_REASONING");
    expect(output).not.toContain("PRIVATE_ARGUMENT");
    expect(transcriptExportMarkdown(exported)).toContain("Text part 2:");
    expect(output).not.toContain("foobar");
  });

  it("freezes bounds before subsequent appends and never assumes entry IDs are contiguous", async () => {
    await seed(55);
    const frozen = await freezeTranscriptScope(scope, resolve);
    const previous = frozen.conversations[0]!.upperEntryId;
    await seed(10);
    const ids: number[] = [];
    const report = await scanTranscripts(
      frozen,
      async (entry) => {
        ids.push(entry.entryId);
        if (ids.length === 8) await seed(5);
        return true;
      },
      { limits: { pageSize: 7 } },
    );
    expect(ids).toHaveLength(55);
    expect(ids.at(-1)).toBe(previous);
    expect(report.status).toBe("complete");
    expect((await search("needle")).hits).toHaveLength(70);
  });

  it("reports cancellation and per-operation scan and export limits without claiming completeness", async () => {
    await seed(5);
    const limited = await searchTranscripts(
      scope,
      resolve,
      { query: "needle", caseSensitive: true },
      { limits: { maxEntries: 2, pageSize: 1 } },
    );
    expect(limited.report).toMatchObject({ status: "capped", partial: true, scannedEntries: 2 });
    const small = await exportTranscripts(scope, resolve, { export: { maxTextCharacters: 1 } });
    expect(small).toMatchObject({ report: { status: "capped", partial: true }, entries: [] });
    const controller = new AbortController();
    const frozen = await freezeTranscriptScope(scope, resolve);
    const report = await scanTranscripts(
      frozen,
      () => {
        controller.abort();
        return true;
      },
      { signal: controller.signal, limits: { pageSize: 1 } },
    );
    expect(report).toMatchObject({ status: "cancelled", partial: true, scannedEntries: 1 });
    const before = new AbortController();
    before.abort();
    const cancelled = await searchTranscripts(
      scope,
      resolve,
      { query: "x", caseSensitive: true },
      { signal: before.signal },
    );
    expect(cancelled.report).toMatchObject({
      status: "cancelled",
      partial: true,
      scannedEntries: 0,
      conversations: [{ complete: false }],
    });
  });

  it("rejects invalid query, unauthorized, deleted and caller-excluded archived scope", async () => {
    for (const query of ["", "  ", "\ud800", "x".repeat(513)])
      await expect(search(query)).rejects.toThrow();
    await expect(
      searchTranscripts({ conversationIds: [root, root], includeArchived: false }, resolve, {
        query: "x",
        caseSensitive: true,
      }),
    ).rejects.toThrow();
    await expect(
      searchTranscripts({ conversationIds: ["999999"], includeArchived: true }, resolve, {
        query: "x",
        caseSensitive: true,
      }),
    ).rejects.toThrow("unavailable");
    await chat.chats.change(root, "archive");
    await expect(search("x")).rejects.toThrow("unavailable");
    const archived = await searchTranscripts(
      { conversationIds: [root], includeArchived: true },
      resolve,
      { query: "x", caseSensitive: true },
    );
    expect(archived.report.conversations[0]!.archived).toBe(true);
    await chat.chats.change(root, "delete");
    await expect(
      searchTranscripts({ conversationIds: [root], includeArchived: true }, resolve, {
        query: "x",
        caseSensitive: true,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("serves read-only scoped endpoints with catalog, archive, host and request validation", async () => {
    await seed(2);
    const app = createApp(chat);
    const post = (path: string, body: unknown, origin = "http://localhost:3000") =>
      app.request(`http://localhost:3000/api/history-operations/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
    const searchRequest = {
      scope,
      search: { query: "needle", caseSensitive: false, maxResults: 100 },
    };
    const response = await post("search", searchRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as { hits: unknown[] }).hits).toHaveLength(2);
    const download = await post("export", { scope, format: "markdown" });
    expect(await download.json()).toMatchObject({
      format: "markdown",
      report: { status: "complete" },
    });
    expect((await post("search", { ...searchRequest, extra: true })).status).toBe(400);
    expect((await post("search", searchRequest, "https://attacker.example")).status).toBe(403);
    expect(
      (
        await post("search", {
          ...searchRequest,
          scope: { conversationIds: ["999999"], includeArchived: true },
        })
      ).status,
    ).toBe(404);
    await chat.chats.change(root, "archive");
    expect((await post("search", searchRequest)).status).not.toBe(200);
    expect(
      (
        await post("search", {
          ...searchRequest,
          scope: { conversationIds: [root], includeArchived: true },
        })
      ).status,
    ).toBe(200);
    await chat.chats.change(root, "delete");
    expect(
      (
        await post("search", {
          ...searchRequest,
          scope: { conversationIds: [root], includeArchived: true },
        })
      ).status,
    ).toBe(404);
  });

  it.each(["search", "export"] as const)(
    "does not publish %s if the catalog deletes a chat during the scan",
    async (kind) => {
      await seed(2);
      const original = chat.conversation.entries.bind(chat.conversation);
      let reads = 0;
      vi.spyOn(chat.conversation, "entries").mockImplementation(async (...args) => {
        const page = await original(...args);
        if (++reads === 2) await chat.chats.change(root, "delete");
        return page;
      });
      const response = await createApp(chat).request(
        `http://localhost:3000/api/history-operations/${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            kind === "search"
              ? { scope, search: { query: "needle", caseSensitive: false } }
              : { scope, format: "json" },
          ),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("needle");
    },
  );
});
