"use client";

import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

// Clipboard API access depends on secure-context/browser policy. Retain a
// user-gesture fallback for local HTTP previews and browsers that reject it.
function copyWithSelection(value: string): boolean {
  if (typeof document === "undefined") return false;
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const inputSelection =
    focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
      ? {
          start: focused.selectionStart,
          end: focused.selectionEnd,
          direction: focused.selectionDirection,
        }
      : undefined;
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;font-size:16px";
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
    if (focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
    if (
      inputSelection &&
      (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)
    ) {
      try {
        focused.setSelectionRange(
          inputSelection.start,
          inputSelection.end,
          inputSelection.direction ?? undefined,
        );
      } catch {
        /* Not all input types support selection. */
      }
    }
  }
}

export async function writeClipboardText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Try the selection-based path before reporting failure.
  }
  return copyWithSelection(value);
}

export const useCopyToClipboard = ({ copiedDuration = 3000 }: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scopeGenerationRef = useRef(0);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      scopeGenerationRef.current += 1;
      clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyToClipboard = async (value: string) => {
    const generation = scopeGenerationRef.current;
    const request = ++requestRef.current;
    clearTimeout(copiedTimerRef.current);
    setIsCopied(false);
    setCopyError(null);
    const copied = await writeClipboardText(value);
    if (generation !== scopeGenerationRef.current || request !== requestRef.current) return;
    if (!copied) {
      setCopyError("Could not copy. Select the text and copy it manually.");
      return;
    }
    setIsCopied(true);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined;
      setIsCopied(false);
    }, copiedDuration);
  };

  return { isCopied, copyError, copyToClipboard };
};
