import { useEffect, useMemo, useRef, useState } from "react";
import { useAuiState, useThreadViewport } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { ConversationSearch } from "@/components/assistant-ui/elements/conversation-search";
import { searchHistory } from "./history-search.ts";

export function ThreadNavigation() {
  const messages = useAuiState((state) => state.thread.messages);
  const viewport = useThreadViewport((state) => state.element.viewport);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const hits = useMemo(() => searchHistory(messages, query), [messages, query]);
  const activeIndex = Math.max(
    0,
    hits.findIndex((hit) => hit.id === selected),
  );
  const activeMessageId = hits[activeIndex]?.messageId;
  const activeHitId = hits[activeIndex]?.id;
  useEffect(() => {
    if (!open || !viewport || !activeMessageId) return;
    const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (element) => element.dataset["messageId"] === activeMessageId,
    );
    if (row)
      viewport.scrollTo({
        top:
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop,
        behavior: "instant",
      });
  }, [open, viewport, activeMessageId, activeHitId]);
  function step(delta: number) {
    if (!hits.length || !viewport) return;
    setSelected(hits[(activeIndex + delta + hits.length) % hits.length]!.id);
  }
  if (!messages.some((message) => !message.metadata.custom["historyMarker"])) return null;
  return (
    <>
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Find in loaded history
      </Button>
      {open && (
        <ConversationSearch
          query={query}
          hits={hits}
          activeIndex={activeIndex}
          aria-label="Loaded history text only; at most 1000 matches. Earlier unloaded messages are not searched."
          onQueryChange={(next) => {
            setQuery(next.slice(0, 256));
            setSelected(undefined);
          }}
          onStep={step}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
            if (event.key === "Escape") {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        />
      )}
    </>
  );
}
