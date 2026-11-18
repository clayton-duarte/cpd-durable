import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import type { SendMode } from "../shared/chat.ts";
import {
  DraftAttemptRecoveryPageSchema,
  DraftAttemptRecordSchema,
  DraftContentSchema,
  DraftViewSchema,
  type DraftAttemptRecoveryPage,
  type DraftView,
} from "../shared/drafts.ts";

type Props = {
  runtime: AssistantRuntime;
  chatId: string | undefined;
  enabled: boolean;
  readOnly?: boolean;
  /** Include edits that have begun but have not yet appeared in composer state, such as uploads. */
  localRevision?: () => number;
  onResolved?: (saved: DraftView, choice: "initial" | "saved" | "mine") => void;
};
type Conflict = { saved: DraftView; chatId: string };

/** Restoration only. The native composer remains the sole owner of editable draft content. */
export function useDraftRestoration({
  runtime,
  chatId,
  enabled,
  readOnly,
  localRevision,
  onResolved,
}: Props) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  const allowed = useRef(enabled && !readOnly);
  allowed.current = enabled;
  const restoreRef = useRef<((saved: DraftView, replace: boolean) => Promise<void>) | null>(null);
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  useEffect(() => {
    const token = ++epoch.current;
    setConflict(null);
    setError(null);
    if (!enabled || !chatId || !/^[1-9]\d*$/.test(chatId)) return;
    const controller = new AbortController();
    const composer = runtime.thread.composer;
    let generation = 0;
    let ownChange: string | undefined;
    const fingerprint = () => {
      const state = composer.getState();
      return JSON.stringify([state.text, state.attachments.map((item) => item.id)]);
    };
    let last = fingerprint();
    const unsubscribe = composer.subscribe(() => {
      const next = fingerprint();
      if (last === next) return;
      last = next;
      if (ownChange === next) ownChange = undefined;
      else generation++;
    });
    const active = () =>
      !controller.signal.aborted &&
      epoch.current === token &&
      currentChat.current === chatId &&
      allowed.current;
    const isEmpty = () => {
      const state = composer.getState();
      return state.text === "" && state.attachments.length === 0;
    };
    const restore = async (saved: DraftView, replace: boolean) => {
      if (!active()) return;
      const startGeneration = generation;
      let startLocal = localRevision?.();
      const acceptOwnRevision = () => {
        const now = localRevision?.();
        if (
          now !== undefined &&
          startLocal !== undefined &&
          (now < startLocal || now > startLocal + 1)
        )
          return false;
        startLocal = now;
        return true;
      };
      if (replace && !isEmpty()) {
        const current = composer.getState();
        if (current.text) {
          ownChange = JSON.stringify(["", current.attachments.map((item) => item.id)]);
          composer.setText("");
          ownChange = undefined;
          if (!active() || generation !== startGeneration || !acceptOwnRevision()) return;
        }
        if (composer.getState().attachments.length) {
          ownChange = JSON.stringify(["", []]);
          const clearing = composer.clearAttachments();
          ownChange = undefined;
          if (!active() || generation !== startGeneration || !acceptOwnRevision()) return;
          await clearing;
          if (
            !active() ||
            generation !== startGeneration ||
            localRevision?.() !== startLocal ||
            !isEmpty()
          )
            return;
        }
      }
      if (!isEmpty()) return;
      const inserted: string[] = [];
      for (const image of saved.content.images) {
        if (
          !active() ||
          generation !== startGeneration ||
          localRevision?.() !== startLocal ||
          fingerprint() !== JSON.stringify(["", inserted])
        )
          return;
        const expected = [...inserted, image.id];
        ownChange = JSON.stringify(["", expected]);
        const pending = composer.addAttachment({
          id: image.id,
          name: image.name,
          type: "image",
          contentType: image.mimeType,
          content: [{ type: "image", image: `/api/chats/${chatId}/attachments/${image.id}` }],
        });
        ownChange = undefined;
        inserted.push(image.id);
        if (
          !active() ||
          generation !== startGeneration ||
          !acceptOwnRevision() ||
          fingerprint() !== JSON.stringify(["", inserted])
        )
          return;
        await pending;
        if (
          !active() ||
          generation !== startGeneration ||
          localRevision?.() !== startLocal ||
          fingerprint() !== JSON.stringify(["", inserted])
        )
          return;
      }
      if (
        !active() ||
        generation !== startGeneration ||
        localRevision?.() !== startLocal ||
        fingerprint() !== JSON.stringify(["", inserted])
      )
        return;
      ownChange = JSON.stringify([saved.content.text, inserted]);
      composer.setText(saved.content.text);
      ownChange = undefined;
      if (
        active() &&
        generation === startGeneration &&
        acceptOwnRevision() &&
        fingerprint() === JSON.stringify([saved.content.text, inserted])
      ) {
        setConflict(null);
        resolvedRef.current?.(saved, replace ? "saved" : "initial");
      }
    };
    restoreRef.current = restore;
    const initialGeneration = generation;
    const initialLocal = localRevision?.();
    void (async () => {
      try {
        const response = await fetch(`/api/chats/${chatId}/draft`, { signal: controller.signal });
        if (!response.ok) throw new Error("Draft unavailable");
        const saved = DraftViewSchema.parse((await response.json()) as unknown);
        if (!active()) return;
        if (!saved.content.text && !saved.content.images.length) {
          resolvedRef.current?.(saved, "initial");
          return;
        }
        if (
          generation === initialGeneration &&
          localRevision?.() === initialLocal &&
          fingerprint() ===
            JSON.stringify([saved.content.text, saved.content.images.map((image) => image.id)])
        ) {
          resolvedRef.current?.(saved, "initial");
          return;
        }
        if (generation !== initialGeneration || localRevision?.() !== initialLocal || !isEmpty()) {
          setConflict({ saved, chatId });
          return;
        }
        await restore(saved, false);
        if (
          active() &&
          fingerprint() !==
            JSON.stringify([saved.content.text, saved.content.images.map((image) => image.id)])
        )
          setConflict({ saved, chatId });
      } catch {
        if (active()) setError("Saved draft could not be restored.");
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
      if (epoch.current === token) {
        epoch.current++;
        restoreRef.current = null;
      }
    };
  }, [runtime, chatId, enabled, readOnly, localRevision]);
  const useSaved = useCallback(async () => {
    if (!conflict || conflict.chatId !== chatId) return;
    try {
      await restoreRef.current?.(conflict.saved, true);
    } catch {
      if (currentChat.current === chatId && allowed.current)
        setError("Saved draft could not be restored.");
    }
  }, [conflict, chatId]);
  const keepMine = useCallback(() => {
    if (!conflict || conflict.chatId !== chatId) return;
    resolvedRef.current?.(conflict.saved, "mine");
    setConflict(null);
  }, [conflict, chatId]);
  const offerConflict = useCallback(
    (saved: DraftView) => {
      if (chatId && allowed.current) setConflict({ saved, chatId });
    },
    [chatId],
  );
  return { conflict: conflict?.chatId === chatId, error, useSaved, keepMine, offerConflict };
}

/** Read-only discovery: callers must offer explicit retry; reading never sends input. */
export function useDraftRecovery(chatId: string | undefined, enabled: boolean) {
  const [attempts, setAttempts] = useState<DraftAttemptRecoveryPage["attempts"]>([]);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string>();
  const loadMoreRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    setScope(chatId);
    setAttempts([]);
    setCapped(false);
    setError(null);
    if (!enabled || !chatId || !/^[1-9]\d*$/.test(chatId)) return;
    const controller = new AbortController();
    let cursor: string | null = null;
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      const requestedCursor = cursor;
      try {
        const query = requestedCursor ? `?cursor=${encodeURIComponent(requestedCursor)}` : "";
        const response = await fetch(`/api/chats/${chatId}/draft/attempts${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Recovery unavailable");
        const page = DraftAttemptRecoveryPageSchema.parse((await response.json()) as unknown);
        if (controller.signal.aborted) return;
        setAttempts((previous) =>
          requestedCursor ? [...previous, ...page.attempts] : page.attempts,
        );
        cursor = page.nextCursor;
        setCapped(page.capped);
        setError(null);
      } catch {
        if (!controller.signal.aborted) setError("Delivery recovery could not be loaded.");
      } finally {
        loading = false;
      }
    };
    loadMoreRef.current = load;
    void load();
    return () => {
      controller.abort();
      loadMoreRef.current = null;
    };
  }, [chatId, enabled]);
  const current = enabled && scope === chatId;
  return {
    attempts: current ? attempts : [],
    capped: current && capped,
    error: current ? error : null,
    loadMore: () => (current ? loadMoreRef.current?.() : undefined),
  };
}

/**
 * Serialized CAS writer for the native composer. Start only after restoration has
 * settled; the caller owns conflict presentation and send/ack coordination. This
 * is intentionally not mounted until the admission protocol is wired.
 */
export function createDraftAutosave(options: {
  runtime: AssistantRuntime;
  chatId: string;
  initial: DraftView;
  onConflict(saved: DraftView): void;
  onError(message: string): void;
}) {
  const composer = options.runtime.thread.composer;
  const metadata = new Map(options.initial.content.images.map((image) => [image.id, image]));
  const controller = new AbortController();
  let saved = DraftViewSchema.parse(options.initial);
  let stopped = false;
  let conflicted = false;
  let generation = 0;
  let sendPending = false;
  let preparing = false;
  let suppressDetachedEmpty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let last = "";

  const snapshot = () => {
    const state = composer.getState();
    const images = state.attachments.map((item) => {
      const known = metadata.get(item.id);
      const size = item.file?.size ?? known?.size;
      return { id: item.id, name: item.name, mimeType: item.contentType, size };
    });
    const parsed = DraftContentSchema.safeParse({ text: state.text, images });
    if (!parsed.success) return undefined;
    for (const image of parsed.data.images) metadata.set(image.id, image);
    return parsed.data;
  };
  const fingerprint = () => {
    const state = composer.getState();
    return JSON.stringify([
      state.text,
      state.attachments.map((item) => [item.id, item.name, item.contentType, item.file?.size]),
    ]);
  };
  const active = () => !stopped && !controller.signal.aborted;
  const schedule = () => {
    if (!active() || conflicted || preparing) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 250);
  };
  const flush = async (): Promise<void> => {
    if (!active() || conflicted || preparing) return;
    if (running) {
      await running;
      if (active() && !conflicted) schedule();
      return;
    }
    const content = snapshot();
    if (!content || (suppressDetachedEmpty && !content.text && !content.images.length)) return;
    if (JSON.stringify(content) === JSON.stringify(saved.content)) return;
    const started = generation;
    running = (async () => {
      try {
        const response = await fetch(`/api/chats/${options.chatId}/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: saved.revision, content }),
          signal: controller.signal,
        });
        if (response.status === 409) {
          const current = await fetch(`/api/chats/${options.chatId}/draft`, {
            signal: controller.signal,
          });
          if (!current.ok) throw new Error("Draft unavailable");
          const remote = DraftViewSchema.parse((await current.json()) as unknown);
          if (active()) {
            conflicted = true;
            options.onConflict(remote);
          }
          return;
        }
        if (!response.ok) throw new Error("Draft unavailable");
        const accepted = DraftViewSchema.parse((await response.json()) as unknown);
        if (!active()) return;
        saved = accepted;
        for (const image of accepted.content.images) metadata.set(image.id, image);
        if (generation !== started) schedule();
      } catch {
        if (active()) options.onError("Draft could not be saved.");
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };
  last = fingerprint();
  const unsubscribe = composer.subscribe(() => {
    const next = fingerprint();
    if (last === next) return;
    last = next;
    generation++;
    const content = snapshot();
    if (content && (content.text || content.images.length) && !sendPending)
      suppressDetachedEmpty = false;
    schedule();
  });
  return {
    flush,
    /**
     * Pin the original literal input across pending autosaves and edits. Only
     * metadata writes are paused; the native composer stays editable.
     */
    async prepareSend(text: string, images: string[], mode: SendMode, requestId: string) {
      if (!active() || conflicted || preparing) throw new Error("Draft is not ready to send.");
      // Capture available file metadata before any asynchronous work.
      snapshot();
      const content = DraftContentSchema.parse({
        text,
        images: images.map((id) => metadata.get(id)),
      });
      if (!text.trim() && !images.length) throw new Error("Draft is empty.");
      preparing = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      try {
        if (running) await running;
        if (!active() || conflicted) throw new Error("Draft changed in another session.");
        if (JSON.stringify(content) !== JSON.stringify(saved.content)) {
          const response = await fetch(`/api/chats/${options.chatId}/draft`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedRevision: saved.revision, content }),
            signal: controller.signal,
          });
          if (response.status === 409) {
            const current = await fetch(`/api/chats/${options.chatId}/draft`, {
              signal: controller.signal,
            });
            if (!current.ok) throw new Error("Draft unavailable");
            const remote = DraftViewSchema.parse((await current.json()) as unknown);
            if (active()) {
              conflicted = true;
              options.onConflict(remote);
            }
            throw new Error("Draft changed in another session.");
          }
          if (!response.ok) throw new Error("Draft could not be saved.");
          const accepted = DraftViewSchema.parse((await response.json()) as unknown);
          if (
            !active() ||
            accepted.revision !== saved.revision + 1 ||
            JSON.stringify(accepted.content) !== JSON.stringify(content)
          )
            throw new Error("Draft save could not be confirmed.");
          saved = accepted;
        }
        const draft = {
          revision: saved.revision,
          text,
          images: [...images],
          attempt: true as const,
        };
        const intent = {
          requestId,
          draftRevision: draft.revision,
          text,
          images: [...images],
          mode,
        };
        const response = await fetch(`/api/chats/${options.chatId}/draft/attempt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intent),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Draft attempt could not be confirmed.");
        const confirmed = DraftAttemptRecordSchema.parse((await response.json()) as unknown);
        if (
          !active() ||
          confirmed.requestId !== requestId ||
          confirmed.draftRevision !== draft.revision ||
          confirmed.text !== text ||
          confirmed.mode !== mode ||
          JSON.stringify(confirmed.images) !== JSON.stringify(images)
        )
          throw new Error("Draft attempt could not be confirmed.");
        return { requestId, draft };
      } finally {
        preparing = false;
        if (active() && !conflicted) schedule();
      }
    },
    /** Suppress only native-send's transient empty state, not later nonempty edits. */
    beginSend() {
      sendPending = true;
      suppressDetachedEmpty = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    endSend(serverDraft?: DraftView) {
      if (serverDraft) {
        saved = DraftViewSchema.parse(serverDraft);
        for (const image of saved.content.images) metadata.set(image.id, image);
      }
      sendPending = false;
      const content = snapshot();
      // A detached empty composer isn't permission to clear the server draft.
      if (content && (content.text || content.images.length)) {
        suppressDetachedEmpty = false;
        schedule();
      }
    },
    /** Adopt only the clear confirmed by the same SDK admission transaction. */
    acknowledgeClear(
      original: { revision: number; text: string; images: string[] },
      revision: number,
    ) {
      if (
        active() &&
        revision === original.revision + 1 &&
        saved.revision === original.revision &&
        saved.content.text === original.text &&
        JSON.stringify(saved.content.images.map((image) => image.id)) ===
          JSON.stringify(original.images)
      )
        saved = { revision, content: { text: "", images: [] } };
    },
    /** Called only after an explicit conflict choice, with the fetched revision. */
    keepMine(remote: DraftView) {
      saved = DraftViewSchema.parse(remote);
      for (const image of saved.content.images) metadata.set(image.id, image);
      conflicted = false;
      schedule();
    },
    /** Call after the native composer has successfully restored the chosen server draft. */
    useSaved(remote: DraftView) {
      saved = DraftViewSchema.parse(remote);
      for (const image of saved.content.images) metadata.set(image.id, image);
      conflicted = false;
      last = fingerprint();
    },
    stop() {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}
