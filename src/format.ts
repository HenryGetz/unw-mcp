/**
 * Output formatting for tool results.
 *
 * Rules enforced here:
 *  - never emit upstream envelopes;
 *  - drop null/undefined instead of spelling them out;
 *  - collapse HTML to text and truncate long strings;
 *  - stable key order so repeated calls diff cleanly.
 */

export const DEFAULT_PREVIEW_LENGTH = 300;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Recursively remove null/undefined object members (array nulls are filtered). */
export function omitNullish<T>(value: T): T {
  if (Array.isArray(value)) {
    const mapped = value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => omitNullish(item));
    return mapped as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null || item === undefined) continue;
      out[key] = omitNullish(item);
    }
    return out as T;
  }
  return value;
}

/** Collapse all whitespace runs to single spaces, then cut to `max` characters. */
export function truncate(value: string | null | undefined, max = DEFAULT_PREVIEW_LENGTH): string {
  if (value === null || value === undefined) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Cut to `max` characters without flattening the text (page/article bodies). */
export function cutText(value: string | null | undefined, max: number): string {
  if (value === null || value === undefined) return "";
  if (max <= 0) return "";
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** ISO 8601 string for a Date, epoch ms or already-ISO string; undefined when unusable. */
export function isoTime(value: Date | number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date =
    typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** JSON with recursively sorted keys, so output is byte-stable for identical data. */
export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortKeys(value), null, space);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Text payload for a tool result: compact, null-free, key-stable JSON. */
export function toJsonText(value: unknown, space = 0): string {
  return stableStringify(omitNullish(value), space);
}

/** One-line error text: `code: message (hint)`, newlines flattened. */
export function errorText(code: string, message: string, hint?: string): string {
  const flat = `${code}: ${message.replace(/\s+/g, " ").trim()}`;
  return hint ? `${flat} (${hint.replace(/\s+/g, " ").trim()})` : flat;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Plain-text rendering of an HTML fragment.
 *
 * Block-level tags become line/space breaks before tags are stripped, so lists
 * and paragraphs do not run together; scripts/styles are dropped entirely.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const withoutNoise = html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const spaced = withoutNoise
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(spaced)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Compact one-paragraph preview from an HTML or plain-text body. */
export function previewFromBody(body: string | null | undefined, max = DEFAULT_PREVIEW_LENGTH): string {
  return truncate(htmlToText(body), max);
}
