import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Chat, type ChatProps } from "../src/client/chat.tsx";

const base: ChatProps = {
  title: "Embedded conversation",
  connected: true,
  state: { messages: [], partial: "", busy: false, hasEarlier: false, failure: null },
};

describe("reusable chat presentation", () => {
  it("renders a read-only instance without provider, route or viewport assumptions", () => {
    const html = renderToStaticMarkup(createElement(Chat, base));
    expect(html).toContain("Embedded conversation");
    expect(html).toContain("This conversation is read-only.");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("h-dvh");
    expect(html).not.toContain("OpenCode");
    expect(html).not.toContain("Stop response");
  });

  it("distinguishes loading from an empty conversation", () => {
    const html = renderToStaticMarkup(
      createElement(Chat, { ...base, state: null, connected: false }),
    );
    expect(html).toContain("Loading conversation");
    expect(html).not.toContain("No messages yet");
  });

  it("does not expose mutation controls in a read-only embedding", () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        ...base,
        state: { ...base.state!, controls: { canContinue: true, resetPending: false, queue: [] } },
        onReset: () => Promise.resolve(true),
        onContinue: () => Promise.resolve(true),
      }),
    );
    expect(html).not.toContain("Conversation actions");
    expect(html).not.toContain("Continue response");
    expect(html).not.toContain("Send mode");
  });

  it("escapes content, preserves message order and labels interruption", () => {
    const html = renderToStaticMarkup(
      createElement(Chat, {
        ...base,
        state: {
          ...base.state!,
          messages: [
            { id: "1", role: "user", text: "<script>first</script>\n  second", interrupted: false },
            { id: "2", role: "assistant", text: "Retained answer", interrupted: true },
          ],
        },
      }),
    );
    expect(html).toContain("&lt;script&gt;first&lt;/script&gt;\n  second");
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("Retained answer"));
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("Response interrupted.");
  });
});
