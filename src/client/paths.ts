/** Registered route paths, shared so navigation does not depend on a match. */
export const CHATS_PATH = "/chats/{-$chatId}" as const;
export const THREADS_PATH = "/chats/{-$chatId}/threads/{-$threadSlug}" as const;
