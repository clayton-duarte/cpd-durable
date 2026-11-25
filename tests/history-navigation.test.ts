import { describe, expect, it } from "vite-plus/test";
import { historyNavigation } from "../src/client/history-navigation.ts";
import type { ChatState } from "../src/shared/chat.ts";

const state = (oldest: number, gaps: { after: number; upTo: number }[] = []): ChatState => ({
  messages: [],
  partial: "",
  busy: false,
  failure: null,
  hasEarlier: true,
  history: { view: "view", epoch: "epoch", revision: 1, oldest, gaps },
});

describe("visible history navigation", () => {
  it("fills the nearest reply gap before inherited or earlier pages", () => {
    expect(
      historyNavigation(
        state(1, [
          { after: 2, upTo: 5 },
          { after: 20, upTo: 80 },
          { after: 10, upTo: 20 },
        ]),
        10,
      ),
    ).toEqual({ hasEarlier: true, gap: { after: 20, upTo: 80 } });
  });
  it("hides inherited-only history but still offers earlier reply pages", () => {
    expect(historyNavigation(state(10), 10)).toEqual({ hasEarlier: false });
    expect(historyNavigation(state(1, [{ after: 2, upTo: 5 }]), 10)).toEqual({ hasEarlier: false });
    expect(historyNavigation(state(11), 10)).toEqual({ hasEarlier: true });
    expect(historyNavigation(state(1))).toEqual({ hasEarlier: true });
    expect(historyNavigation(null)).toEqual({ hasEarlier: false });
  });
});
