const MAX_SLUG_WORDS = 48;

/**
 * Readable URL fragment for a saved title. Display titles change; slugs are
 * assigned once and retained, so an existing link keeps working.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_WORDS)
    .replace(/-+$/g, "");
}

/** A slug is read back by its numeric prefix, so later title edits stay valid. */
export function idFromSlug(value: string | undefined): string | undefined {
  const match = /^([1-9]\d*)(?:$|-)/.exec(value ?? "");
  if (!match) return undefined;
  const id = match[1]!;
  return Number.isSafeInteger(Number(id)) ? id : undefined;
}

export function slugaWithId(id: number | string, title: string, fallback: string): string {
  return `${id}-${slugify(title) || fallback}`;
}
