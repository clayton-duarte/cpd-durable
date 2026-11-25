import type { ChatState, HistoryGap } from "../shared/chat.ts";

/** Select history the user can actually see, not inherited parent-only pages. */
export function historyNavigation(
  state: ChatState | null,
  visibleFromEntryId?: number,
): {
  hasEarlier: boolean;
  gap?: HistoryGap;
} {
  const gap = state?.history?.gaps
    .filter((item) => visibleFromEntryId === undefined || item.upTo > visibleFromEntryId)
    .reduce<HistoryGap | undefined>(
      (latest, item) => (!latest || item.upTo > latest.upTo ? item : latest),
      undefined,
    );
  const oldest = state?.history?.oldest;
  const earlier =
    !!state?.hasEarlier &&
    (visibleFromEntryId === undefined || oldest === undefined || oldest > visibleFromEntryId);
  return { hasEarlier: !!gap || earlier, ...(gap ? { gap } : {}) };
}
