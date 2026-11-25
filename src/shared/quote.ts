import { z } from "zod";

export const QuoteTextSchema = z.string().trim().min(1).max(4_000);

/** Keep the quote in the durable input, not just the browser's composer metadata. */
export function quotedReply(text: string, quote: string): string {
  return `${quote
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n")}\n\n${text}`;
}

export function splitQuotedReply(text: string): { quote: string; reply: string } | undefined {
  const split = text.indexOf("\n\n");
  if (split < 0) return undefined;
  const lines = text.slice(0, split).split("\n");
  if (!lines.every((line) => line.startsWith("> "))) return undefined;
  const quote = lines.map((line) => line.slice(2)).join("\n");
  const reply = text.slice(split + 2);
  return reply && QuoteTextSchema.safeParse(quote).success ? { quote, reply } : undefined;
}
