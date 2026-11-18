import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CommandPalette } from "@/components/assistant-ui/elements/command-palette";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  SavedPromptSchema,
  type CreateSavedPrompt,
  type SavedPrompt,
} from "../shared/saved-prompts.ts";
import { useChatHost } from "./chat-host.ts";

const PageSchema = z.strictObject({
  items: z.array(SavedPromptSchema),
  nextCursor: z.uuid().nullable(),
});

// CommandPalette supplies selection; Dialog fills the library-management gap.
export function SavedPrompts({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const host = useChatHost();
  const [items, setItems] = useState<SavedPrompt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<CreateSavedPrompt | null>(null);
  const epoch = useRef(0);
  const live = useRef(host);
  live.current = host;
  useEffect(() => {
    epoch.current++;
    if (!open) return;
    const generation = epoch.current;
    setItems([]);
    setCursor(null);
    setSelected("");
    setError(null);
    void fetch("/api/saved-prompts")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        return PageSchema.parse(await response.json());
      })
      .then((page) => {
        if (epoch.current !== generation) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch(() => {
        if (epoch.current === generation) setError("Could not load saved prompts.");
      });
    return () => {
      epoch.current++;
    };
  }, [open, host.chatId]);
  async function more() {
    if (!cursor || busy) return;
    const generation = epoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/saved-prompts?cursor=${encodeURIComponent(cursor)}`);
      if (!response.ok) throw new Error("Unavailable");
      const page = PageSchema.parse(await response.json());
      if (epoch.current !== generation) return;
      setItems((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((existing) => existing.id === item.id)),
      ]);
      setCursor(page.nextCursor);
    } catch {
      if (epoch.current === generation) setError("Could not load more saved prompts.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const current = live.current;
    if (
      !current.available ||
      !current.connected ||
      current.active === false ||
      !current.onSend ||
      busy
    )
      return;
    const request = pending.current ?? {
      requestId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      title,
      text: current.readDraft(),
    };
    if (!request.title || !request.text) {
      setError("Enter a title and a draft to save.");
      return;
    }
    pending.current = request;
    const generation = epoch.current;
    setBusy(true);
    try {
      const response = await fetch("/api/saved-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw new Error(
          response.status === 409
            ? "Saved prompt capacity or identity conflict."
            : "Could not save prompt.",
        );
      }
      const receipt = z
        .strictObject({ prompt: SavedPromptSchema, deleted: z.boolean() })
        .parse(await response.json());
      pending.current = null;
      if (epoch.current !== generation) return;
      setItems((currentItems) => [
        ...currentItems.filter((item) => item.id !== receipt.prompt.id),
        receipt.prompt,
      ]);
      setTitle("");
      setError(null);
    } catch (cause) {
      if (epoch.current === generation)
        setError(
          cause instanceof Error
            ? cause.message
            : "Save could not be confirmed; retry uses the same request.",
        );
    } finally {
      setBusy(false);
    }
  }
  const prompt = items.find((item) => item.id === selected);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Saved prompts—all chats</DialogTitle>
          <DialogDescription>
            Private to this host session. Saving does not send a message. Insertion and editing are
            not yet available. The library holds at most 1,000 prompts and 10,000 retained operation
            receipts; after that operation limit, further changes are rejected.
          </DialogDescription>
        </DialogHeader>
        <CommandPalette
          commands={items.map((item) => ({
            id: item.id,
            label: item.title,
            group: "Saved prompts",
            keys: [],
          }))}
          query={query}
          activeId={selected}
          onQueryChange={setQuery}
          onActiveChange={setSelected}
          onRun={setSelected}
        />
        {cursor && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void more();
            }}
          >
            Load more
          </Button>
        )}
        {prompt && <Textarea aria-label="Literal prompt preview" readOnly value={prompt.text} />}
        <Textarea
          aria-label="Prompt title"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Button
          disabled={!host.available || !host.connected || !host.onSend || busy}
          onClick={() => {
            void save();
          }}
        >
          {pending.current ? "Retry saving prompt" : "Save prompt"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
