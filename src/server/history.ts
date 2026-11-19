import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type ConversationId,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import type { ChatState } from "../shared/chat.ts";
import type { openChat } from "./chat.ts";
import { present } from "./presentation.ts";
import type { ApplicationHandoff } from "../shared/application-handoff.ts";

type Conversation = Awaited<ReturnType<typeof openChat>>["conversation"];
type Listener = (state: ChatState) => Promise<void>;
type Watch = Awaited<ReturnType<Conversation["watch"]>>;
type ResolveHandoffs = (
  view: ConversationId,
  entries: readonly EntryRecord[],
) => Promise<ReadonlyMap<number, ApplicationHandoff>>;

// One transient SDK transcript per browser view, not a second transcript store.
// Detaching stops observation, not work; the retained transcript can resume.
class HistoryView {
  readonly epoch = randomUUID();
  readonly transcript: ConversationTranscript;
  readonly listeners = new Set<Listener>();
  watch: Watch | undefined;
  opening: Promise<void> | undefined;
  state: ChatState | undefined;
  revision = 0;
  readonly id: string;
  readonly conversation: Conversation;
  readonly resolveHandoffs: ResolveHandoffs | undefined;
  constructor(id: string, conversation: Conversation, resolveHandoffs?: ResolveHandoffs) {
    this.id = id;
    this.conversation = conversation;
    this.resolveHandoffs = resolveHandoffs;
    this.transcript = new ConversationTranscript(
      (query, limit, context) => conversation.entries(query, limit, undefined, context),
      { pageSize: 50 },
    );
  }

  async publish(view: TranscriptView, window: ConversationView) {
    const revision = ++this.revision;
    const gaps = view.items.flatMap((item) =>
      item.kind === "gap" ? [{ after: item.after, upTo: item.upTo }] : [],
    );
    const entries = view.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
    // Association is optional display evidence; its failure must not hide history.
    let handoffs: ReadonlyMap<number, ApplicationHandoff> | undefined;
    try {
      handoffs = await this.resolveHandoffs?.(this.conversation.id, entries);
    } catch {
      // History remains authoritative even if the optional association is unavailable.
    }
    const state = present({ ...window, entries }, false, gaps, handoffs);
    state.window = {
      entryIds: window.entries.map((entry) => entry.id),
      ...(window.before !== undefined ? { beforeEntryId: window.before } : {}),
    };
    if (state.live) state.live.afterEntryId = window.entries.at(-1)?.id ?? window.before ?? null;
    state.hasEarlier = view.items[0]?.kind === "earlier";
    state.history = {
      view: this.id,
      epoch: this.epoch,
      revision,
      gaps,
      ...(entries[0] ? { oldest: entries[0].id } : {}),
    };
    if (!state.busy && state.controls && !state.controls.resetPending) {
      const context = await this.conversation.context(BACKGROUND_CONTEXT);
      const last = context.messages.findLast((message) => message.role !== "system");
      state.controls.canContinue = last?.role === "user" || last?.role === "toolResult";
    }
    if (!this.state || revision > this.state.history!.revision) {
      this.state = state;
      await Promise.allSettled([...this.listeners].map((listener) => listener(state)));
    }
    return state;
  }

  latest: ConversationView | undefined;
  async observe(oldest?: number) {
    if (this.watch) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const watch = await this.conversation.watch(BACKGROUND_CONTEXT, this.transcript.resume);
      this.watch = watch;
      this.latest = watch.value;
      try {
        // After host restart/cache expiry, reconstruct one bounded oldest page.
        // Joining the latest window creates explicit SDK gaps, never a false
        // claim that the intervening history has been loaded.
        if (
          this.transcript.resume === undefined &&
          oldest !== undefined &&
          oldest < (watch.value.entries[0]?.id ?? Infinity)
        ) {
          const page = await this.conversation.entries(
            { minEntryId: oldest as EntryId, order: "ascending" },
            50,
            undefined,
            BACKGROUND_CONTEXT,
          );
          const previous = await this.conversation.entries(
            { maxEntryId: (oldest - 1) as EntryId, order: "descending" },
            1,
            undefined,
            BACKGROUND_CONTEXT,
          );
          this.transcript.merge({
            conversation: watch.value.conversation,
            docs: watch.value.docs,
            entries: page.items,
            ...(previous.items[0] ? { before: previous.items[0].id } : {}),
          });
        }
        await this.publish(this.transcript.merge(watch.value), watch.value);
        watch.start(async (call) => {
          if (call.kind !== "value" || this.watch !== watch) return;
          this.latest = call.value;
          await this.publish(this.transcript.merge(call.value), call.value);
        });
        const ended = () => {
          if (this.watch === watch) this.watch = undefined;
        };
        void watch.closed.then(ended, ended);
      } catch (error) {
        this.watch = undefined;
        await watch.stop();
        throw error;
      }
    })();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  async detach() {
    if (this.listeners.size !== 0) return;
    const watch = this.watch;
    this.watch = undefined;
    await watch?.stop();
  }

  async load(gap?: { after: number; upTo: number }) {
    if (!this.latest) throw new Error("History view is not attached.");
    await (gap
      ? this.transcript.fillGap(
          { kind: "gap", after: gap.after as EntryId, upTo: gap.upTo as EntryId },
          BACKGROUND_CONTEXT,
        )
      : this.transcript.loadEarlier(BACKGROUND_CONTEXT));
    // A watch may advance between the loader resolving and this continuation.
    // Publish the SDK's current merged view, never the loader's older return value.
    return this.publish(this.transcript.merge(this.latest), this.latest);
  }
}

export function createHistory(conversation: Conversation, resolveHandoffs?: ResolveHandoffs) {
  const views = new Map<string, HistoryView>();
  const expiry = new Map<string, ReturnType<typeof setTimeout>>();
  function retain(id: string) {
    clearTimeout(expiry.get(id));
    expiry.delete(id);
  }
  return {
    async subscribe(id: string, listener: Listener, oldest?: number) {
      retain(id);
      let view = views.get(id);
      if (!view) {
        view = new HistoryView(id, conversation, resolveHandoffs);
        views.set(id, view);
      }
      let delivered = false;
      const deliver: Listener = async (state) => {
        delivered = true;
        await listener(state);
      };
      view.listeners.add(deliver);
      try {
        await view.observe(oldest);
        if (!delivered) await deliver(view.state!);
      } catch (error) {
        view.listeners.delete(deliver);
        await view.detach();
        throw error;
      }
      const current = view;
      let detached = false;
      const closed = current.watch!.closed;
      const unsubscribe = async () => {
        if (detached) return;
        detached = true;
        current.listeners.delete(deliver);
        await current.detach();
        if (current.listeners.size !== 0) return;
        const timer = setTimeout(() => {
          if (current.listeners.size === 0 && views.get(id) === current) views.delete(id);
          expiry.delete(id);
        }, 30 * 60_000);
        timer.unref();
        expiry.set(id, timer);
      };
      return { unsubscribe, closed };
    },
    load: (id: string, gap?: { after: number; upTo: number }) => views.get(id)?.load(gap),
  };
}
