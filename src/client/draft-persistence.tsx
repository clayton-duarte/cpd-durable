import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { DraftViewSchema, type DraftView } from "../shared/drafts.ts";

type Props = {
  runtime: AssistantRuntime;
  chatId: string | undefined;
  enabled: boolean;
  readOnly?: boolean;
  /** Include edits that have begun but have not yet appeared in composer state, such as uploads. */
  localRevision?: () => number;
};
type Conflict = { saved: DraftView; chatId: string };

/** Restoration only. The native composer remains the sole owner of editable draft content. */
export function useDraftRestoration({ runtime, chatId, enabled, readOnly, localRevision }: Props) {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  const allowed = useRef(enabled && !readOnly);
  allowed.current = enabled && !readOnly;
  const restoreRef = useRef<((saved: DraftView, replace: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    const token = ++epoch.current;
    setConflict(null);
    setError(null);
    if (!enabled || readOnly || !chatId || !/^[1-9]\d*$/.test(chatId)) return;
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
      )
        setConflict(null);
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
        if (!saved.content.text && !saved.content.images.length) return;
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
  const keepMine = useCallback(() => setConflict(null), []);
  return { conflict: conflict?.chatId === chatId, error, useSaved, keepMine };
}
