/**
 * Academic calendar (public Google ICS) and campus events (portal).
 *
 * The university page embeds three public Google Calendars. Their ICS feeds are
 * the cleanest machine source for semester dates, breaks and deadlines; they
 * need no session. The parsed dataset is cached for 6 hours. Campus events come
 * from the authenticated portal and keep their 5-minute cache.
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import { PortalUnavailableError } from "../auth/session.js";
import { localDate } from "../time.js";
import type { PortalReader } from "./client.js";
import { loadEvents, type EventsResult } from "./dashboard.js";
import type { FetchLike } from "./dining.js";

export const CALENDAR_PAGE = "https://www.unwsp.edu/academics/academic-calendar/";

export interface CalendarDeps {
  portal: PortalReader;
  cfg: ResolvedConfig;
  cache: TtlCache;
  now?: () => Date;
  fetch?: FetchLike;
}

export interface AcademicEvent {
  uid?: string;
  date: string;
  end_date?: string;
  summary: string;
  location?: string;
  all_day: boolean;
  /** Cohort prefixes merged from the three feeds (TRAD, DE, AGS). */
  audiences?: string[];
}

export interface AcademicDataset {
  fetched_at: string;
  feed_count: number;
  event_count: number;
  events: AcademicEvent[];
}

export type CalendarKind = "academic" | "breaks" | "deadlines";

const BREAK = /break|recess|holiday|no classes|thanksgiving|easter|christmas/i;
const DEADLINE = /deadline|withdraw|registration|last day|due|petition|application|advising/i;
const ACADEMIC =
  /semester|classes|final|exam|commencement|term|quad|break|recess|holiday|no classes|registration|advising/i;

export function matchesCalendarKind(summary: string, kind: CalendarKind): boolean {
  if (kind === "breaks") return BREAK.test(summary);
  if (kind === "deadlines") return DEADLINE.test(summary);
  return ACADEMIC.test(summary);
}

function decodeEntities(html: string): string {
  return html
    .replace(/&#0?38;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/** Extract Google Calendar IDs from the academic-calendar page or its embed. */
export function discoverFeedIds(html: string): string[] {
  const decoded = decodeEntities(html);
  const ids = new Set<string>();
  const add = (value: string): void => {
    const id = decodeURIComponent(value.trim());
    if (/@group\.calendar\.google\.com$/i.test(id)) ids.add(id);
  };
  for (const match of decoded.matchAll(/calendar\.google\.com\/calendar\/ical\/([^/"'?<>\s]+)\/public\/basic\.ics/gi)) {
    add(match[1] ?? "");
  }
  for (const match of decoded.matchAll(/src=([^&"'>\s]+%40group\.calendar\.google\.com)/gi)) {
    add(match[1] ?? "");
  }
  for (const match of decoded.matchAll(/src=([^&"'>\s]+@group\.calendar\.google\.com)/gi)) {
    add(match[1] ?? "");
  }
  for (const match of decoded.matchAll(/[?&]cid=([^&"'>\s]+)/gi)) {
    add(match[1] ?? "");
  }
  return [...ids];
}

export function feedUrl(id: string): string {
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseDateValue(value: string): { date: string; allDay: boolean } | undefined {
  const clean = value.trim();
  const digits = /^(\d{8})/.exec(clean)?.[1];
  if (!digits) return undefined;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return { date, allDay: !/T\d{4,6}/.test(clean) };
}

function previousDate(date: string): string {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(parsed) ? date : new Date(parsed - 86_400_000).toISOString().slice(0, 10);
}

/** Parse VEVENT blocks, including folded lines and VALUE=DATE/TZID forms. */
export function parseIcs(text: string): AcademicEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events: AcademicEvent[] = [];
  let current: Record<string, string> | undefined;

  for (const rawLine of unfolded.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const start = current.DTSTART ? parseDateValue(current.DTSTART) : undefined;
        const summary = current.SUMMARY ? unescapeIcs(current.SUMMARY) : "";
        if (start && summary) {
          const end = current.DTEND ? parseDateValue(current.DTEND) : undefined;
          let endDate: string | undefined;
          if (end && end.date > start.date) {
            const candidate = start.allDay && end.allDay ? previousDate(end.date) : end.date;
            if (candidate > start.date) endDate = candidate;
          }
          events.push({
            ...(current.UID ? { uid: unescapeIcs(current.UID) } : {}),
            date: start.date,
            ...(endDate ? { end_date: endDate } : {}),
            summary,
            ...(current.LOCATION ? { location: unescapeIcs(current.LOCATION) } : {}),
            all_day: start.allDay,
          });
        }
      }
      current = undefined;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).split(";")[0]?.toUpperCase();
    if (!name || current[name] !== undefined) continue;
    current[name] = line.slice(colon + 1);
  }
  return events;
}

const AUDIENCE = /^(TRAD|DE|AGS|Dual Enrollment|Adult & Graduate(?: Studies)?)\s*:\s*/i;

/** Split a feed prefix (`TRAD:`, `DE:`, `AGS:`) from the event title. */
export function splitAudience(summary: string): { text: string; audience?: string } {
  const match = AUDIENCE.exec(summary);
  if (!match) return { text: summary.trim() };
  return { text: summary.slice(match[0].length).trim(), audience: match[1]!.toUpperCase() };
}

/**
 * Merge the same event across feeds. The three calendars share dates but prefix
 * titles with their cohort; one row with `audiences` is more useful than three
 * near-duplicates.
 */
function dedupeEvents(events: AcademicEvent[]): AcademicEvent[] {
  const merged = new Map<string, AcademicEvent>();
  for (const event of events) {
    const { text: summary, audience } = splitAudience(event.summary);
    const key = `${event.date}|${event.end_date ?? ""}|${summary}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...event,
        summary,
        ...(audience ? { audiences: [audience] } : {}),
      });
      continue;
    }
    if (audience && !existing.audiences?.includes(audience)) {
      existing.audiences = [...(existing.audiences ?? []), audience];
    }
    if (!existing.location && event.location) existing.location = event.location;
  }
  return [...merged.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary),
  );
}

export function buildAcademicDataset(
  feeds: Array<{ id: string; events: AcademicEvent[] }>,
  now: Date,
): AcademicDataset {
  const events = dedupeEvents(feeds.flatMap((feed) => feed.events));
  return {
    fetched_at: now.toISOString(),
    feed_count: feeds.length,
    event_count: events.length,
    events,
  };
}

async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  accept: string,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, "User-Agent": "unw-mcp/0.1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function loadAcademicDataset(deps: CalendarDeps): Promise<AcademicDataset> {
  return deps.cache.get("calendar:academic", deps.cfg.cache.academicCalendarTtlSeconds, async () => {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const now = deps.now ? deps.now() : new Date();
    let page: string;
    try {
      page = await fetchText(
        fetchImpl,
        CALENDAR_PAGE,
        deps.cfg.requestTimeoutMs,
        "text/html,application/xhtml+xml",
      );
    } catch (error) {
      throw new PortalUnavailableError(
        `academic calendar page could not be fetched (${(error as Error).message.slice(0, 120)})`,
        "retry later; the public calendar page may be down",
      );
    }
    const ids = discoverFeedIds(page);
    if (ids.length === 0) {
      throw new PortalUnavailableError(
        "no public Google Calendar feeds were found on the academic-calendar page",
        "the page layout may have changed; report it instead of guessing dates",
      );
    }
    const settled = await Promise.allSettled(
      ids.map(async (id) => ({
        id,
        events: parseIcs(
          await fetchText(fetchImpl, feedUrl(id), deps.cfg.requestTimeoutMs, "text/calendar"),
        ),
      })),
    );
    const feeds = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (feeds.length === 0) {
      throw new PortalUnavailableError(
        "all public academic-calendar feeds failed",
        "retry later; the Google Calendar feeds may be unavailable",
      );
    }
    return buildAcademicDataset(feeds, now);
  });
}

export interface CalendarRowsResult {
  kind: CalendarKind;
  window: { from: string; to: string; days: number };
  count: number;
  items: Array<Pick<AcademicEvent, "date" | "end_date" | "summary" | "location">>;
}

function shiftDate(date: string, days: number): string {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(parsed) ? date : new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export async function loadAcademicRows(
  deps: CalendarDeps,
  kind: CalendarKind,
  options: { days?: number; limit?: number; query?: string } = {},
): Promise<CalendarRowsResult> {
  const dataset = await loadAcademicDataset(deps);
  const now = deps.now ? deps.now() : new Date();
  const from = localDate(now, deps.cfg.timezone);
  const days = Math.min(Math.max(0, Math.trunc(options.days ?? 365)), 730);
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? deps.cfg.maxResults.calendar)),
    50,
  );
  const to = shiftDate(from, days);
  const needle = options.query?.trim().toLowerCase();
  const rows = dataset.events
    .filter((event) => event.date >= from && event.date <= to)
    .filter((event) => matchesCalendarKind(event.summary, kind))
    .filter((event) => !needle || event.summary.toLowerCase().includes(needle))
    .sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary))
    .slice(0, limit)
    .map((event) => ({
      date: event.date,
      ...(event.end_date ? { end_date: event.end_date } : {}),
      summary: event.summary,
      ...(event.location ? { location: event.location } : {}),
      ...(event.audiences && event.audiences.length > 0 ? { audiences: event.audiences } : {}),
    }));
  return { kind, window: { from, to, days }, count: rows.length, items: rows };
}

export function loadCampusEvents(
  deps: CalendarDeps,
  options: { days?: number; limit?: number } = {},
): Promise<EventsResult> {
  return loadEvents(
    {
      portal: deps.portal,
      cfg: deps.cfg,
      cache: deps.cache,
      ...(deps.now ? { now: deps.now } : {}),
    },
    options,
  );
}
