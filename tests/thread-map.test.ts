import { describe, expect, it } from "vite-plus/test";
import { threadMapEntries } from "../src/client/thread-map.ts";
import type { ThreadView } from "../src/shared/threads.ts";

const thread = (id: string, parentId = "1"): ThreadView => ({
  id,
  parentId,
  sourceEntryId: `${id}00`,
  slug: `${id}-thread`,
  title: `Thread ${id}`,
  replyCount: 2,
  replyCountCapped: false,
  activity: "idle",
  source: { entryId: `${id}00`, role: "assistant", text: "Earlier source", truncated: false },
});

describe("thread-only conversation map", () => {
  it("uses every scoped thread, stable thread IDs and index previews without a transcript", () => {
    const entries = threadMapEntries([thread("2"), thread("3"), thread("4", "9")], "1");
    expect(entries.map((entry) => entry.id)).toEqual(["2", "3"]);
    expect(entries[0]).toMatchObject({
      title: "Thread 2",
      preview: "Earlier source",
      thread: { entryId: "200", replies: 2 },
    });
  });
  it("does not cap the index and keeps actual activity and bounded count metadata", () => {
    const threads = Array.from({ length: 1000 }, (_, i) => thread(String(i + 1)));
    threads[0] = { ...threads[0]!, activity: "waiting", replyCountCapped: true };
    threads[1] = { ...threads[1]!, activity: "running" };
    const entries = threadMapEntries(threads, "1");
    expect(entries).toHaveLength(1000);
    expect(entries[0]?.thread).toMatchObject({
      needsYou: true,
      running: false,
      repliesCapped: true,
    });
    expect(entries[1]?.thread).toMatchObject({ needsYou: false, running: true });
    expect(threadMapEntries([], "1")).toEqual([]);
  });
});
