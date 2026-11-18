import { Hono } from "hono";
import { z, ZodError } from "zod";
import { type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { ChatIdSchema } from "../shared/chats.ts";
import {
  CreateTangentSchema,
  ReturnHandoffSchema,
  StartTangentSchema,
  TangentViewSchema,
} from "../shared/tangents.ts";
import {
  acceptReturn,
  admitTangentStart,
  deliverReturn,
  listTangents,
  recordReturn,
  returnDeliveryStatus,
  setTangentLifecycle,
  startPreparedTangent,
  type TangentHooks,
} from "./tangents/index.ts";
import { ChatLifecycleError } from "./chats.ts";
import { ModelPolicyError } from "./model-policy.ts";

export class TangentPolicyUnavailable extends Error {}
class UnsupportedMedia extends Error {}
const lifecycle = z.enum(["open", "concluded", "archived"]);
const lifecycleRequest = z.strictObject({ expected: lifecycle, next: lifecycle });
const revisionRequest = z.strictObject({ revision: z.number().int().positive().safe() });
const id = (value: string | undefined) => Number(ChatIdSchema.parse(value)) as ConversationId;

export function createTangentRoutes(harness: Harness, hooks: TangentHooks, models: Models) {
  const routes = new Hono();
  async function view(parent: ConversationId) {
    const items = await listTangents(harness, parent, hooks);
    return Promise.all(
      items.map(async ({ tangent, activity, readOnly }) => {
        const selected = tangent.model.selection;
        let name: string | null = null;
        try {
          name =
            (await models.getAvailable(selected.provider)).find(
              (entry) => entry.id === selected.modelId,
            )?.name ?? null;
        } catch {
          /* Catalog may be unavailable; identity remains known. */
        }
        return TangentViewSchema.parse({
          id: tangent.id,
          parentId: tangent.parentId,
          sourceId: tangent.sourceId,
          sourceEntryId: tangent.sourceEntryId,
          title: tangent.title,
          model: { ...selected, name },
          lifecycle: tangent.lifecycle,
          readOnly,
          activity,
          attention: tangent.attention,
          handoffRevision: tangent.versions.length,
          startState:
            tangent.startSubmissionId !== undefined
              ? "admitted"
              : tangent.start
                ? "prepared"
                : "create-only",
          latestHandoff: {
            revision: tangent.versions.at(-1)!.revision,
            kind: tangent.versions.at(-1)!.kind,
            handoff: tangent.versions.at(-1)!.handoff,
            delivery: tangent.versions.at(-1)!.delivery,
            submissionId: tangent.versions.at(-1)!.submissionId ?? null,
            accepted: tangent.versions.at(-1)!.accepted,
          },
        });
      }),
    );
  }
  async function body(request: Request): Promise<unknown> {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new UnsupportedMedia();
    const value: unknown = await request.json().catch(() => {
      throw new ZodError([]);
    });
    return value;
  }
  const base = "/api/chats/:mainId/tangents";
  routes.get(base, async (c) => c.json({ tangents: await view(id(c.req.param("mainId"))) }));
  routes.post(base, async (c) => {
    const parent = id(c.req.param("mainId"));
    const request = CreateTangentSchema.parse(await body(c.req.raw));
    if (request.parentId !== parent || request.sourceId !== parent)
      return c.json({ error: "Tangent source does not match main chat." }, 400);
    const created = await admitTangentStart(harness, request, hooks);
    const item = (await view(parent)).find((entry) => entry.id === created.id);
    if (!item) throw new Error("Created tangent unavailable");
    return c.json({ tangent: item }, 201);
  });
  routes.get(`${base}/:tangentId`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId"));
    const item = (await view(parent)).find((entry) => entry.id === tangent);
    return item ? c.json({ tangent: item }) : c.json({ error: "Tangent not found." }, 404);
  });
  routes.post(`${base}/:tangentId/start`, async (c) => {
    const parent = id(c.req.param("mainId"));
    const tangent = id(c.req.param("tangentId"));
    const request = StartTangentSchema.parse(await body(c.req.raw));
    await startPreparedTangent(
      harness,
      parent,
      tangent,
      request.requestId,
      request.expectedHandoffRevision,
      hooks,
    );
    const item = (await view(parent)).find((entry) => entry.id === tangent);
    if (!item) throw new Error("Tangent unavailable");
    return c.json({ tangent: item }, 202);
  });
  routes.post(`${base}/:tangentId/lifecycle`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId"));
    const request = lifecycleRequest.parse(await body(c.req.raw));
    await setTangentLifecycle(
      harness,
      parent,
      parent,
      tangent,
      request.expected,
      request.next,
      hooks,
    );
    return c.json({ tangent: (await view(parent)).find((entry) => entry.id === tangent) });
  });
  routes.post(`${base}/:tangentId/returns`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId"));
    const request = ReturnHandoffSchema.parse(await body(c.req.raw));
    if (request.tangentId !== tangent) return c.json({ error: "Tangent identity mismatch." }, 400);
    // The path supplies caller identity; assertCaller verifies its catalog relation in the commit.
    const result = await recordReturn(harness, tangent, parent, request, hooks);
    return c.json({
      revision: result.revision,
      delivery: result.delivery,
      accepted: result.accepted,
    });
  });
  routes.post(`${base}/:tangentId/deliver`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId"));
    const { revision } = revisionRequest.parse(await body(c.req.raw));
    const result = await deliverReturn(harness, parent, parent, tangent, revision, hooks);
    return c.json({
      revision: result.revision,
      delivery: result.delivery,
      submissionId: result.submissionId ?? null,
      accepted: result.accepted,
    });
  });
  routes.post(`${base}/:tangentId/accept`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId"));
    const { revision } = revisionRequest.parse(await body(c.req.raw));
    const result = await acceptReturn(harness, parent, parent, tangent, revision, hooks);
    return c.json({ revision: result.revision, accepted: result.accepted });
  });
  routes.get(`${base}/:tangentId/returns/:revision`, async (c) => {
    const parent = id(c.req.param("mainId")),
      tangent = id(c.req.param("tangentId")),
      revision = Number(ChatIdSchema.parse(c.req.param("revision")));
    return c.json(await returnDeliveryStatus(harness, parent, parent, tangent, revision, hooks));
  });
  routes.onError((error, c) =>
    error instanceof UnsupportedMedia
      ? c.json({ error: "Expected application/json." }, 415)
      : error instanceof ZodError
        ? c.json({ error: "Invalid tangent request." }, 400)
        : error instanceof TangentPolicyUnavailable
          ? c.json({ error: "Tangent model policy is unavailable." }, 503)
          : error instanceof ChatLifecycleError
            ? c.json({ error: error.message }, error.status)
            : error instanceof ModelPolicyError
              ? c.json({ error: error.message }, 409)
              : c.json({ error: "Tangent request unavailable or changed." }, 409),
  );
  return routes;
}
