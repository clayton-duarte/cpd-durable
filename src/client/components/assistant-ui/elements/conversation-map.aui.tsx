"use client";

import { useMemo } from "react";
import { useThreadViewport } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { useChatHost } from "@/chat-host";
import { threadMapEntries } from "@/thread-map";
import { ConversationMap } from "./conversation-map";

/** Persistent thread navigation, independent of transcript paging and DOM rows. */
export function ConversationMapAui({
  side = "left",
  className,
}: {
  side?: "left" | "right";
  className?: string;
}) {
  const host = useChatHost();
  const viewportHeight = useThreadViewport((s) => s.height.viewport);
  const footerHeight = useThreadViewport((s) => s.height.inset);
  const entries = useMemo(
    () => threadMapEntries(host.threads ?? [], host.chatId),
    [host.threads, host.chatId],
  );
  const selected = entries.find((entry) => entry.thread?.entryId === host.highlightsEntryId)?.id;
  const openSource = (source: string) => {
    const value = Number(source);
    if (Number.isSafeInteger(value) && value > 0) host.onReplyInThread?.(value);
  };
  if (entries.length === 0) return null;
  return (
    <div
      data-slot="conversation-map-rail"
      className={cn("pointer-events-none sticky top-0 z-10 h-0 w-full", className)}
    >
      <div
        className={cn(
          "pointer-events-none absolute top-0 px-3 py-10",
          side === "right" ? "right-0" : "left-0",
        )}
        style={{ height: Math.max(0, viewportHeight - footerHeight) }}
      >
        <ConversationMap
          entries={entries}
          activeId={selected}
          aria-label="Conversation threads"
          onSelect={(id) => {
            const source = entries.find((entry) => entry.id === id)?.thread?.entryId;
            if (source !== undefined) openSource(source);
          }}
          onOpenThread={openSource}
          side={side === "right" ? "left" : "right"}
        />
      </div>
    </div>
  );
}
