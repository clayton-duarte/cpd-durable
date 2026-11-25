"use client";

import { useCallback, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { floating } from "./surfaces";
import { clamp } from "../utils/range";

/** Indexed thread metadata: navigation never creates or starts a thread. */
export interface ConversationMapThread {
  /** Canonical saved entry the thread replies to. */
  entryId: string;
  replies: number;
  repliesCapped: boolean;
  needsYou: boolean;
  running: boolean;
}

export interface ConversationMapEntry {
  id: string;
  title: string;
  preview?: string;
  thread?: ConversationMapThread;
}

const TICK = '[data-slot="conversation-map-tick"]';

export function ConversationMap({
  entries,
  activeId,
  visibleIds,
  onSelect,
  onOpenThread,
  side = "right",
  className,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"nav">, "children" | "onSelect"> & {
  entries: readonly ConversationMapEntry[];
  activeId?: string | undefined;
  visibleIds?: readonly string[] | undefined;
  onSelect?: ((id: string) => void) | undefined;
  onOpenThread?: ((entryId: string) => void) | undefined;
  side?: "left" | "right";
}) {
  const railRef = useRef<HTMLElement>(null);
  const [handle] = useState(() => PreviewCard.createHandle<ConversationMapEntry>());
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const inView = new Set(visibleIds);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);
  const tabbableIndex = clamp(
    focusedIndex ?? Math.max(0, activeIndex),
    0,
    Math.max(0, entries.length - 1),
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;

      const ticks = railRef.current?.querySelectorAll<HTMLElement>(TICK);
      if (!ticks?.length) return;

      const current = Array.prototype.indexOf.call(ticks, event.target);
      if (current === -1) return;

      const next = {
        ArrowUp: current - 1,
        ArrowDown: current + 1,
        Home: 0,
        End: ticks.length - 1,
      }[event.key];
      if (next === undefined) return;

      event.preventDefault();
      ticks[clamp(next, 0, ticks.length - 1)]?.focus();
    },
    [onKeyDown],
  );

  return (
    <nav
      data-slot="conversation-map"
      ref={railRef}
      aria-label="Conversation map"
      onKeyDown={handleKeyDown}
      className={cn(
        "group/rail flex h-full w-8 flex-col justify-center-safe overflow-y-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {entries.map((entry, index) => {
        const current = index === activeIndex;
        const onScreen = current || inView.has(entry.id);
        return (
          <PreviewCard.Trigger
            key={entry.id}
            handle={handle}
            payload={entry}
            delay={120}
            closeDelay={80}
            render={<button type="button" />}
            data-slot="conversation-map-tick"
            data-active={current ? "" : undefined}
            data-in-view={onScreen ? "" : undefined}
            data-thread={entry.thread ? "" : undefined}
            aria-label={entry.title}
            aria-current={current ? "true" : undefined}
            tabIndex={index === tabbableIndex ? 0 : -1}
            onFocus={() => setFocusedIndex(index)}
            onClick={onSelect ? () => onSelect(entry.id) : undefined}
            // Keep every indexed thread keyboard-reachable. A large index
            // scrolls within the rail rather than shrinking ticks to zero.
            className="pointer-events-auto group flex h-3.5 shrink-0 items-center outline-none"
          >
            {/* At rest every tick is the same short length and only weight and
                depth separate the tiers. Pointing at the rail grows them out by
                tier, and the one actually under the pointer reaches full length
                so the rail says which turn the card belongs to. */}
            <span
              className={cn(
                "w-3 rounded-full transition-[width,height,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                current
                  ? "bg-foreground/90 h-[3px] group-focus-within/rail:w-6 group-hover/rail:w-6"
                  : entry.thread
                    ? "bg-foreground/80 h-1 ring-1 ring-foreground/40 ring-offset-1 ring-offset-background group-focus-within/rail:w-[18px] group-hover/rail:w-[18px]"
                    : cn(
                        "group-hover:bg-foreground/70 group-focus-visible:bg-foreground/70 h-0.5",
                        "group-hover:w-6! group-focus-visible:w-6!",
                        onScreen
                          ? "bg-foreground/50 group-focus-within/rail:w-[18px] group-hover/rail:w-[18px]"
                          : "bg-foreground/15",
                      ),
              )}
            />
          </PreviewCard.Trigger>
        );
      })}

      <PreviewCard.Root handle={handle}>
        {({ payload }) => (
          <PreviewCard.Portal>
            <PreviewCard.Positioner side={side} sideOffset={10}>
              <PreviewCard.Popup
                className={cn(
                  floating,
                  "z-50 w-60 origin-(--transform-origin) rounded-2xl p-3.5 outline-none",
                  "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
                  "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
                  "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
                )}
              >
                <p className="line-clamp-2 text-[13px] leading-snug font-medium">
                  {payload?.title}
                </p>
                {payload?.preview && (
                  <p className="text-muted-foreground mt-1 line-clamp-3 text-[13px] leading-relaxed">
                    {payload.preview}
                  </p>
                )}
                {payload?.thread && (
                  <div className="border-foreground/10 mt-2 flex items-center gap-2 border-t pt-2">
                    <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                      {payload.thread.needsYou
                        ? "Thread needs you"
                        : payload.thread.running
                          ? "Thread is replying…"
                          : `${payload.thread.replies}${payload.thread.repliesCapped ? "+" : ""} ${
                              payload.thread.replies === 1 ? "reply" : "replies"
                            }`}
                    </p>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onOpenThread?.(payload.thread!.entryId)}
                    >
                      Open thread
                    </Button>
                  </div>
                )}
              </PreviewCard.Popup>
            </PreviewCard.Positioner>
          </PreviewCard.Portal>
        )}
      </PreviewCard.Root>
    </nav>
  );
}
