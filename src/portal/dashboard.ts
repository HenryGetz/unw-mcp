/**
 * Dashboard, announcement, task, event and quick-link projections.
 *
 * Every function returns 5–12 compact fields per row. Upstream Pathify objects
 * are large and carry internal flags, so they never leave this module: HTML is
 * collapsed, dates are rendered in the configured zone, and counts are explicit.
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import { htmlToText, truncate } from "../format.js";
import { formatLocal, localDate } from "../time.js";
import type { PortalReader } from "./client.js";
import { bool, dict, list, numeric, text } from "./values.js";

export interface DashboardDeps {
  portal: PortalReader;
  cfg: ResolvedConfig;
  cache: TtlCache;
  now?: () => Date;
}

function nowOf(deps: DashboardDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function preview(value: unknown, max: number): string | undefined {
  const plain = htmlToText(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  return plain === "" ? undefined : truncate(plain, max);
}

export interface ProgramRow {
  name?: string;
  progress?: number;
}

export interface AdvisorRow {
  name?: string;
  email?: string;
}

export interface ProfileRow {
  name?: string;
  email?: string;
  role?: string;
  roles?: string[];
  programs?: ProgramRow[];
  advisors?: AdvisorRow[];
  hold?: string;
}

/** Portal identity, degree progress, advisors and hold text. */
export function projectProfile(raw: unknown): ProfileRow {
  const profile = dict(raw);
  const extra = dict(profile.extra_data);
  const roles = list(profile.roles)
    .map((role) => text(role))
    .filter((role): role is string => role !== undefined);
  const studentRole = roles.find((role) => /^Student - /.test(role)) ?? roles.find((role) => /Student/.test(role));
  const programs: ProgramRow[] = list(extra.degree).flatMap((entry) => {
    const degree = dict(entry);
    const name = text(degree.name);
    const progress = numeric(degree.progress);
    return name ? [{ name, ...(progress !== undefined ? { progress } : {}) }] : [];
  });
  const advisors: AdvisorRow[] = list(profile.advisors).flatMap((entry) => {
    const advisor = dict(entry);
    const name = text(advisor.name);
    const email = text(advisor.email);
    return name ? [{ name, ...(email ? { email } : {}) }] : [];
  });
  const hold = text(extra.student_hold);
  return {
    ...(text(profile.name) ? { name: text(profile.name) } : {}),
    ...(text(profile.email) ? { email: text(profile.email) } : {}),
    ...(studentRole ? { role: studentRole.replace(/^Student - /, "") } : {}),
    ...(roles.length > 0 ? { roles } : {}),
    ...(programs.length > 0 ? { programs } : {}),
    ...(advisors.length > 0 ? { advisors } : {}),
    ...(hold ? { hold } : {}),
  };
}

export interface NoticeRow {
  id?: number;
  type?: string;
  title?: string;
  preview?: string;
  starts?: string;
  ends?: string;
  requires_ack?: boolean;
}

export function projectNotice(raw: unknown, previewChars: number): NoticeRow | undefined {
  const notice = dict(raw);
  const title = text(notice.title);
  if (!title) return undefined;
  const body = text(notice.text) ?? text(notice.text_html);
  return {
    ...(numeric(notice.id) !== undefined ? { id: numeric(notice.id) } : {}),
    ...(text(notice.notice_type) ? { type: text(notice.notice_type) } : {}),
    title,
    ...(preview(body, previewChars) ? { preview: preview(body, previewChars) } : {}),
    ...(text(notice.start_date) ? { starts: text(notice.start_date) } : {}),
    ...(text(notice.end_date) ? { ends: text(notice.end_date) } : {}),
    ...(bool(notice.require_acknowledgment) !== undefined
      ? { requires_ack: bool(notice.require_acknowledgment) }
      : {}),
  };
}

export interface TaskRow {
  id?: string;
  title?: string;
  detail?: string;
  due?: string;
  required?: boolean;
  complete?: boolean;
  link?: string;
}

export function projectTask(raw: unknown, previewChars: number): TaskRow | undefined {
  const task = dict(raw);
  const title = text(task.title);
  if (!title) return undefined;
  const id = text(task.id);
  const due = text(task.due);
  return {
    ...(id ? { id } : {}),
    title,
    ...(preview(task.text, previewChars) ? { detail: preview(task.text, previewChars) } : {}),
    ...(due ? { due } : {}),
    ...(bool(task.is_required) !== undefined ? { required: bool(task.is_required) } : {}),
    ...(bool(task.is_complete) !== undefined ? { complete: bool(task.is_complete) } : {}),
    ...(text(task.link) ? { link: text(task.link) } : {}),
  };
}

export interface EventRow {
  id?: number;
  title?: string;
  start?: string;
  end?: string;
  local?: string;
  all_day?: boolean;
  location?: string;
  calendar?: string;
}

/** All-day events are stored as UTC midnight; label them by their calendar date. */
function eventLocal(
  row: { start: string; end?: string; allDay?: boolean },
  timezone: string,
): string {
  if (row.allDay) return `${row.start.slice(0, 10)} (all day)`;
  const start = formatLocal(row.start, timezone);
  return row.end ? `${start} → ${formatLocal(row.end, timezone)}` : start;
}

export function projectEvent(raw: unknown, timezone: string): EventRow | undefined {
  const event = dict(raw);
  const title = text(event.title);
  const start = text(event.start_date);
  if (!title || !start) return undefined;
  const end = text(event.end_date);
  const allDay = bool(event.all_day);
  const calendar = dict(event.calendar);
  const location = text(event.location);
  return {
    ...(numeric(event.id) !== undefined ? { id: numeric(event.id) } : {}),
    title,
    start,
    ...(end ? { end } : {}),
    local: eventLocal({ start, ...(end ? { end } : {}), ...(allDay !== undefined ? { allDay } : {}) }, timezone),
    ...(allDay !== undefined ? { all_day: allDay } : {}),
    ...(location ? { location: truncate(location, 120) } : {}),
    ...(text(calendar.name) ? { calendar: text(calendar.name) } : {}),
  };
}

export interface QuickLinkCard {
  card?: string;
  links: Array<{ label?: string; url: string }>;
}

export function projectQuickLinkCard(raw: unknown): QuickLinkCard | undefined {
  const card = dict(raw);
  const links = list(card.links)
    .map((entry) => {
      const link = dict(entry);
      const url = text(link.url);
      if (!url) return undefined;
      const label = text(link.label) ?? text(link.title);
      return { ...(label ? { label } : {}), url };
    })
    .filter((link): link is { label?: string; url: string } => link !== undefined);
  if (links.length === 0) return undefined;
  const title = text(card.title);
  return { ...(title ? { card: title } : {}), links };
}

/* ------------------------------------------------------------------ loaders */

export interface AnnouncementsResult {
  count: number;
  items: NoticeRow[];
}

export async function loadAnnouncements(deps: DashboardDeps): Promise<AnnouncementsResult> {
  const { cfg, portal, cache } = deps;
  return cache.get("announcements", cfg.cache.announcementsTtlSeconds, async () => {
    const params = new URLSearchParams();
    params.append("notice_type", "Emergency");
    params.append("notice_type", "Alert");
    params.append("status", "NO_STATUS");
    params.append("status", "APPROVED");
    params.set("scheduled", "false");
    params.set("expired", "false");
    params.set("dismissed", "false");
    params.set("limit", String(cfg.maxResults.announcements));
    params.set("offset", "0");
    const body = await portal.getPortalJson<unknown>(`/api/v1/notices/?${params.toString()}`);
    const results = list(dict(body).results);
    const items = results
      .map((entry) => projectNotice(entry, cfg.maxResults.previewChars))
      .filter((entry): entry is NoticeRow => entry !== undefined);
    return { count: numeric(dict(body).count) ?? items.length, items };
  });
}

export interface TasksResult {
  count: number;
  items: TaskRow[];
}

export async function loadTasks(deps: DashboardDeps): Promise<TasksResult> {
  const { cfg, portal, cache } = deps;
  return cache.get("tasks", cfg.cache.tasksTtlSeconds, async () => {
    const body = await portal.getFlowJson<unknown>("/pathify-api/v1/users/me/tasks/");
    const rows = Array.isArray(body) ? body : list(dict(body).results);
    const items = rows
      .map((entry) => projectTask(entry, cfg.maxResults.previewChars))
      .filter((entry): entry is TaskRow => entry !== undefined)
      .sort((a, b) => {
        const left = a.due ? Date.parse(a.due) : Number.POSITIVE_INFINITY;
        const right = b.due ? Date.parse(b.due) : Number.POSITIVE_INFINITY;
        return left - right;
      });
    return { count: items.length, items };
  });
}

export interface EventsResult {
  window: { from: string; to: string; days: number };
  count: number;
  items: EventRow[];
}

function shiftDate(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export async function loadEvents(
  deps: DashboardDeps,
  options: { days?: number; limit?: number } = {},
): Promise<EventsResult> {
  const { cfg, portal, cache } = deps;
  const days = Math.min(Math.max(0, Math.trunc(options.days ?? cfg.limits.eventWindowDays)), 31);
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? cfg.maxResults.events)), 50);
  return cache.get(`events:${days}`, cfg.cache.eventsTtlSeconds, async () => {
    const params = new URLSearchParams();
    params.set("offset", "0");
    params.set("limit", String(cfg.limits.eventFetchLimit));
    params.set("current", "true");
    for (const field of ["id", "title", "start_date", "end_date", "all_day", "location", "calendar"]) {
      params.append("field", field);
    }
    const body = await portal.getPortalJson<unknown>(`/api/v2/events/?${params.toString()}`);
    const now = nowOf(deps);
    const today = localDate(now, cfg.timezone);
    const last = shiftDate(today, days);
    const seen = new Set<number>();
    const items: EventRow[] = [];
    for (const entry of list(dict(body).results)) {
      const row = projectEvent(entry, cfg.timezone);
      if (!row?.start) continue;
      const dateKey = row.all_day ? row.start.slice(0, 10) : localDate(row.start, cfg.timezone);
      if (dateKey < today || dateKey > last) continue;
      if (row.id !== undefined) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
      }
      items.push(row);
    }
    items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return {
      window: { from: today, to: last, days },
      count: items.length,
      items: items.slice(0, limit),
    };
  });
}

export interface QuickLinksResult {
  count: number;
  items: QuickLinkCard[];
}

export async function loadQuickLinks(deps: DashboardDeps): Promise<QuickLinksResult> {
  const { cfg, portal, cache } = deps;
  return cache.get("quick_links", cfg.cache.quickLinksTtlSeconds, async () => {
    const body = await portal.getPortalJson<unknown>("/api/v1/dashboard/quick-link-cards/?active=true");
    const items = list(body)
      .map((entry) => projectQuickLinkCard(entry))
      .filter((entry): entry is QuickLinkCard => entry !== undefined);
    return { count: items.length, items };
  });
}

export interface OverviewResult {
  generated_at: string;
  student: ProfileRow;
  announcements: { count: number; items: NoticeRow[] };
  tasks: { pending: number; items: TaskRow[] };
  today: EventsResult;
}

/** One compact dashboard call: identity, top notices, pending tasks, today's events. */
export async function loadOverview(deps: DashboardDeps): Promise<OverviewResult> {
  const { cfg, portal, cache } = deps;
  const [student, announcements, tasks, today] = await Promise.all([
    cache.get("profile", cfg.cache.profileTtlSeconds, async () =>
      projectProfile(await portal.getPortalJson<unknown>("/api/v1/users/me/")),
    ),
    loadAnnouncements(deps),
    loadTasks(deps),
    loadEvents(deps, { days: 0, limit: cfg.maxResults.events }),
  ]);
  const pending = tasks.items.filter((task) => task.complete !== true);
  return {
    generated_at: nowOf(deps).toISOString(),
    student,
    announcements: { count: announcements.count, items: announcements.items.slice(0, 3) },
    tasks: { pending: pending.length, items: pending.slice(0, 5) },
    today,
  };
}
