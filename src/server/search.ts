import {
  TranscriptSearchSchema,
  TranscriptSearchResultSchema,
  type TranscriptLimits,
  type TranscriptScope,
  type TranscriptSearch,
  type TranscriptSearchResult,
} from "../shared/history-operations.ts";
import {
  freezeTranscriptScope,
  scanTranscripts,
  type ResolveTranscript,
} from "./transcript-reader.ts";

export async function searchTranscripts(
  scope: TranscriptScope,
  resolve: ResolveTranscript,
  request: TranscriptSearch,
  options: { limits?: TranscriptLimits; signal?: AbortSignal } = {},
): Promise<TranscriptSearchResult> {
  const query = TranscriptSearchSchema.parse(request);
  const literal = query.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-aware literal matching; offsets deliberately use JS/DOM UTF-16 units.
  // No normalization, locale-dependent folding, or regular-expression input.
  const pattern = new RegExp(literal, query.caseSensitive ? "gu" : "giu");
  const hits: TranscriptSearchResult["hits"] = [];
  const frozen = await freezeTranscriptScope(scope, resolve, options.signal);
  const report = await scanTranscripts(
    frozen,
    (entry) => {
      for (const message of entry.messages) {
        pattern.lastIndex = 0;
        for (const match of message.text.matchAll(pattern)) {
          // Probe one additional actual match, so an exact-limit complete result stays complete.
          if (hits.length >= query.maxResults) return false;
          hits.push({
            conversationId: entry.conversationId,
            originConversationId: entry.originConversationId,
            entryId: entry.entryId,
            messageId: message.messageId,
            role: message.role,
            start: match.index,
            end: match.index + match[0].length,
            match: match[0],
          });
        }
      }
      return true;
    },
    options,
  );
  return TranscriptSearchResultSchema.parse({
    report,
    query: query.query,
    caseSensitive: query.caseSensitive,
    offsetEncoding: "utf-16",
    hits,
  });
}
