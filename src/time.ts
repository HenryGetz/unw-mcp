/**
 * Timezone-aware rendering helpers.
 *
 * Every instant that leaves a tool is rendered in the configured zone
 * (America/Chicago by default) while also keeping an ISO UTC field, so an agent
 * can both talk to a human and compute.
 */

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** `YYYY-MM-DDTHH:MM:SS` wall clock in the zone (no offset). */
  wall: string;
}

export function localParts(instant: string | number | Date, timeZone: string): LocalParts {
  const date = typeof instant === "string" || typeof instant === "number" ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const dateText = `${year}-${pad(month)}-${pad(day)}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    date: dateText,
    wall: `${dateText}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
  };
}

/** `YYYY-MM-DD` in the given zone. */
export function localDate(instant: string | number | Date, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

/** `2026-11-17 09:15` in the given zone. */
export function formatLocal(instant: string | number | Date, timeZone: string): string {
  const parts = localParts(instant, timeZone);
  return `${parts.date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` for "today" in the zone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return localDate(now, timeZone);
}

/** Whole-day offset for a calendar date relative to today in the zone. */
export function dayOffset(date: string, timeZone: string, now: Date = new Date()): number {
  const base = Date.parse(`${todayInZone(timeZone, now)}T00:00:00Z`);
  const target = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base) || Number.isNaN(target)) return Number.NaN;
  return Math.round((target - base) / 86_400_000);
}

/** Minutes since local midnight for an `HH:MM` clock string. */
export function minutesOfDay(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}
