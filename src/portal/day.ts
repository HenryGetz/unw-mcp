/**
 * One "plan my day" projection: today's classes, the next 24 hours of campus
 * events, pending tasks, and the next meal with a short menu.
 *
 * Every section reuses an existing cached loader; this module only selects and
 * caps. It never adds a second upstream call for data another tool already
 * asked for.
 */
import type { ResolvedConfig } from "../config.js";
import { PortalUnavailableError } from "../auth/session.js";
import { localParts } from "../time.js";
import {
  loadToday,
  type AcademicDeps,
  type TermRow,
  type TodayClass,
} from "./academics.js";
import {
  loadAnnouncements,
  loadEvents,
  loadTasks,
  type DashboardDeps,
  type EventRow,
  type NoticeRow,
  type TaskRow,
} from "./dashboard.js";
import {
  BRIEF_ITEMS,
  BRIEF_STATIONS,
  loadDiningDay,
  type DiningDayResult,
  type DiningDeps,
} from "./dining.js";

export interface DayDeps {
  academic: AcademicDeps;
  dashboard: DashboardDeps;
  dining: DiningDeps;
  cfg: ResolvedConfig;
  now?: () => Date;
}

export interface NextMeal {
  cafe: string;
  meal: string;
  start?: string;
  end?: string;
  stations: Array<{ label: string; items: string[]; items_total?: number }>;
}

export type DayEvent = EventRow & { duplicate_count?: number };

export interface DayResult {
  generated_at: string;
  date: string;
  day: string;
  term: TermRow;
  classes_total: number;
  classes: TodayClass[];
  events: DayEvent[];
  tasks_pending: number;
  tasks: TaskRow[];
  announcements?: NoticeRow[];
  next_meal?: NextMeal;
  dining_status?: "unavailable";
}

/** Collapse feed duplicates (same title/start/end) and report how many merged. */
export function dedupeDayEvents(events: EventRow[]): DayEvent[] {
  const merged = new Map<string, DayEvent>();
  for (const event of events) {
    const key = `${event.title ?? ""}|${event.start ?? ""}|${event.end ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.duplicate_count = (existing.duplicate_count ?? 0) + 1;
      continue;
    }
    merged.set(key, { ...event });
  }
  return [...merged.values()];
}

function clockOf(now: Date, timezone: string): string {
  const parts = localParts(now, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * Pick the current or next daypart at the Dining Center, falling back to the
 * first cafe with a menu. Stations/items are capped for a compact answer.
 */
export function pickNextMeal(day: DiningDayResult, nowClock: string): NextMeal | undefined {
  const withMenu = day.cafes.filter(
    (cafe) => cafe.status === "ok" && (cafe.dayparts?.length ?? 0) > 0,
  );
  const cafe =
    withMenu.find((candidate) => /dining center/i.test(candidate.name)) ?? withMenu[0];
  if (!cafe) return undefined;
  const parts = cafe.dayparts ?? [];
  const current = parts.find(
    (part) => part.start && part.end && part.start <= nowClock && nowClock <= part.end,
  );
  const next = parts
    .filter((part) => part.start && part.start > nowClock)
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))[0];
  const chosen = current ?? next;
  if (!chosen) return undefined;
  return {
    cafe: cafe.name,
    meal: chosen.label,
    ...(chosen.start ? { start: chosen.start } : {}),
    ...(chosen.end ? { end: chosen.end } : {}),
    stations: chosen.stations.slice(0, BRIEF_STATIONS).map((station) => ({
      label: station.label,
      items: station.items.slice(0, BRIEF_ITEMS),
      ...(station.items_total !== undefined ? { items_total: station.items_total } : {}),
    })),
  };
}

export async function loadDay(deps: DayDeps): Promise<DayResult> {
  const now = deps.now ? deps.now() : new Date();
  const [today, tasks, events, notices] = await Promise.all([
    loadToday(deps.academic),
    loadTasks(deps.dashboard),
    loadEvents(deps.dashboard, { days: 1, limit: 50 }),
    loadAnnouncements(deps.dashboard),
  ]);

  let nextMeal: NextMeal | undefined;
  let diningStatus: DayResult["dining_status"];
  try {
    const diningDay = await loadDiningDay(deps.dining, today.date);
    nextMeal = pickNextMeal(diningDay, clockOf(now, deps.cfg.timezone));
  } catch (error) {
    if (!(error instanceof PortalUnavailableError)) throw error;
    diningStatus = "unavailable";
  }

  const nowMs = now.getTime();
  const upcoming = dedupeDayEvents(
    events.items.filter((event) => {
      const start = event.start ? Date.parse(event.start) : Number.NaN;
      return (
        Number.isFinite(start) && start >= nowMs - 3_600_000 && start <= nowMs + 86_400_000
      );
    }),
  ).slice(0, 8);
  const pending = tasks.items.filter((task) => task.complete !== true);
  const topNotices = notices.items.slice(0, 2);

  return {
    generated_at: now.toISOString(),
    date: today.date,
    day: today.day,
    term: today.term,
    classes_total: today.count,
    classes: today.classes.slice(0, 8),
    events: upcoming,
    tasks_pending: pending.length,
    tasks: pending.slice(0, 5),
    ...(topNotices.length > 0 ? { announcements: topNotices } : {}),
    ...(nextMeal ? { next_meal: nextMeal } : {}),
    ...(diningStatus ? { dining_status: diningStatus } : {}),
  };
}
