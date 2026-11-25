import { isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  configure,
  defineDoc,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { admissionDigest, checkAdmissionRequest } from "./attachment-catalog.ts";
import { slugaWithId } from "../shared/slugs.ts";
import { quotedReply } from "../shared/quote.ts";
import { ResolvedTangentModelSchema, type ResolvedTangentModel } from "../shared/tangents.ts";
import {
  CreateThreadSchema,
  ThreadSourceSchema,
  THREAD_REPLY_COUNT_LIMIT,
  THREAD_SOURCE_TEXT_LIMIT,
  type ThreadSource,
} from "../shared/threads.ts";

type ThreadRecord = {
  id: number;
  parentId: number;
  sourceEntryId: number;
  requestId: string;
  fingerprint: string;
  title: string;
  slug: string;
  firstText: string;
  firstSubmissionId?: number;
};
type State = { threads: ThreadRecord[] };

/** Application-thread identity only: the transcript stays in pi-durable. */
export const ThreadsDoc = defineDoc<JsonRepresentation<State>>({
  kind: "cpd.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: [] }),
  checkpointWhen: () => true,
});

/** The same message already owns a thread; the caller must open it, not fork again. */
export class ThreadExists extends Error {
  readonly id: number;
  constructor(id: number) {
    super("A thread already exists for this message.");
    this.id = id;
  }
}

/** Hooks run inside the thread operation's SDK transaction. */
export type ThreadHooks = {
  assertMain(tx: Tx, mainId: ConversationId): Promise<void>;
  assertMainReadable(tx: Tx, mainId: ConversationId): Promise<void>;
  isMainReadOnly(tx: Tx, mainId: ConversationId): Promise<boolean>;
  register(
    tx: Tx,
    thread: { id: ConversationId; parentId: ConversationId; title: string; slug: string },
  ): Promise<void>;
  resolveModel(): Promise<ResolvedTangentModel>;
  assertResolvedModel(tx: Tx, resolved: ResolvedTangentModel): Promise<void>;
  cwd(source: string | undefined): string;
};

type Driver = Pick<Harness, "commit" | "conversation">;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Bounded literal preview of one saved entry; never a rewritten transcript. */
export function entrySource(entry: EntryRecord, entryId: EntryId): ThreadSource {
  const messages = entry.model ?? [];
  const role = messages.some((message) => message.role === "user")
    ? "user"
    : messages.some((message) => message.role === "assistant")
      ? "assistant"
      : "other";
  const text: string[] = [];
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") text.push(content);
    else if (Array.isArray(content))
      for (const part of content) if (part.type === "text") text.push(part.text);
  }
  const joined = text.join("\n\n").trim();
  return ThreadSourceSchema.parse({
    entryId: String(entryId),
    role,
    text: joined.slice(0, THREAD_SOURCE_TEXT_LIMIT),
    truncated: joined.length > THREAD_SOURCE_TEXT_LIMIT,
  });
}

async function sourceOf(tx: Tx, parentId: ConversationId, entryId: EntryId) {
  const page = await tx.scanEntries(
    { conversationId: parentId, minEntryId: entryId, maxEntryId: entryId },
    1,
  );
  const entry = page.items.find((item) => item.id === entryId);
  if (!entry) throw new Error("Saved message is not visible in this chat.");
  return entrySource(entry, entryId);
}

async function activityOf(tx: Tx, id: ConversationId) {
  const live = await tx.doc(LiveDoc, id);
  const inbox = await tx.doc(InboxDoc, id);
  const failure = live.runFailure?.reason;
  if (live.run)
    return live.tools?.some((tool) => tool.name === "ask_user" && tool.status === "running")
      ? ("waiting" as const)
      : ("running" as const);
  if (live.compactions?.length) return "running" as const;
  if (inbox.items.length) return "waiting" as const;
  if (failure === "aborted" || failure === "interrupted") return "interrupted" as const;
  if (failure) return "failed" as const;
  return "idle" as const;
}

/** Replies are the thread's own user entries after the fork boundary, never inherited history. */
async function replyCount(tx: Tx, id: ConversationId, after: EntryId) {
  if (after >= Number.MAX_SAFE_INTEGER) return { count: 0, capped: false };
  const page = await tx.scanEntries(
    { conversationId: id, minEntryId: (after + 1) as EntryId, order: "descending" },
    THREAD_REPLY_COUNT_LIMIT,
  );
  return {
    count: page.items.filter((entry) => entry.kind === "pi.user").length,
    capped: page.items.length >= THREAD_REPLY_COUNT_LIMIT,
  };
}

async function viewOf(tx: Tx, item: ThreadRecord) {
  const replies = await replyCount(tx, item.id as ConversationId, item.sourceEntryId as EntryId);
  return {
    id: String(item.id),
    parentId: String(item.parentId),
    sourceEntryId: String(item.sourceEntryId),
    slug: item.slug,
    title: item.title,
    replyCount: replies.count,
    replyCountCapped: replies.capped,
    activity: await activityOf(tx, item.id as ConversationId),
    source: await sourceOf(tx, item.parentId as ConversationId, item.sourceEntryId as EntryId),
  };
}

export async function listThreads(
  driver: Pick<Harness, "commit">,
  parentId: ConversationId,
  hooks: ThreadHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  return driver.commit(async (tx) => {
    await hooks.assertMainReadable(tx, parentId);
    const state = await tx.doc(ThreadsDoc);
    const threads = [];
    for (const item of state.threads.filter((thread) => thread.parentId === parentId))
      threads.push(await viewOf(tx, copy(item)));
    return threads;
  }, context);
}

export async function readThreadSource(
  driver: Pick<Harness, "commit">,
  parentId: ConversationId,
  entryId: EntryId,
  hooks: ThreadHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  return driver.commit(async (tx) => {
    await hooks.assertMainReadable(tx, parentId);
    return sourceOf(tx, parentId, entryId);
  }, context);
}

/**
 * Preparation forks the exact saved message and pins the thread's model in one
 * commit; admission is separate, so a lost response can be retried by identity
 * without forking again or replaying the accepted reply.
 */
export async function createMessageThread(
  driver: Driver,
  input: unknown,
  hooks: ThreadHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  const request = CreateThreadSchema.parse(input);
  const parentId = Number(request.parentId) as ConversationId;
  const at = Number(request.sourceEntryId) as EntryId;
  const fingerprint = JSON.stringify([
    Number(request.parentId),
    at,
    request.text,
    ...(request.quote === undefined ? [] : [request.quote]),
  ]);
  const resolved = ResolvedTangentModelSchema.parse(await hooks.resolveModel());
  if (resolved.assignment !== "tangent") throw new Error("Tangent model assignment required");

  const prepared = await driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(ThreadsDoc);
    const previous = state.threads.find((item) => item.requestId === request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Request identity conflicts with prior thread");
      return copy(previous);
    }
    const existing = state.threads.find(
      (item) => item.parentId === parentId && item.sourceEntryId === at,
    );
    if (existing) throw new ThreadExists(existing.id);
    await sourceOf(tx, parentId, at);
    const sourceAgent = await tx.doc(AgentDoc, parentId);
    await hooks.assertResolvedModel(tx, resolved);
    const model = resolved.selection;
    const cwd = hooks.cwd(sourceAgent.cwd);
    if (!model.provider || !model.modelId || !isAbsolute(cwd))
      throw new Error("Thread model and absolute cwd policy are required");
    const forked = await tx.forkConversation(parentId, at, {
      ownership: { kind: "ownerless" },
    });
    await configure(tx, forked.id, {
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel: model.thinkingLevel,
      cwd,
    });
    const title = request.text.replace(/\s+/g, " ").slice(0, 80);
    const slug = slugaWithId(forked.id, title, "thread");
    await hooks.register(tx, { id: forked.id, parentId, title, slug });
    const item: ThreadRecord = {
      id: forked.id,
      parentId,
      sourceEntryId: at,
      requestId: request.requestId,
      fingerprint,
      title,
      slug,
      firstText:
        request.quote === undefined ? request.text : quotedReply(request.text, request.quote),
    };
    state.threads.push(copy(item) as JsonRepresentation<ThreadRecord>);
    return copy(item);
  }, context);

  if (prepared.firstSubmissionId !== undefined) return prepared;
  const child = await driver.conversation(prepared.id as ConversationId, context);
  if (!child) throw new Error("Prepared thread unavailable");
  let admitted: number | undefined;
  await driver.commit(async (tx) => {
    await hooks.assertMain(tx, parentId);
    const state = await tx.doc(ThreadsDoc);
    const item = state.threads.find(
      (thread) => thread.id === prepared.id && thread.parentId === parentId,
    );
    if (!item) throw new Error("Thread unavailable");
    if (item.firstSubmissionId !== undefined) {
      admitted = item.firstSubmissionId;
      return;
    }
    const draft = {
      type: "input",
      requestId: `thread-first:${item.requestId}`,
      content: item.firstText,
      whenBusy: "reject",
    } as const;
    const record = await checkAdmissionRequest(
      tx,
      prepared.id as ConversationId,
      draft.requestId,
      admissionDigest(["thread-first", draft]),
    );
    const submission = await child.submit(tx, draft);
    record();
    item.firstSubmissionId = submission;
    admitted = submission;
  }, context);
  return admitted === undefined
    ? copy(prepared)
    : copy({ ...prepared, firstSubmissionId: admitted });
}

/** Read-only thread identity for a caller that already holds a resolved view. */
export async function threadView(
  driver: Pick<Harness, "commit">,
  parentId: ConversationId,
  id: ConversationId,
  hooks: ThreadHooks,
  context: Context = BACKGROUND_CONTEXT,
) {
  return driver.commit(async (tx) => {
    await hooks.assertMainReadable(tx, parentId);
    const state = await tx.doc(ThreadsDoc);
    const item = state.threads.find((thread) => thread.id === id && thread.parentId === parentId);
    return item ? viewOf(tx, copy(item)) : undefined;
  }, context);
}
