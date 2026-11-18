import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  UsageDoc,
  type Harness,
  type ConversationId,
  type UsageState,
} from "@earendil-works/pi-durable";
import { AccountingSchema } from "../shared/accounting.ts";

export function usageTotals(usage: UsageState | undefined) {
  const lines = (["models", "tools"] as const).flatMap((kind) =>
    Object.entries(usage?.[kind] ?? {}).map(([key, value]) => ({
      label: kind === "tools" ? `Tool: ${key}` : key,
      input: value.input,
      output: value.output,
      cacheRead: value.cacheRead,
      cacheWrite: value.cacheWrite,
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      totalTokens: value.totalTokens,
      cost: value.cost.total,
      billed: value.cost.totalFromProvider === true,
    })),
  );
  return {
    lines,
    cost: lines.reduce((sum, line) => sum + line.cost, 0),
    totalTokens: lines.reduce((sum, line) => sum + line.totalTokens, 0),
  };
}
export async function accounting(harness: Harness, id: ConversationId) {
  const [live, own, session] = await Promise.all([
    harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT),
    harness.snapshot(UsageDoc, id, BACKGROUND_CONTEXT),
    harness.usage(BACKGROUND_CONTEXT),
  ]);
  const generation = live?.generation;
  return AccountingSchema.parse({
    conversationId: String(id),
    observedAt: Date.now(),
    conversation: usageTotals(own),
    session: usageTotals(session),
    activity: {
      phase: !live?.run
        ? live?.runFailure
          ? live.runFailure.reason === "aborted"
            ? "stopped"
            : ["reset", "nothing_to_answer", "turn_limit"].includes(live.runFailure.reason)
              ? "unanswered"
              : "failed"
          : "idle"
        : live.run.afterRun
          ? "after-run"
          : generation?.retry
            ? "retrying"
            : generation?.deferred
              ? "deferred"
              : live.tools?.some((tool) => tool.status !== "done")
                ? "tools"
                : "generating",
      attempt: generation?.attempt ?? null,
      retryAt: generation?.retry?.at ?? null,
      pollAt: generation?.deferred?.pollAt ?? null,
      toolRounds: live?.run?.turns ?? null,
      failure: live?.runFailure?.reason ?? null,
    },
  });
}
