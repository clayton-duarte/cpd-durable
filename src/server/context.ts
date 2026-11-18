import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type Cursor,
  type Harness,
} from "@earendil-works/pi-durable";
import { ContextSchema, type ContextMeasurements } from "../shared/context.ts";

const exclusions = [
  "system-prompt-and-extension-resource-assembly",
  "tool-definitions-and-provider-framing",
  "provider-specific-message-and-thinking-transforms",
  "queued-input-and-in-flight-output",
  "output-and-reasoning-reservations",
];

/**
 * Content-size heuristic, not a tokenizer or a request measurement. Consume the
 * public context's edited/ordered messages, never serialized diagnostics/usage.
 * Unsupported image or opaque reasoning costs invalidate the whole estimate.
 */
export function estimateCommittedContext(messages: readonly Message[]) {
  let bytes = 0;
  const unsupported = new Set<ContextMeasurements["committed"]["unsupported"][number]>();
  const text = (value: string) => {
    bytes += Buffer.byteLength(value, "utf8");
  };
  for (const message of messages) {
    if (typeof message.content === "string") text(message.content);
    else
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            text(part.text);
            if (part.textSignature) unsupported.add("opaque-signature");
            break;
          case "thinking":
            text(part.thinking);
            if (part.redacted || part.thinkingSignature) unsupported.add("opaque-thinking");
            break;
          case "image":
            unsupported.add("image");
            break;
          case "toolCall":
            text(part.name);
            text(JSON.stringify(part.arguments));
            if (part.namespace) text(part.namespace);
            if (part.thoughtSignature) unsupported.add("opaque-signature");
            break;
        }
      }
    if (message.role === "system") {
      for (const section of Object.values(message.sections ?? {}))
        if (section !== null) text(section);
      // Context-carried tool definitions are content; runtime assembly is excluded.
      if (message.toolsAdded) text(JSON.stringify(message.toolsAdded));
      if (message.toolsRemoved) text(JSON.stringify(message.toolsRemoved));
    }
  }
  return {
    status: unsupported.size ? ("unknown" as const) : ("approximate" as const),
    tokens: unsupported.size ? null : Math.ceil(bytes / 4),
    method: "committed-content-utf8-bytes-divided-by-4-v1" as const,
    scope: "committed-context-only" as const,
    exclusions,
    unsupported: [...unsupported],
  };
}

async function lastAssistant(conversation: Conversation) {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 200, cursor, BACKGROUND_CONTEXT);
    const entry = page.items.find((item) => item.kind === AssistantEntry.kind);
    if (entry) return entry;
    cursor = page.next;
  } while (cursor);
  return undefined;
}

export async function inspectContext(
  harness: Harness,
  conversation: Conversation,
  models?: Models,
) {
  // Public committed reads are point-in-time, not an atomic assembled-request
  // snapshot. Never infer that a matching model/tail proves comparability.
  const [view, live, inbox, agent, history] = await Promise.all([
    conversation.context(BACKGROUND_CONTEXT),
    harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
    harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT),
    conversation.agent(BACKGROUND_CONTEXT),
    lastAssistant(conversation),
  ]);
  const observedAt = Date.now();
  const model = agent.model
    ? { provider: agent.model.provider, modelId: agent.model.modelId }
    : null;
  const catalog = model ? models?.getModel(model.provider, model.modelId) : undefined;
  const window = catalog?.contextWindow;
  const lastEntry = history;
  const lastMessage = lastEntry?.model?.find((message) => message.role === "assistant");
  const inFlight = !!live?.run || !!live?.compactions?.length;
  const queued = !!inbox?.items.length;
  const reasons: ContextMeasurements["comparison"]["reasons"] = ["assembled-request-unavailable"];
  let lastRequest: ContextMeasurements["lastRequest"] = null;
  if (lastEntry && lastMessage) {
    const usage = lastMessage.usage;
    // SDK defaults missing provider usage to all zero; absence cannot be
    // distinguished from a real zero-token report on this public surface.
    const reported = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
      (count) => count > 0,
    );
    lastRequest = {
      source: "durable-assistant-message",
      scope: "conversation-generation",
      entryId: String(lastEntry.id),
      model: { provider: lastMessage.provider, modelId: lastMessage.model },
      requestStartedAt: lastMessage.timestamp,
      stopReason: lastMessage.stopReason,
      usageStatus: reported ? "reported" : "unknown",
      usage: reported
        ? {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
            ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
            totalTokens: usage.totalTokens,
          }
        : null,
    };
    if (!reported) reasons.push("usage-unavailable");
    if (model?.provider !== lastMessage.provider || model?.modelId !== lastMessage.model)
      reasons.push("model-changed");
    const index = view.entries.findIndex((entry) => entry.id === lastEntry.id);
    if (index === -1) reasons.push("context-boundary-changed");
    else {
      reasons.push("response-appended");
      if (index < view.entries.length - 1) reasons.push("new-entries");
    }
  } else reasons.push("no-request-observation");
  if (inFlight) reasons.push("in-flight-work");
  if (queued) reasons.push("queued-work");
  const measurements: ContextMeasurements = {
    observedAt,
    model,
    contextWindow: window && Number.isFinite(window) && window > 0 ? window : null,
    contextWindowSource: "model-catalog",
    committed: estimateCommittedContext(view.messages),
    lastRequest,
    comparison: { valid: false, reasons },
    occupancy: { status: "unknown", tokens: null },
    headroom: { status: "unknown", tokens: null, reason: "assembled-request-unavailable" },
    inFlight,
    queued,
  };
  const roles = new Map<string, number>();
  for (const message of view.messages) roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
  return ContextSchema.parse({
    conversationId: String(conversation.id),
    observedAt,
    measurements,
    headId: view.head ? String(view.head.id) : null,
    entryCount: view.entries.length,
    messageCount: view.messages.length,
    roles: [...roles].map(([role, count]) => ({ role, count })),
    entries: view.entries.slice(-200).map((entry, index) => ({
      id: String(entry.id),
      kind: entry.kind,
      messages:
        view.contributions[view.entries.length - Math.min(200, view.entries.length) + index]
          ?.length ?? 0,
    })),
    truncated: view.entries.length > 200,
    compactions: (live?.compactions ?? []).map((status) => ({
      taskId: String(status.taskId),
      trigger: status.trigger,
      blocking: status.blocking,
      attempt: status.attempt,
      retryAt: status.retry?.at ?? null,
    })),
    failure: live?.compactionFailure
      ? {
          taskId: String(live.compactionFailure.taskId),
          trigger: live.compactionFailure.trigger,
        }
      : null,
  });
}
