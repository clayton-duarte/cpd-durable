import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
  TranscriptLimitsSchema,
  TranscriptScopeSchema,
  type TranscriptEntry,
  type TranscriptLimits,
  type TranscriptReport,
  type TranscriptScope,
} from "../shared/history-operations.ts";

export type CatalogTranscript = {
  conversation: Pick<Conversation, "id" | "entries">;
  archived: boolean;
};
// Must resolve only current, nondeleted catalog members. This module never discovers IDs.
export type ResolveTranscript = (id: string) => Promise<CatalogTranscript | undefined>;
export class TranscriptReadError extends Error {
  constructor() {
    super("Transcript scope or history is unavailable.");
    this.name = "TranscriptReadError";
  }
}

type FrozenConversation = CatalogTranscript & { upperEntryId?: EntryId | null };
export type FrozenTranscriptScope = {
  readonly scope: TranscriptScope;
  readonly conversations: readonly FrozenConversation[];
};

// Each conversation freezes independently, not as a session-wide transactional snapshot.
// Cancellation is cooperative between bounded SDK reads; it never aborts agent work.
export async function freezeTranscriptScope(
  scope: TranscriptScope,
  resolve: ResolveTranscript,
  signal?: AbortSignal,
): Promise<FrozenTranscriptScope> {
  const parsed = TranscriptScopeSchema.parse(scope);
  const conversations: FrozenConversation[] = [];
  try {
    // Resolve the entire allowlist before reading any transcript.
    for (const id of parsed.conversationIds) {
      const item = await resolve(id);
      if (
        !item ||
        String(item.conversation.id) !== id ||
        (item.archived && !parsed.includeArchived)
      )
        throw new TranscriptReadError();
      conversations.push({ ...item });
    }
    for (const item of conversations) {
      if (signal?.aborted) break;
      const page = await item.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
      item.upperEntryId = page.items[0]?.id ?? null;
    }
  } catch {
    // Never forward SDK errors, paths, diagnostics, or resolver details.
    throw new TranscriptReadError();
  }
  return { scope: parsed, conversations };
}

function projectEntry(entry: EntryRecord, conversationId: string): TranscriptEntry {
  const messages: TranscriptEntry["messages"] = [];
  let omittedContent = entry.data !== undefined || entry.edits !== undefined;
  for (const [index, message] of (entry.model ?? []).entries()) {
    if (message.role !== "user" && message.role !== "assistant") {
      omittedContent = true;
      continue;
    }
    const parts =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const omitted = parts.some((part) => part.type !== "text");
    omittedContent ||= omitted;
    messages.push({
      messageId: `${entry.id}:${index}`,
      role: message.role,
      text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      omittedContent: omitted,
    });
  }
  const kinds = {
    "pi.user": "user",
    "pi.assistant": "assistant",
    "pi.reset": "reset",
    "pi.compaction": "compaction",
  } as const;
  return {
    conversationId,
    originConversationId: String(entry.conversationId),
    entryId: entry.id,
    kind: kinds[entry.kind as keyof typeof kinds] ?? "other",
    ...(entry.head === undefined ? {} : { headEntryId: entry.head }),
    omittedContent,
    messages,
  };
}

// SDK fork-aware scans are the only source. No retained transcript or search index.
// Return false from visit to cap an operation; the stopping entry counts as scanned.
export async function scanTranscripts(
  frozen: FrozenTranscriptScope,
  visit: (entry: TranscriptEntry) => boolean | Promise<boolean>,
  options: { limits?: TranscriptLimits; signal?: AbortSignal } = {},
): Promise<TranscriptReport> {
  const limits = TranscriptLimitsSchema.parse(options.limits ?? {});
  const report: TranscriptReport = {
    scope: frozen.scope,
    status: "complete",
    partial: false,
    scannedEntries: 0,
    conversations: frozen.conversations.map((item) => ({
      conversationId: String(item.conversation.id),
      archived: item.archived,
      ...(item.upperEntryId === undefined ? {} : { upperEntryId: item.upperEntryId }),
      scannedEntries: 0,
      complete: false,
    })),
  };
  function stop(status: "capped" | "cancelled") {
    report.status = status;
    report.partial = true;
    return report;
  }
  try {
    for (const [index, item] of frozen.conversations.entries()) {
      const progress = report.conversations[index]!;
      if (options.signal?.aborted || item.upperEntryId === undefined) return stop("cancelled");
      if (item.upperEntryId === null) {
        progress.complete = true;
        continue;
      }
      let cursor: Cursor | undefined;
      do {
        if (options.signal?.aborted) return stop("cancelled");
        const page = await item.conversation.entries(
          { order: "ascending", maxEntryId: item.upperEntryId },
          limits.pageSize,
          cursor,
          BACKGROUND_CONTEXT,
        );
        for (const entry of page.items) {
          if (options.signal?.aborted) return stop("cancelled");
          if (report.scannedEntries >= limits.maxEntries) return stop("capped");
          report.scannedEntries++;
          progress.scannedEntries++;
          if (!(await visit(projectEntry(entry, progress.conversationId)))) return stop("capped");
        }
        cursor = page.next;
      } while (cursor !== undefined);
      progress.complete = true;
    }
    if (options.signal?.aborted) return stop("cancelled");
    return report;
  } catch {
    throw new TranscriptReadError();
  }
}
