/** Only fresh, explicitly submitted input is parsed; callers must not parse restored drafts. */
export function parseDirectShell(
  text: string,
  composing = false,
): { command: string; includeInContext: boolean } | undefined {
  if (composing || !text.startsWith("!")) return undefined;
  const excluded = text.startsWith("!!");
  const command = text.slice(excluded ? 2 : 1).trim();
  return command ? { command, includeInContext: !excluded } : undefined;
}
