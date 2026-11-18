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

// Bound the intermediate slice before splitting it into Unicode code points.
// Avoid leaving half of a surrogate pair at either outer edge.
function contextBefore(text: string, end: number): string {
  let start = Math.max(0, end - 80);
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start > 0) start++;
  return Array.from(text.slice(start, end)).slice(-40).join("");
}
function contextAfter(text: string, start: number): string {
  let end = Math.min(text.length, start + 80);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < text.length) end--;
  return Array.from(text.slice(start, end)).slice(0, 40).join("");
}

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
        for (const part of message.textParts) {
          pattern.lastIndex = 0;
          for (const match of part.text.matchAll(pattern)) {
            // Probe one additional actual match, so an exact-limit complete result stays complete.
            if (hits.length >= query.maxResults) return false;
            hits.push({
              conversationId: entry.conversationId,
              originConversationId: entry.originConversationId,
              entryId: entry.entryId,
              messageId: message.messageId,
              role: message.role,
              partIndex: part.partIndex,
              start: match.index,
              end: match.index + match[0].length,
              match: match[0],
              before: contextBefore(part.text, match.index),
              after: contextAfter(part.text, match.index + match[0].length),
            });
          }
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
