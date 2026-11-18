import { describe, expect, it } from "vite-plus/test";
import { searchHistory } from "../src/client/history-search.ts";

describe("loaded text search", () => {
  const text = (id: string, value: string) => ({
    id,
    content: [{ type: "text" as const, text: value }],
  });
  it("treats regex syntax literally and preserves Unicode match offsets", () => {
    expect(searchHistory([text("one", "İ prefix [a.*] suffix")], "[a.*]")).toMatchObject([
      { messageId: "one", match: "[a.*]", before: "İ prefix " },
    ]);
  });
  it("excludes non-text parts and history markers", () => {
    expect(
      searchHistory(
        [
          { id: "reasoning", content: [{ type: "reasoning", text: "needle" }] },
          { ...text("gap", "needle"), metadata: { custom: { historyMarker: true } } },
          text("real", "Needle needle"),
        ],
        "needle",
      ).map((hit) => hit.messageId),
    ).toEqual(["real", "real"]);
  });
  it("bounds matches and handles empty and absent queries", () => {
    expect(searchHistory([text("many", "x".repeat(2000))], "x")).toHaveLength(1000);
    expect(searchHistory([text("one", "abc")], "")).toEqual([]);
    expect(searchHistory([text("one", "abc")], "z")).toEqual([]);
  });
});
