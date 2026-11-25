"use client";

import { ComposerPrimitive, SelectionToolbarPrimitive } from "@assistant-ui/react";
import { MessageSquareIcon, QuoteIcon, XIcon } from "lucide-react";
import { QuoteTextSchema } from "../../../../shared/quote.ts";

const actionClass =
  "text-popover-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm focus-visible:ring-2";

// Adapted from assistant-ui's Quote element. The native selection primitive
// scopes and positions the toolbar; the extra action routes to the saved entry.
export function SelectionToolbar({
  onThread,
}: {
  onThread?: ((id: number, quote: string) => void) | undefined;
}) {
  return (
    <SelectionToolbarPrimitive.Root
      data-slot="selection-toolbar"
      className="bg-popover flex items-center gap-1 rounded-lg border p-1 shadow-md"
    >
      <SelectionToolbarPrimitive.Quote data-slot="selection-toolbar-quote" className={actionClass}>
        <QuoteIcon className="size-3.5" />
        Quote
      </SelectionToolbarPrimitive.Quote>
      {onThread && (
        <button
          type="button"
          className={actionClass}
          onClick={() => {
            const selection = window.getSelection();
            if (!selection?.rangeCount) return;
            const range = selection.getRangeAt(0);
            const root = (node: Node) =>
              (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
                "[data-quote-entry]",
              );
            const source = root(range.startContainer);
            const entryId = Number(source?.dataset["quoteEntry"]);
            const quote = QuoteTextSchema.safeParse(selection.toString());
            if (
              !source ||
              source !== root(range.endContainer) ||
              !Number.isSafeInteger(entryId) ||
              entryId <= 0 ||
              !quote.success
            )
              return;
            selection.removeAllRanges();
            onThread(entryId, quote.data);
          }}
        >
          <MessageSquareIcon className="size-3.5" />
          Thread
        </button>
      )}
    </SelectionToolbarPrimitive.Root>
  );
}

export function QuoteBlock({ text }: { text: string }) {
  return (
    <blockquote data-slot="quote-block" className="mb-2 flex items-start gap-1.5">
      <QuoteIcon className="text-muted-foreground/60 mt-0.5 size-3 shrink-0" />
      <span className="text-muted-foreground/80 line-clamp-2 min-w-0 text-sm italic">{text}</span>
    </blockquote>
  );
}

const previewClass = "bg-muted/60 flex items-start gap-2 rounded-lg px-3 py-2";
const iconClass = "text-muted-foreground/70 mt-0.5 size-3.5 shrink-0";
const textClass = "text-muted-foreground line-clamp-2 min-w-0 flex-1 text-sm";
const dismissClass = "hover:bg-accent text-muted-foreground rounded-sm p-0.5";

export function ComposerQuotePreview() {
  return (
    <ComposerPrimitive.Quote data-slot="composer-quote" className={previewClass}>
      <QuoteIcon className={iconClass} />
      <ComposerPrimitive.QuoteText className={textClass} />
      <ComposerPrimitive.QuoteDismiss aria-label="Dismiss quote" className={dismissClass}>
        <XIcon className="size-3.5" />
      </ComposerPrimitive.QuoteDismiss>
    </ComposerPrimitive.Quote>
  );
}

export function UnsentQuotePreview({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div data-slot="composer-quote" className={previewClass}>
      <QuoteIcon className={iconClass} />
      <span className={textClass}>{text}</span>
      <button type="button" aria-label="Dismiss quote" className={dismissClass} onClick={onDismiss}>
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
