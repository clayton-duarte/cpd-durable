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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SavedPromptSchema,
  type CreateSavedPrompt,
  type SavedPrompt,
  type UpdateSavedPrompt,
  type RemoveSavedPrompt,
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
  const [review, setReview] = useState<{ id: string; revision: number; version: number } | null>(
    null,
  );
  const [edit, setEdit] = useState<{
    id: string;
    revision: number;
    title: string;
    text: string;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const mutation = useRef<
    | { method: "PUT"; body: UpdateSavedPrompt }
    | { method: "DELETE"; body: RemoveSavedPrompt }
    | null
  >(null);
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
    setReview(null);
    setEdit(null);
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
  function choose(id: string) {
    if (mutation.current && mutation.current.body.id !== id) {
      setError("Resolve the unconfirmed library change before choosing another prompt.");
      return;
    }
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    setSelected(id);
    setReview({ id, revision: item.revision, version: live.current.draftVersion() });
    const pendingEdit = mutation.current?.method === "PUT" ? mutation.current.body : null;
    setEdit(
      pendingEdit
        ? {
            id,
            revision: pendingEdit.expectedRevision,
            title: pendingEdit.title,
            text: pendingEdit.text,
          }
        : { id, revision: item.revision, title: item.title, text: item.text },
    );
    setConflict(false);
    setError(null);
  }
  function insert(mode: "append" | "replace") {
    const current = live.current;
    const item = items.find((candidate) => candidate.id === selected);
    if (
      !open ||
      !current.available ||
      !current.connected ||
      !current.onSend ||
      current.readOnly ||
      current.active === false ||
      !item ||
      !review ||
      review.id !== item.id ||
      review.revision !== item.revision
    )
      return;
    if (!current.applyPrompt(review.version, item.text, mode)) {
      setReview(null);
      setError("Draft changed; review the current draft and choose the prompt again.");
      return;
    }
    onOpenChange(false);
  }
  async function reloadRevision() {
    if (!edit || busy || mutation.current) return;
    const generation = epoch.current;
    setBusy(true);
    try {
      let next: string | null = null;
      let found: SavedPrompt | undefined;
      do {
        const response = await fetch(
          `/api/saved-prompts${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (!response.ok) throw new Error();
        const page = PageSchema.parse(await response.json());
        found = page.items.find((item) => item.id === edit.id);
        next = page.nextCursor;
      } while (!found && next);
      if (epoch.current !== generation) return;
      if (!found) {
        setError("Prompt no longer exists. Your edits are retained.");
        return;
      }
      const latest = found;
      setItems((current) => current.map((item) => (item.id === latest.id ? latest : item)));
      setEdit((current) =>
        current?.id === latest.id ? { ...current, revision: latest.revision } : current,
      );
      setReview(null);
      setConflict(false);
      setError(
        "Latest revision loaded; your edited title and text were retained. Review before saving.",
      );
    } catch {
      if (epoch.current === generation)
        setError("Could not reload the prompt; your edits are retained.");
    } finally {
      setBusy(false);
    }
  }
  async function change(method: "PUT" | "DELETE") {
    const current = live.current;
    if (
      !open ||
      !current.available ||
      !current.connected ||
      !current.onSend ||
      current.readOnly ||
      current.active === false ||
      busy ||
      !edit ||
      conflict
    )
      return;
    if (mutation.current && mutation.current.method !== method) {
      setError("Retry the unconfirmed library change first.");
      return;
    }
    const request =
      mutation.current ??
      (method === "PUT"
        ? {
            method: "PUT" as const,
            body: {
              requestId: crypto.randomUUID(),
              id: edit.id,
              expectedRevision: edit.revision,
              title: edit.title,
              text: edit.text,
            },
          }
        : {
            method: "DELETE" as const,
            body: { requestId: crypto.randomUUID(), id: edit.id, expectedRevision: edit.revision },
          });
    mutation.current = request;
    const generation = epoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/saved-prompts/${request.body.id}`, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) {
        if (response.status < 500) mutation.current = null;
        if (response.status === 409) {
          if (epoch.current === generation) setConflict(true);
          throw new Error("Change rejected. Reload the latest revision; your edits remain.");
        }
        throw new Error(
          response.status === 404
            ? "Prompt was deleted; your edits remain."
            : "Change could not be confirmed.",
        );
      }
      const receipt = z
        .strictObject({ prompt: SavedPromptSchema, deleted: z.boolean() })
        .parse(await response.json());
      if (
        receipt.prompt.id !== request.body.id ||
        receipt.deleted !== (request.method === "DELETE")
      )
        throw new Error("Change could not be confirmed.");
      mutation.current = null;
      if (epoch.current !== generation) return;
      if (receipt.deleted) {
        setItems((currentItems) => currentItems.filter((item) => item.id !== receipt.prompt.id));
        setSelected("");
        setEdit(null);
        setReview(null);
        setDeleteOpen(false);
      } else {
        setItems((currentItems) =>
          currentItems.map((item) => (item.id === receipt.prompt.id ? receipt.prompt : item)),
        );
        setEdit((currentEdit) =>
          currentEdit?.id === receipt.prompt.id
            ? { ...currentEdit, revision: receipt.prompt.revision }
            : currentEdit,
        );
        setReview(null);
      }
      setError(null);
    } catch (cause) {
      if (epoch.current === generation)
        setError(cause instanceof Error ? cause.message : "Change could not be confirmed.");
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
            Private to this host session. Saving and inserting do not send a message. The library
            holds at most 1,000 prompts and 10,000 retained operation receipts; after that operation
            limit, further changes are rejected.
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
          onRun={choose}
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
        {prompt && (
          <>
            <Textarea aria-label="Literal prompt preview" readOnly value={prompt.text} />
            <Button disabled={!host.available || !review || busy} onClick={() => insert("append")}>
              Append to draft
            </Button>
            <Button disabled={!host.available || !review || busy} onClick={() => insert("replace")}>
              Replace draft
            </Button>
            {edit && (
              <>
                <Textarea
                  aria-label="Edit prompt title"
                  maxLength={120}
                  value={edit.title}
                  onChange={(event) => setEdit({ ...edit, title: event.currentTarget.value })}
                />
                <Textarea
                  aria-label="Edit prompt text"
                  value={edit.text}
                  onChange={(event) => setEdit({ ...edit, text: event.currentTarget.value })}
                />
                <Button
                  disabled={!host.available || busy || conflict}
                  onClick={() => {
                    void change("PUT");
                  }}
                >
                  {mutation.current?.method === "PUT" ? "Retry edit" : "Save edit"}
                </Button>
                {conflict && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void reloadRevision();
                    }}
                  >
                    Reload latest revision
                  </Button>
                )}
                <Button
                  disabled={!host.available || busy || conflict}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete prompt
                </Button>
              </>
            )}
          </>
        )}
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
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the library record, not conversation data or retained operation receipts.
              It is not physical erasure.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!host.available || busy}
              onClick={(event) => {
                event.preventDefault();
                void change("DELETE");
              }}
            >
              Confirm delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
