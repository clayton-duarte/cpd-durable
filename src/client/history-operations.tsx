import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/assistant-ui/elements/collapsible-root";
import { ChatCatalogSchema, type ChatCatalog } from "../shared/chats.ts";
import {
  HistoryDownloadSchema,
  TranscriptSearchResultSchema,
  type TranscriptReport,
  type TranscriptSearchResult,
  type TranscriptScope,
} from "../shared/history-operations.ts";
import { useChatHost } from "./chat-host.ts";

type Download = { format: "json" | "markdown"; content: string; report: TranscriptReport };

function Boundaries({ report }: { report: TranscriptReport }) {
  return (
    <div aria-live="polite" className="text-xs text-muted-foreground">
      <p>
        Status: {report.status}
        {report.partial ? " · partial" : ""} · {report.scannedEntries} entries scanned. Boundaries
        are frozen independently per chat, not an atomic session snapshot.
      </p>
      <ul>
        {report.conversations.map((item) => (
          <li key={item.conversationId}>
            Chat {item.conversationId}
            {item.archived ? " (archived)" : ""}: upper entry{" "}
            {item.upperEntryId === undefined ? "not frozen" : (item.upperEntryId ?? "empty")} ·{" "}
            {item.complete ? "complete" : "incomplete"}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HistoryOperations() {
  const host = useChatHost();
  const current =
    host.chatId ??
    (host.state?.conversationId === undefined ? undefined : String(host.state.conversationId));
  const [catalog, setCatalog] = useState<ChatCatalog>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [scopeMode, setScopeMode] = useState<"selected" | "multiple" | "catalog">("selected");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [result, setResult] = useState<TranscriptSearchResult>();
  const [download, setDownload] = useState<Download>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/chats", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = ChatCatalogSchema.parse(await response.json());
        if (!abort.signal.aborted) setCatalog(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError("Chat scope could not be loaded.");
      });
    return () => abort.abort();
  }, [current, catalogRevision]);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [current],
  );

  function invalidate() {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    setResult(undefined);
    setDownload(undefined);
    setError(undefined);
    setCancelled(false);
  }
  const available =
    catalog?.chats.filter((item) => includeArchived || item.status !== "archived") ?? [];
  const ids =
    scopeMode === "selected"
      ? available.filter((item) => item.id === current).map((item) => item.id)
      : scopeMode === "catalog"
        ? available.map((item) => item.id)
        : available.filter((item) => selected.includes(item.id)).map((item) => item.id);

  async function run(kind: "search" | "export") {
    if (pending || ids.length === 0 || (kind === "search" && !query.trim())) return;
    const scope: TranscriptScope = { conversationIds: ids, includeArchived };
    const serial = ++generation.current;
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setCancelled(false);
    setError(undefined);
    setResult(undefined);
    setDownload(undefined);
    try {
      const response = await fetch(`/api/history-operations/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "search"
            ? { scope, search: { query, caseSensitive: false, maxResults: 100 } }
            : { scope, format },
        ),
        signal: request.signal,
      });
      if (!response.ok) throw new Error();
      const json: unknown = await response.json();
      const parsed =
        kind === "search"
          ? TranscriptSearchResultSchema.parse(json)
          : HistoryDownloadSchema.parse(json);
      if (JSON.stringify(parsed.report.scope) !== JSON.stringify(scope)) throw new Error();
      if (
        JSON.stringify(parsed.report.conversations.map((item) => item.conversationId)) !==
        JSON.stringify(scope.conversationIds)
      )
        throw new Error();
      if (kind === "search" && "query" in parsed && parsed.query !== query) throw new Error();
      if (
        "hits" in parsed &&
        parsed.hits.some((hit) => !scope.conversationIds.includes(hit.conversationId))
      )
        throw new Error();
      if (kind === "export" && "format" in parsed && parsed.format !== format) throw new Error();
      if (serial !== generation.current || request.signal.aborted) return;
      if ("hits" in parsed) setResult(parsed);
      else setDownload(parsed);
    } catch {
      if (serial === generation.current && !request.signal.aborted)
        setError("Saved history is unavailable. No message or run was sent.");
    } finally {
      if (serial === generation.current) {
        controller.current = null;
        setPending(false);
      }
    }
  }
  function save() {
    if (!download) return;
    const url = URL.createObjectURL(
      new Blob([download.content], {
        type: download.format === "json" ? "application/json" : "text/markdown",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `logical-transcript.${download.format === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section aria-label="Saved history" className="flex flex-col gap-3">
      <CollapsibleRoot>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          Search or export saved history
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Searches saved user and assistant text, including history before resets and compaction.
            Reasoning, tool payloads and images are excluded. Export is a logical transcript, not a
            database backup. Fork history may repeat, with its origin shown.
          </p>
          <div>
            <span id={`history-scope-${current ?? "chat"}`}>Scope</span>{" "}
            <Select
              value={scopeMode}
              onValueChange={(value) => {
                if (value !== "selected" && value !== "multiple" && value !== "catalog") return;
                invalidate();
                setScopeMode(value);
              }}
            >
              <SelectTrigger aria-labelledby={`history-scope-${current ?? "chat"}`}>
                <SelectValue>
                  {scopeMode === "selected"
                    ? "This chat"
                    : scopeMode === "multiple"
                      ? "Choose chats"
                      : "All catalog chats"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="selected">This chat</SelectItem>
                <SelectItem value="multiple">Choose chats</SelectItem>
                <SelectItem value="catalog">All catalog chats</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeArchived}
              onCheckedChange={(checked) => {
                invalidate();
                setIncludeArchived(checked);
              }}
            />
            Include archived chats
          </label>
          {scopeMode === "multiple" && (
            <fieldset>
              <legend>Choose chats</legend>
              {available.map((item) => (
                <label key={item.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.includes(item.id)}
                    onCheckedChange={(checked) => {
                      invalidate();
                      setSelected((previous) =>
                        checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
                      );
                    }}
                  />
                  <span>
                    {item.title} · chat {item.id}
                    {item.status === "archived" ? " (archived)" : ""}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {catalog && ids.length === 0 && (
            <p>Select an available chat; archived chats require explicit inclusion.</p>
          )}
          <label htmlFor={`saved-search-${current ?? "chat"}`}>Search saved text</label>
          <Input
            id={`saved-search-${current ?? "chat"}`}
            value={query}
            maxLength={512}
            onChange={(event) => {
              invalidate();
              setQuery(event.target.value);
            }}
          />
          <Button
            size="sm"
            disabled={pending || ids.length === 0 || !query.trim()}
            onClick={() => {
              void run("search");
            }}
          >
            Search saved history
          </Button>
          <div>
            <span id={`history-format-${current ?? "chat"}`}>Export format</span>{" "}
            <Select
              value={format}
              onValueChange={(value) => {
                if (value !== "markdown" && value !== "json") return;
                invalidate();
                setFormat(value);
              }}
            >
              <SelectTrigger aria-labelledby={`history-format-${current ?? "chat"}`}>
                <SelectValue>{format === "markdown" ? "Markdown" : "JSON"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">Markdown</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() => {
              void run("export");
            }}
          >
            Prepare logical export
          </Button>
          {pending && (
            <>
              <AgentStatus state="waiting" label="Reading saved history" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  invalidate();
                  setCancelled(true);
                }}
              >
                Cancel read
              </Button>
            </>
          )}
          {cancelled && <p role="status">Read cancelled. No agent work was stopped.</p>}
          {error && (
            <ErrorState
              title="Saved history unavailable"
              detail={error}
              retrying={false}
              actionLabel={catalog ? "Dismiss" : "Retry"}
              onRetry={() => {
                setError(undefined);
                if (!catalog) setCatalogRevision((revision) => revision + 1);
              }}
            />
          )}
          {result && (
            <>
              <Boundaries report={result.report} />
              <p>{result.hits.length} matches (maximum 100).</p>
              <ul>
                {result.hits.map((hit) => (
                  <li key={`${hit.conversationId}:${hit.messageId}:${hit.start}`}>
                    Chat {hit.conversationId} · entry {hit.entryId} · message {hit.messageId} ·{" "}
                    {hit.role} · origin chat {hit.originConversationId}: “{hit.match}”{" "}
                    {hit.conversationId !== current && (
                      <Link to="/chats/{-$chatId}" params={{ chatId: hit.conversationId }}>
                        Open chat (not entry)
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {download && (
            <>
              <Boundaries report={download.report} />
              <Button size="sm" onClick={save}>
                Download {download.format === "json" ? "JSON" : "Markdown"}
              </Button>
            </>
          )}
        </CollapsibleContent>
      </CollapsibleRoot>
    </section>
  );
}
