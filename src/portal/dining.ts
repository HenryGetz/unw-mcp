/**
 * Dining menus (public Bon Appétit payload).
 *
 * The upstream JSON is ~1.8 MB and covers 7 rolling days for three cafes.
 * It is projected once into a compact dataset (café metadata + dayparts +
 * station item labels) and cached for an hour. Tool output contains only the
 * requested date/cafe, never the raw payload.
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import { PortalUnavailableError } from "../auth/session.js";
import { htmlToText, truncate } from "../format.js";
import { localDate } from "../time.js";
import { dict, list, numeric, text } from "./values.js";

export const DINING_URL = "https://flow.my.unw.edu/upstream/v2/bonappetit";
export const MAX_DAYPARTS = 6;
export const WEEK_SAMPLE_ITEMS = 5;
export const BRIEF_STATIONS = 6;
export const BRIEF_ITEMS = 8;

export type DiningDetail = "brief" | "full";

export interface DiningQuery {
  cafe?: string;
  meal?: string;
  detail?: DiningDetail;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiningDeps {
  cfg: ResolvedConfig;
  cache: TtlCache;
  now?: () => Date;
  fetch?: FetchLike;
}

export interface StationRow {
  label: string;
  items: string[];
  /** Items present before the per-station cap. */
  items_total?: number;
}

export interface DaypartRow {
  label: string;
  start?: string;
  end?: string;
  stations: StationRow[];
}

export interface CafeMeta {
  id: string;
  name: string;
  address?: string;
  hours?: string;
  message?: string;
}

export interface DiningDataset {
  last_updated?: string;
  cafes: CafeMeta[];
  dates: string[];
  /** date -> cafeId -> dayparts */
  days: Record<string, Record<string, DaypartRow[]>>;
}

export interface DiningDayCafe {
  name: string;
  status: "ok" | "no_menu" | "no_meal";
  dayparts?: DaypartRow[];
}

export interface DiningDayResult {
  date: string;
  requested?: string;
  status: "ok" | "no_menu" | "no_meal" | "not_available";
  detail: DiningDetail;
  meal_filter?: string;
  available_dates?: string[];
  cafes: DiningDayCafe[];
}

export interface DiningWeekDaypart {
  label: string;
  start?: string;
  end?: string;
  stations: number;
  items: number;
  sample: string[];
}

export interface DiningWeekCafe {
  name: string;
  status: "ok" | "no_menu" | "no_meal";
  dayparts?: DiningWeekDaypart[];
}

export interface DiningWeekResult {
  from: string;
  to: string;
  requested?: string;
  meal_filter?: string;
  count: number;
  days: Array<{ date: string; cafes: DiningWeekCafe[] }>;
}

export interface DiningLocationsResult {
  count: number;
  cafes: CafeMeta[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function addressOf(cafe: Record<string, unknown>): string | undefined {
  const parts = [text(cafe.address), text(cafe.city), text(cafe.state), text(cafe.zip)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function projectDaypart(
  raw: unknown,
  items: Record<string, unknown>,
  maxStations: number,
  maxItems: number,
): DaypartRow | undefined {
  const part = dict(raw);
  const label = text(part.label);
  if (!label) return undefined;
  const stations = list(part.stations).slice(0, maxStations).flatMap((entry): StationRow[] => {
    const station = dict(entry);
    const stationLabel = text(station.label);
    if (!stationLabel) return [];
    const all = dedupe(
      list(station.items)
        .map((id) => text(dict(items[String(id)]).label))
        .filter((item): item is string => item !== undefined),
    );
    if (all.length === 0) return [];
    return [
      {
        label: stationLabel,
        items: all.slice(0, maxItems),
        ...(all.length > maxItems ? { items_total: all.length } : {}),
      },
    ];
  });
  const start = text(part.starttime);
  const end = text(part.endtime);
  return {
    label,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    stations,
  };
}

/** Project the raw payload into a compact, date-indexed dataset. */
export function projectDiningDataset(
  raw: unknown,
  options: { maxStations?: number; maxItems?: number } = {},
): DiningDataset {
  const maxStations = options.maxStations ?? 12;
  const maxItems = options.maxItems ?? 25;
  const root = dict(raw);
  const cafes: CafeMeta[] = [];
  for (const campus of Object.values(dict(root.campuses))) {
    for (const [id, entry] of Object.entries(dict(dict(campus).cafes))) {
      const cafe = dict(entry);
      cafes.push({
        id,
        name: htmlToText(text(cafe.name) ?? id) || id,
        ...(addressOf(cafe) ? { address: addressOf(cafe) } : {}),
        ...(htmlToText(text(cafe.weekly_schedule))
          ? { hours: truncate(htmlToText(text(cafe.weekly_schedule)), 300) }
          : {}),
        ...(htmlToText(text(cafe.message))
          ? { message: truncate(htmlToText(text(cafe.message)), 300) }
          : {}),
      });
    }
  }

  const data = dict(root.data);
  const dateSet = new Set<string>();
  for (const cafe of cafes) {
    for (const date of Object.keys(dict(data[cafe.id]))) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dateSet.add(date);
    }
  }
  const dates = [...dateSet].sort();
  const days: DiningDataset["days"] = {};
  for (const date of dates) {
    days[date] = {};
    for (const cafe of cafes) {
      const day = dict(dict(data[cafe.id])[date]);
      if (Object.keys(day).length === 0) continue;
      const firstDay = dict(list(day.days)[0]);
      const cafeDay = dict(dict(firstDay.cafes)[cafe.id]);
      const items = dict(day.items);
      const dayparts = list(cafeDay.dayparts)
        .flatMap((group) => list(group))
        .slice(0, MAX_DAYPARTS)
        .map((part) => projectDaypart(part, items, maxStations, maxItems))
        .filter((part): part is DaypartRow => part !== undefined);
      if (dayparts.length > 0) days[date][cafe.id] = dayparts;
    }
  }

  const lastUpdated = numeric(root.lastUpdated);
  return {
    ...(lastUpdated !== undefined ? { last_updated: new Date(lastUpdated).toISOString() } : {}),
    cafes,
    dates,
    days,
  };
}

function filterCafes(cafes: CafeMeta[], filter: string | undefined): CafeMeta[] {
  const needle = filter?.trim().toLowerCase();
  if (!needle) return cafes;
  return cafes.filter(
    (cafe) => cafe.id === needle || cafe.name.toLowerCase().includes(needle),
  );
}

function filterMeal(dayparts: DaypartRow[], meal: string | undefined): DaypartRow[] {
  const needle = meal?.trim().toLowerCase();
  if (!needle) return dayparts;
  return dayparts.filter((part) => part.label.toLowerCase().includes(needle));
}

function briefDayparts(dayparts: DaypartRow[], detail: DiningDetail): DaypartRow[] {
  if (detail === "full") return dayparts;
  return dayparts.map((part) => ({
    ...part,
    stations: part.stations.slice(0, BRIEF_STATIONS).map((station) => ({
      ...station,
      items: station.items.slice(0, BRIEF_ITEMS),
    })),
  }));
}

export function projectDiningDay(
  dataset: DiningDataset,
  date: string,
  query: DiningQuery = {},
): DiningDayResult {
  const detail = query.detail ?? "brief";
  const meal = query.meal?.trim().toLowerCase();
  const base = {
    date,
    detail,
    ...(meal ? { meal_filter: meal } : {}),
  };
  if (!dataset.dates.includes(date)) {
    return {
      ...base,
      status: "not_available",
      available_dates: dataset.dates,
      cafes: [],
    };
  }
  const selected = filterCafes(dataset.cafes, query.cafe);
  let sawNoMeal = false;
  const cafes = selected.map((cafe): DiningDayCafe => {
    const raw = dataset.days[date]?.[cafe.id] ?? [];
    if (raw.length === 0) return { name: cafe.name, status: "no_menu" };
    const matching = filterMeal(raw, meal);
    if (matching.length === 0) {
      sawNoMeal = true;
      return { name: cafe.name, status: "no_meal" };
    }
    return { name: cafe.name, status: "ok", dayparts: briefDayparts(matching, detail) };
  });
  const anyMenu = cafes.some((cafe) => cafe.status === "ok");
  return {
    ...base,
    status: anyMenu ? "ok" : sawNoMeal ? "no_meal" : "no_menu",
    cafes,
  };
}

export function projectDiningWeek(
  dataset: DiningDataset,
  requestedDate: string,
  query: DiningQuery = {},
): DiningWeekResult {
  const meal = query.meal?.trim().toLowerCase();
  const start = dataset.dates.indexOf(requestedDate);
  const dates = dataset.dates.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + 7);
  const selected = filterCafes(dataset.cafes, query.cafe);
  const days = dates.map((date) => ({
    date,
    cafes: selected.map((cafe): DiningWeekCafe => {
      const raw = dataset.days[date]?.[cafe.id] ?? [];
      if (raw.length === 0) return { name: cafe.name, status: "no_menu" };
      const dayparts = filterMeal(raw, meal);
      if (dayparts.length === 0) return { name: cafe.name, status: "no_meal" };
      return {
        name: cafe.name,
        status: "ok",
        dayparts: dayparts.map((part) => {
          const items = part.stations.flatMap((station) => station.items);
          return {
            label: part.label,
            ...(part.start ? { start: part.start } : {}),
            ...(part.end ? { end: part.end } : {}),
            stations: part.stations.length,
            items: items.length,
            sample: items.slice(0, WEEK_SAMPLE_ITEMS),
          };
        }),
      };
    }),
  }));
  return {
    from: dates[0] ?? requestedDate,
    to: dates[dates.length - 1] ?? requestedDate,
    ...(start < 0 ? { requested: requestedDate } : {}),
    ...(meal ? { meal_filter: meal } : {}),
    count: days.length,
    days,
  };
}

export function projectDiningLocations(dataset: DiningDataset): DiningLocationsResult {
  return { count: dataset.cafes.length, cafes: dataset.cafes };
}

async function fetchDiningPayload(fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(DINING_URL, {
      headers: { Accept: "application/json", "User-Agent": "unw-mcp/0.1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new PortalUnavailableError(
      `dining menu could not be fetched (${(error as Error).message.slice(0, 120)})`,
      "retry shortly; the menu endpoint is public and may be down",
    );
  }
  if (!response.ok) {
    throw new PortalUnavailableError(
      `dining menu returned HTTP ${response.status}`,
      "retry shortly; the menu endpoint is public and may be down",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new PortalUnavailableError("dining menu returned malformed JSON");
  }
}

export async function loadDiningDataset(deps: DiningDeps): Promise<DiningDataset> {
  return deps.cache.get("dining:dataset", deps.cfg.cache.diningTtlSeconds, async () => {
    const raw = await fetchDiningPayload(deps.fetch ?? globalThis.fetch, deps.cfg.requestTimeoutMs);
    return projectDiningDataset(raw, {
      maxStations: deps.cfg.maxResults.diningStations,
      maxItems: deps.cfg.maxResults.diningItemsPerStation,
    });
  });
}

export async function loadDiningDay(
  deps: DiningDeps,
  dateInput?: string,
  query: DiningQuery = {},
): Promise<DiningDayResult> {
  const now = deps.now ? deps.now() : new Date();
  const requested = dateInput?.trim();
  const date = requested || localDate(now, deps.cfg.timezone);
  const dataset = await loadDiningDataset(deps);
  const result = projectDiningDay(dataset, date, query);
  return requested ? { ...result, requested } : result;
}

export async function loadDiningWeek(
  deps: DiningDeps,
  dateInput?: string,
  query: DiningQuery = {},
): Promise<DiningWeekResult> {
  const now = deps.now ? deps.now() : new Date();
  const requested = dateInput?.trim();
  const date = requested || localDate(now, deps.cfg.timezone);
  const dataset = await loadDiningDataset(deps);
  return projectDiningWeek(dataset, date, query);
}

export async function loadDiningLocations(deps: DiningDeps): Promise<DiningLocationsResult> {
  return projectDiningLocations(await loadDiningDataset(deps));
}
