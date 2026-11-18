import {
  TranscriptExportOptionsSchema,
  TranscriptExportSchema,
  type TranscriptExport,
  type TranscriptExportOptions,
  type TranscriptLimits,
  type TranscriptScope,
} from "../shared/history-operations.ts";
import {
  freezeTranscriptScope,
  scanTranscripts,
  type ResolveTranscript,
} from "./transcript-reader.ts";

export async function exportTranscripts(
  scope: TranscriptScope,
  resolve: ResolveTranscript,
  options: {
    limits?: TranscriptLimits;
    signal?: AbortSignal;
    export?: TranscriptExportOptions;
  } = {},
): Promise<TranscriptExport> {
  const policy = TranscriptExportOptionsSchema.parse(options.export ?? {});
  const entries: TranscriptExport["entries"] = [];
  let characters = 0;
  const frozen = await freezeTranscriptScope(scope, resolve, options.signal);
  const report = await scanTranscripts(
    frozen,
    (entry) => {
      const next = entry.messages.reduce((count, message) => count + message.text.length, 0);
      if (characters + next > policy.maxTextCharacters) return false;
      characters += next;
      entries.push(entry);
      return true;
    },
    options,
  );
  return TranscriptExportSchema.parse({
    format: "cpd-logical-transcript-v1",
    restorableBackup: false,
    contentPolicy: "user-assistant-text-only",
    inheritedHistory: "repeated-per-conversation",
    report,
    entries,
  });
}

// Validation strips no fields silently: callers must pass this explicit logical format.
export function transcriptExportJson(value: TranscriptExport): string {
  return JSON.stringify(TranscriptExportSchema.parse(value), null, 2);
}

export function transcriptExportMarkdown(value: TranscriptExport): string {
  const transcript = TranscriptExportSchema.parse(value);
  const lines = [
    "# Logical transcript",
    "",
    "Not a restorable database backup. User/assistant text only; reasoning, tool payloads, images, and private metadata are omitted.",
    "Raw history order is preserved across resets and compaction. Inherited fork history repeats per selected conversation.",
    "",
    `Status: ${transcript.report.status}. Scanned entries: ${transcript.report.scannedEntries}.`,
  ];
  for (const progress of transcript.report.conversations) {
    lines.push(
      "",
      `## Conversation ${progress.conversationId}`,
      "",
      `Upper entry: ${progress.upperEntryId === undefined ? "not frozen" : (progress.upperEntryId ?? "empty")}. Complete: ${progress.complete}. Archived: ${progress.archived}.`,
    );
    for (const entry of transcript.entries.filter(
      (entry) => entry.conversationId === progress.conversationId,
    )) {
      lines.push(
        "",
        `### Entry ${entry.entryId} (${entry.kind}; origin conversation ${entry.originConversationId})`,
      );
      if (entry.headEntryId !== undefined) lines.push("", `Context head: ${entry.headEntryId}.`);
      if (entry.omittedContent) lines.push("", "Non-text/private content omitted.");
      for (const message of entry.messages) {
        // Literal fenced content prevents transcript text from escaping into export chrome.
        let longest = 0;
        for (const match of message.text.matchAll(/`+/g))
          longest = Math.max(longest, match[0].length);
        const fence = "`".repeat(Math.max(3, longest + 1));
        lines.push(
          "",
          `#### ${message.role} (${message.messageId})`,
          "",
          `${fence}text`,
          message.text,
          fence,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
