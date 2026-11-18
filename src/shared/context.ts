import { z } from "zod";

const CountSchema = z.number().finite().nonnegative();
const ModelSchema = z.strictObject({ provider: z.string(), modelId: z.string() });

// These measurements deliberately do not describe a fully assembled provider request.
export const ContextMeasurementsSchema = z.strictObject({
  observedAt: z.number().finite(),
  model: ModelSchema.nullable(),
  contextWindow: CountSchema.positive().nullable(),
  contextWindowSource: z.literal("model-catalog"),
  committed: z.strictObject({
    status: z.enum(["approximate", "unknown"]),
    tokens: CountSchema.nullable(),
    method: z.literal("committed-content-utf8-bytes-divided-by-4-v1"),
    scope: z.literal("committed-context-only"),
    exclusions: z.array(z.string()),
    unsupported: z.array(z.enum(["image", "opaque-thinking", "opaque-signature"])),
  }),
  lastRequest: z
    .strictObject({
      source: z.literal("durable-assistant-message"),
      scope: z.literal("conversation-generation"),
      entryId: z.string(),
      model: ModelSchema,
      requestStartedAt: z.number().finite(),
      stopReason: z.string(),
      usageStatus: z.enum(["reported", "unknown"]),
      usage: z
        .strictObject({
          input: CountSchema,
          output: CountSchema,
          cacheRead: CountSchema,
          cacheWrite: CountSchema,
          cacheWrite1h: CountSchema.optional(),
          reasoning: CountSchema.optional(),
          totalTokens: CountSchema,
        })
        .nullable(),
    })
    .nullable(),
  comparison: z.strictObject({
    valid: z.literal(false),
    reasons: z.array(
      z.enum([
        "assembled-request-unavailable",
        "no-request-observation",
        "usage-unavailable",
        "model-changed",
        "context-boundary-changed",
        "new-entries",
        "response-appended",
        "in-flight-work",
        "queued-work",
      ]),
    ),
  }),
  occupancy: z.strictObject({
    status: z.literal("unknown"),
    tokens: z.null(),
  }),
  headroom: z.strictObject({
    status: z.literal("unknown"),
    tokens: z.null(),
    reason: z.literal("assembled-request-unavailable"),
  }),
  inFlight: z.boolean(),
  queued: z.boolean(),
});
export type ContextMeasurements = z.infer<typeof ContextMeasurementsSchema>;

export const CompactSchema = z.strictObject({
  instructions: z.string().trim().max(32_000),
});
export const CompactResultSchema = z.strictObject({ taskId: z.string().regex(/^[1-9]\d*$/) });
export const ContextSchema = z.strictObject({
  conversationId: z.string(),
  observedAt: z.number().finite(),
  measurements: ContextMeasurementsSchema,
  headId: z.string().nullable(),
  entryCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  roles: z.array(z.strictObject({ role: z.string(), count: z.number().int().nonnegative() })),
  entries: z.array(
    z.strictObject({ id: z.string(), kind: z.string(), messages: z.number().int().nonnegative() }),
  ),
  truncated: z.boolean(),
  compactions: z.array(
    z.strictObject({
      taskId: z.string(),
      trigger: z.enum(["manual", "threshold", "overflow"]),
      blocking: z.boolean(),
      attempt: z.number().int().nonnegative(),
      retryAt: z.number().finite().nullable(),
    }),
  ),
  failure: z
    .strictObject({
      taskId: z.string(),
      trigger: z.enum(["manual", "threshold", "overflow"]),
    })
    .nullable(),
});
export type ChatContext = z.infer<typeof ContextSchema>;
