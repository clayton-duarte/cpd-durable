import { useEffect, useRef, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { CommandPalette } from "@/components/assistant-ui/elements/command-palette";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TemplateContentSchema,
  TemplateListSchema,
  type TemplateItem,
} from "../shared/templates.ts";
import { useChatHost } from "./chat-host.ts";

export function PromptTemplates({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const host = useChatHost();
  const aui = useAui();
  const [list, setList] = useState<ReturnType<typeof TemplateListSchema.parse>>();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState("");
  const [content, setContent] = useState<ReturnType<typeof TemplateContentSchema.parse>>();
  const [contentEpoch, setContentEpoch] = useState<number>();
  const [draftAtReview, setDraftAtReview] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const id =
    host.chatId ?? (host.state?.conversationId ? String(host.state.conversationId) : undefined);
  useEffect(() => {
    const requestId = ++generation.current;
    controller.current?.abort();
    setContent(undefined);
    setList(undefined);
    if (!open || host.active === false || !id) return;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    void fetch(`/api/chats/${id}/templates`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = TemplateListSchema.parse(await response.json());
        if (result.conversationId !== id) throw new Error();
        if (generation.current === requestId) {
          setList(result);
          setActiveId(result.templates[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (generation.current === requestId)
          setError("Templates unavailable. Refresh to try again.");
      })
      .finally(() => {
        if (generation.current === requestId) setLoading(false);
      });
    return () => {
      controller.current?.abort();
      generation.current++;
    };
  }, [open, host.active, id, refresh]);

  async function select(template: TemplateItem) {
    if (!id || loading) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestId = ++generation.current;
    setLoading(true);
    setError("");
    setContent(undefined);
    try {
      const response = await fetch(
        `/api/chats/${id}/templates/${template.id}?fingerprint=${template.fingerprint}`,
        { signal: abort.signal },
      );
      if (!response.ok) throw new Error();
      const result = TemplateContentSchema.parse(await response.json());
      if (
        result.conversationId !== id ||
        result.template.id !== template.id ||
        result.template.fingerprint !== template.fingerprint
      )
        throw new Error();
      if (requestId !== generation.current) return;
      setDraftAtReview(aui.thread.composer().getState().text);
      setContent(result);
      setContentEpoch(requestId);
    } catch {
      if (requestId === generation.current)
        setError("Template changed or could not be read. Refresh the list.");
    } finally {
      if (requestId === generation.current) setLoading(false);
    }
  }
  const canInsert =
    !!content &&
    !!id &&
    content.conversationId === id &&
    contentEpoch === generation.current &&
    host.state?.conversationId !== undefined &&
    String(host.state.conversationId) === id &&
    !!host.onSend &&
    !host.readOnly &&
    host.connected &&
    host.active !== false;
  function insert(mode: "append" | "replace") {
    if (!canInsert || !content) return;
    const composer = aui.thread.composer();
    const current = composer.getState().text;
    if (current !== draftAtReview) {
      setDraftAtReview(current);
      setError("The draft changed. Review it and choose how to insert again.");
      return;
    }
    composer.setText(
      mode === "replace" ? content.text : current ? `${current}\n${content.text}` : content.text,
    );
    onOpenChange(false);
  }
  return (
    <Dialog open={open && host.active !== false} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Prompt templates</DialogTitle>
          <DialogDescription>
            Local guidance, inserted as literal draft text. Nothing is sent; placeholders are not
            expanded.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert">{error}</p>}
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh templates
        </Button>
        {loading && <p role="status">Reading templates…</p>}
        {list && (
          <>
            <p>{list.omitted} items or issues omitted by the display budget.</p>
            {list.issues.map((issue, index) => (
              <p key={index}>
                {issue.path}: {issue.reason}
              </p>
            ))}
            <CommandPalette
              commands={list.templates.map((template) => ({
                id: template.id,
                label: `${template.name} — ${template.path}`,
                group: "Templates",
                keys: [],
              }))}
              query={query}
              activeId={activeId}
              onQueryChange={setQuery}
              onActiveChange={setActiveId}
              onRun={(value) => {
                const template = list.templates.find((item) => item.id === value);
                if (template) void select(template);
              }}
            />
          </>
        )}
        {content && (
          <>
            <p>
              {content.template.name} — {content.template.path}
            </p>
            <p>
              Fingerprint: {content.template.fingerprint}
              {content.template.truncated ? " · truncated" : ""}
            </p>
            <Textarea aria-label="Template preview" readOnly value={content.text} rows={8} />
            {draftAtReview ? (
              <>
                <Button variant="outline" disabled={!canInsert} onClick={() => insert("append")}>
                  Append to draft
                </Button>
                <Button variant="outline" disabled={!canInsert} onClick={() => insert("replace")}>
                  Replace draft text
                </Button>
              </>
            ) : (
              <Button variant="outline" disabled={!canInsert} onClick={() => insert("replace")}>
                Insert into draft
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
