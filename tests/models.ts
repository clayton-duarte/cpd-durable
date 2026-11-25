import type {
  AssistantMessage,
  SimpleStreamOptions,
  TranscriptContext,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { MODEL_ID, PROVIDER_ID } from "../src/shared/chat.ts";

type TestCall = {
  context: TranscriptContext;
  modelId: string;
  partial(text: string): void;
  finish(text: string, usage?: Usage): void;
  tools(calls: Omit<ToolCall, "type">[]): void;
  fail(usage?: Usage): void;
};

export function testModels(onCall?: (call: TestCall) => void) {
  const calls: TestCall[] = [];
  const models = createModels({
    authContext: {
      env: async () => "test-only",
      fileExists: async () => false,
    },
  });
  const provider = opencodeGoProvider();
  function stream(
    modelId: string,
    context: TranscriptContext,
    options?: Pick<SimpleStreamOptions, "signal">,
  ) {
    const events = createAssistantMessageEventStream();
    let message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: PROVIDER_ID,
      model: MODEL_ID,
      stopReason: "pending",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const abort = () => {
      message = { ...message, stopReason: "aborted" };
      events.push({ type: "error", reason: "aborted", error: message });
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const call: TestCall = {
      context,
      modelId,
      partial(text) {
        message = { ...message, content: [{ type: "text", text }] };
        events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      },
      finish(text, usage) {
        options?.signal?.removeEventListener("abort", abort);
        message = {
          ...message,
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: usage ?? message.usage,
        };
        events.push({ type: "done", reason: "stop", message });
      },
      tools(calls) {
        options?.signal?.removeEventListener("abort", abort);
        message = {
          ...message,
          content: calls.map((call) => ({ type: "toolCall", ...call })),
          stopReason: "toolUse",
        };
        events.push({ type: "done", reason: "toolUse", message });
      },
      fail(usage) {
        options?.signal?.removeEventListener("abort", abort);
        message = {
          ...message,
          stopReason: "error",
          errorMessage: "PRIVATE_PROVIDER_DIAGNOSTIC",
          usage: usage ?? message.usage,
        };
        events.push({ type: "error", reason: "error", error: message });
      },
    };
    calls.push(call);
    events.push({ type: "start", partial: message });
    onCall?.(call);
    return events;
  }
  models.setProvider({
    ...provider,
    stream: (model, context, options) => stream(model.id, context, options),
    streamSimple: (model, context, options) => stream(model.id, context, options),
  });
  return { models, calls };
}
