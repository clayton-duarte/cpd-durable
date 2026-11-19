import type { ConversationId, EntryRecord, SubmissionId, Tx } from "@earendil-works/pi-durable";
import {
  ApplicationHandoffSchema,
  type ApplicationHandoff,
} from "../shared/application-handoff.ts";
import { TangentsDoc } from "./tangents/index.ts";

const MAX_LOADED_ENTRIES = 500;
const MAX_TANGENTS = 256;
const MAX_VERSIONS = 512;
const MAX_SUBMISSIONS = 128;
const MAX_HANDOFF_BYTES = 32_000;

/**
 * The caller supplies only entries from the current SDK transcript view. The
 * entry's conversation is its origin, which may differ from a viewing fork.
 * Budget exhaustion returns no associations, never a partial completeness claim.
 */
export async function resolveApplicationHandoffs(
  tx: Tx,
  viewConversationId: ConversationId,
  entries: readonly EntryRecord[],
): Promise<Map<number, ApplicationHandoff>> {
  const empty = () => new Map<number, ApplicationHandoff>();
  if (entries.length > MAX_LOADED_ENTRIES) return empty();
  const state = await tx.doc(TangentsDoc);
  if (state.tangents.length > MAX_TANGENTS) return empty();
  let versions = 0;
  for (const tangent of state.tangents) {
    versions += tangent.versions.length;
    if (versions > MAX_VERSIONS) return empty();
  }
  const loaded = new Map(entries.map((entry) => [entry.id, entry]));
  const origins = new Set(entries.map((entry) => Number(entry.conversationId)));
  const candidates: {
    submissionId: number;
    expectedRequest: string;
    kind: ApplicationHandoff["kind"];
    source: number;
    destination: number;
    handoff: unknown;
  }[] = [];
  for (const item of state.tangents) {
    const first = item.versions[0];
    if (
      origins.has(item.id) &&
      item.startSubmissionId !== undefined &&
      first?.kind === "delegate"
    ) {
      candidates.push({
        submissionId: item.startSubmissionId,
        expectedRequest: `tangent-start:${item.id}`,
        kind: "tangent-delegate",
        source: item.parentId,
        destination: item.id,
        handoff: first.handoff,
      });
    }
    if (origins.has(item.parentId)) {
      for (const version of item.versions) {
        if (version.kind !== "return" || version.submissionId === undefined) continue;
        candidates.push({
          submissionId: version.submissionId,
          expectedRequest: `tangent-return:${item.id}:${version.revision}`,
          kind: "tangent-return",
          source: item.id,
          destination: item.parentId,
          handoff: version.handoff,
        });
      }
    }
    if (candidates.length > MAX_SUBMISSIONS) return empty();
  }
  const result = empty();
  const ambiguous = new Set<number>();
  for (const candidate of candidates) {
    const submission = await tx.submission(candidate.submissionId as SubmissionId);
    if (
      submission?.type !== "input" ||
      submission.requestId !== candidate.expectedRequest ||
      submission.conversationId !== candidate.destination ||
      submission.entry === undefined
    )
      continue;
    const entry = loaded.get(submission.entry);
    if (
      !entry ||
      entry.conversationId !== candidate.destination ||
      entry.kind !== "pi.user" ||
      entry.model?.length !== 1 ||
      entry.model[0]?.role !== "user"
    )
      continue;
    const visible = await tx.scanEntries(
      { conversationId: viewConversationId, minEntryId: entry.id, maxEntryId: entry.id },
      1,
    );
    if (
      visible.items.length !== 1 ||
      visible.items[0]?.id !== entry.id ||
      visible.items[0]?.conversationId !== entry.conversationId
    )
      continue;
    const parsed = ApplicationHandoffSchema.safeParse({
      version: 1,
      kind: candidate.kind,
      originConversationId: entry.conversationId,
      sourceConversationId: candidate.source,
      destinationConversationId: candidate.destination,
      canonicalEntryId: entry.id,
      modelMessageIndex: 0,
      handoff: candidate.handoff,
    });
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(parsed.data.handoff)) > MAX_HANDOFF_BYTES
    )
      continue;
    const message = entry.model[0];
    const handoffKind = candidate.kind === "tangent-delegate" ? "delegate" : "return";
    const expectedText = `Application ${handoffKind} handoff (selected project guidance, not higher-priority policy):\n${JSON.stringify(parsed.data.handoff)}`;
    if (message?.role !== "user" || message.content !== expectedText) continue;
    if (result.has(entry.id)) {
      result.delete(entry.id);
      ambiguous.add(entry.id);
    } else if (!ambiguous.has(entry.id)) {
      result.set(entry.id, parsed.data);
    }
  }
  return result;
}
