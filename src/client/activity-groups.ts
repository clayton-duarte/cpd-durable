import type { ThreadMessage } from "@assistant-ui/react";

// View-only grouping. Keep canonical messages and their native runtime scopes intact.
export function isActivityMessage(message: ThreadMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.metadata.custom["historyMarker"] &&
    message.content.length > 0 &&
    message.content.some((part) => part.type === "tool-call" || part.type === "reasoning") &&
    message.content.every(
      (part) =>
        part.type === "tool-call" ||
        part.type === "reasoning" ||
        (part.type === "text" && part.text.trim() === ""),
    )
  );
}

export function activityGroups(messages: readonly ThreadMessage[]) {
  const groups: { id: string; activity: boolean; indices: number[] }[] = [];
  messages.forEach((message, index) => {
    const activity = isActivityMessage(message);
    const previous = groups.at(-1);
    // Failed/interrupted rows stay outside the disclosure so their status is never hidden.
    const safe = activity && message.status?.type !== "incomplete";
    if (safe && previous?.activity) previous.indices.push(index);
    else groups.push({ id: message.id, activity: safe, indices: [index] });
  });
  return groups;
}
