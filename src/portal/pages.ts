/**
 * Portal content pages: search and slug lookup.
 *
 * Bodies are HTML in `body_html` and/or text/markdown in `body`. Output is
 * plain text, capped at 4,000 characters, with `body_truncated` and
 * `body_chars` telling the caller what happened.
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import { PortalUnavailableError } from "../auth/session.js";
import { cutText, htmlToText, truncate } from "../format.js";
import { dict, list, numeric, text } from "./values.js";
import type { PortalReader } from "./client.js";

export interface PageDeps {
  portal: PortalReader;
  cfg: ResolvedConfig;
  cache: TtlCache;
}

export interface PageSearchRow {
  slug?: string;
  title?: string;
  category?: string;
  excerpt?: string;
}

export interface PageSearchResult {
  query: string;
  count: number;
  truncated: boolean;
  items: PageSearchRow[];
}

export interface PageDocument {
  status: "ok";
  slug: string;
  title?: string;
  category?: string;
  updated?: string;
  body: string;
  body_chars: number;
  body_truncated: boolean;
}

export interface PageNotFound {
  status: "not_found";
  slug: string;
}

function categoryOf(value: unknown): string | undefined {
  return text(value) ?? text(dict(value).name) ?? text(dict(value).title);
}

function pageBody(raw: unknown): string {
  const page = dict(raw);
  const direct = text(page.body);
  if (direct) return direct.includes("<") ? htmlToText(direct) : direct;
  return htmlToText(text(page.body_html));
}

export function projectPageSearchRow(raw: unknown, excerptChars: number): PageSearchRow | undefined {
  const page = dict(raw);
  const slug = text(page.slug) ?? text(page.slug_name);
  const title = text(page.title) ?? text(page.name);
  if (!slug && !title) return undefined;
  const body = pageBody(page);
  const excerpt = text(page.excerpt) ?? text(page.summary) ?? truncate(body, excerptChars);
  const category = categoryOf(page.category);
  return {
    ...(slug ? { slug } : {}),
    ...(title ? { title } : {}),
    ...(category ? { category } : {}),
    ...(excerpt ? { excerpt: truncate(htmlToText(excerpt), excerptChars) } : {}),
  };
}

export function projectPageDocument(raw: unknown, maxChars: number): PageDocument | undefined {
  const page = dict(raw);
  const slug = text(page.slug) ?? text(page.slug_name);
  if (!slug) return undefined;
  const full = pageBody(page);
  const body = cutText(full, maxChars);
  return {
    status: "ok",
    slug,
    ...(text(page.title) ?? text(page.name) ? { title: text(page.title) ?? text(page.name) } : {}),
    ...(categoryOf(page.category) ? { category: categoryOf(page.category) } : {}),
    ...(text(page.updated_at) ?? text(page.modified_at) ?? text(page.updated)
      ? { updated: text(page.updated_at) ?? text(page.modified_at) ?? text(page.updated) }
      : {}),
    body,
    body_chars: full.length,
    body_truncated: full.length > body.length,
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Rank exact title/slug hits first, then prefix and token matches. Upstream
 * order is the tie-break so equal matches stay stable.
 */
function searchScore(row: PageSearchRow, query: string): number {
  const normalized = normalizeSearchText(query);
  const slugQuery = normalized.replace(/\s+/g, "-");
  const title = normalizeSearchText(row.title ?? "");
  const slug = normalizeSearchText(row.slug ?? "");
  const rawSlug = (row.slug ?? "").toLowerCase();
  if (title === normalized || slug === normalized || rawSlug === slugQuery) return 0;
  if (title.startsWith(normalized) || slug.startsWith(normalized)) return 1;
  const tokens = normalized.split(" ").filter((token) => token.length > 1);
  const haystack = `${title} ${slug}`;
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return 2;
  if (tokens[0] && title.startsWith(tokens[0])) return 2;
  if (tokens.some((token) => haystack.includes(token))) return 3;
  return 4;
}

export async function loadPageSearch(
  deps: PageDeps,
  query: string,
  limit: number,
  excerptChars = 120,
): Promise<PageSearchResult> {
  const clean = query.trim();
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 25);
  const excerpt = Math.min(Math.max(40, Math.trunc(excerptChars)), 400);
  const key = `pages:search:${clean.toLowerCase()}:${capped}:${excerpt}`;
  return deps.cache.get(key, deps.cfg.cache.pageSearchTtlSeconds, async () => {
    // Fetch a wider page than requested so ranking can promote an exact slug
    // that upstream returned late.
    const params = new URLSearchParams();
    params.set("search", clean);
    params.set("limit", "25");
    params.set("offset", "0");
    const body = await deps.portal.getPortalJson<unknown>(`/api/v1/pages/?${params.toString()}`);
    const rows = Array.isArray(body) ? body : list(dict(body).results);
    const seen = new Set<string>();
    const candidates: PageSearchRow[] = [];
    for (const entry of rows) {
      const row = projectPageSearchRow(entry, excerpt);
      if (!row) continue;
      const keyText = row.slug ?? row.title ?? "";
      if (seen.has(keyText)) continue;
      seen.add(keyText);
      candidates.push(row);
    }
    const ranked = candidates
      .map((row, index) => ({ row, index, score: searchScore(row, clean) }))
      .sort(
        (a, b) =>
          a.score - b.score ||
          (a.row.title?.length ?? 999) - (b.row.title?.length ?? 999) ||
          a.index - b.index,
      )
      .slice(0, capped)
      .map((entry) => entry.row);
    const total = numeric(dict(body).count) ?? candidates.length;
    return {
      query: clean,
      count: total,
      truncated: total > ranked.length,
      items: ranked,
    };
  });
}

export async function loadPage(deps: PageDeps, slug: string): Promise<PageDocument | PageNotFound> {
  const clean = slug.trim();
  const key = `pages:get:${clean.toLowerCase()}`;
  try {
    return await deps.cache.get(key, deps.cfg.cache.pagesTtlSeconds, async () => {
      const raw = await deps.portal.getPortalJson<unknown>(
        `/api/v1/pages/slug/${encodeURIComponent(clean)}/`,
      );
      const document = projectPageDocument(raw, deps.cfg.maxResults.pageBodyChars);
      if (!document) {
        throw new PortalUnavailableError("page payload has no slug", "the page shape may have changed");
      }
      return document;
    });
  } catch (error) {
    if (error instanceof PortalUnavailableError && /HTTP 404/.test(error.message)) {
      return { status: "not_found", slug: clean };
    }
    throw error;
  }
}
