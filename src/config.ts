/**
 * Configuration.
 *
 * Precedence, highest first: environment variables > config.yaml > defaults.
 *
 * config.yaml lives at `${UNW_MCP_CONFIG_DIR:-~/.config/unw-mcp}/config.yaml`,
 * is re-read whenever its mtime/size changes, and is validated with zod.
 * A missing file is not an error — defaults apply.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_TIMEZONE = "America/Chicago";

export const DEFAULT_PORTAL_ORIGIN = "https://my.unw.edu";
export const DEFAULT_FLOW_ORIGIN = "https://flow.my.unw.edu";
export const DEFAULT_REGISTRATION_ORIGIN = "https://registration-ss.oci.unw.edu";
export const DEFAULT_STUDENT_ORIGIN = "https://student-ss.oci.unw.edu";

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.trim() !== zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimeZone, "expected an IANA time zone, e.g. America/Chicago or UTC")
  .default(DEFAULT_TIMEZONE);

const cacheSchema = z
  .object({
    dashboard_ttl_minutes: z.number().int().min(1).max(1440).default(5),
    announcements_ttl_minutes: z.number().int().min(1).max(1440).default(2),
    tasks_ttl_minutes: z.number().int().min(1).max(1440).default(2),
    events_ttl_minutes: z.number().int().min(1).max(1440).default(5),
    quick_links_ttl_minutes: z.number().int().min(1).max(1440).default(10),
    profile_ttl_minutes: z.number().int().min(1).max(1440).default(10),
    dining_ttl_minutes: z.number().int().min(1).max(1440).default(60),
    academic_calendar_ttl_minutes: z.number().int().min(1).max(1440).default(360),
    pages_ttl_minutes: z.number().int().min(1).max(1440).default(1440),
    page_search_ttl_minutes: z.number().int().min(1).max(1440).default(10),
    schedule_ttl_minutes: z.number().int().min(1).max(1440).default(10),
    grades_ttl_minutes: z.number().int().min(1).max(1440).default(30),
    gpa_ttl_minutes: z.number().int().min(1).max(1440).default(30),
    holds_ttl_minutes: z.number().int().min(1).max(1440).default(5),
    registration_ttl_minutes: z.number().int().min(1).max(1440).default(5),
    terms_ttl_minutes: z.number().int().min(1).max(1440).default(60),
    balances_ttl_minutes: z.number().int().min(1).max(1440).default(5),
    chapel_ttl_minutes: z.number().int().min(1).max(1440).default(15),
    financial_aid_ttl_minutes: z.number().int().min(1).max(1440).default(60),
  })
  .default({
    dashboard_ttl_minutes: 5,
    announcements_ttl_minutes: 2,
    tasks_ttl_minutes: 2,
    events_ttl_minutes: 5,
    quick_links_ttl_minutes: 10,
    profile_ttl_minutes: 10,
    dining_ttl_minutes: 60,
    academic_calendar_ttl_minutes: 360,
    pages_ttl_minutes: 1440,
    page_search_ttl_minutes: 10,
    schedule_ttl_minutes: 10,
    grades_ttl_minutes: 30,
    gpa_ttl_minutes: 30,
    holds_ttl_minutes: 5,
    registration_ttl_minutes: 5,
    terms_ttl_minutes: 60,
    balances_ttl_minutes: 5,
    chapel_ttl_minutes: 15,
    financial_aid_ttl_minutes: 60,
  });

const maxResultsSchema = z
  .object({
    announcements: z.number().int().min(1).max(50).default(5),
    events: z.number().int().min(1).max(50).default(10),
    tasks: z.number().int().min(1).max(50).default(20),
    pages: z.number().int().min(1).max(25).default(10),
    preview_chars: z.number().int().min(40).max(2000).default(300),
    dining_items_per_station: z.number().int().min(1).max(200).default(25),
    dining_stations: z.number().int().min(1).max(50).default(12),
    calendar: z.number().int().min(1).max(50).default(20),
    page_body_chars: z.number().int().min(200).max(20_000).default(4000),
  })
  .default({
    announcements: 5,
    events: 10,
    tasks: 20,
    pages: 10,
    preview_chars: 300,
    dining_items_per_station: 25,
    dining_stations: 12,
    calendar: 20,
    page_body_chars: 4000,
  });

const limitsSchema = z
  .object({
    /** Events are filtered client-side; this bounds how many arrive. */
    event_fetch_limit: z.number().int().min(1).max(200).default(60),
    event_window_days: z.number().int().min(1).max(60).default(7),
  })
  .default({ event_fetch_limit: 60, event_window_days: 7 });

const fileSchema = z.object({
  timezone: timezoneSchema,
  headless: z.boolean().default(true),
  cache: cacheSchema,
  max_results: maxResultsSchema,
  limits: limitsSchema,
});

type FileConfig = z.output<typeof fileSchema>;

export interface ResolvedConfig {
  configDir: string;
  configFile: string;
  /** Persistent Chromium profile (0700). */
  profileDir: string;
  /** Scratch directory for future on-disk caches; personalized data stays in memory. */
  cacheDir: string;
  timezone: string;
  headless: boolean;
  portalOrigin: string;
  flowOrigin: string;
  registrationOrigin: string;
  studentOrigin: string;
  requestTimeoutMs: number;
  navigationTimeoutMs: number;
  /** How long a silent SAML round trip may take before credential fallback. */
  reauthTimeoutMs: number;
  cache: {
    dashboardTtlSeconds: number;
    announcementsTtlSeconds: number;
    tasksTtlSeconds: number;
    eventsTtlSeconds: number;
    quickLinksTtlSeconds: number;
    profileTtlSeconds: number;
    diningTtlSeconds: number;
    academicCalendarTtlSeconds: number;
    pagesTtlSeconds: number;
    pageSearchTtlSeconds: number;
    scheduleTtlSeconds: number;
    gradesTtlSeconds: number;
    gpaTtlSeconds: number;
    holdsTtlSeconds: number;
    registrationTtlSeconds: number;
    termsTtlSeconds: number;
    balancesTtlSeconds: number;
    chapelTtlSeconds: number;
    financialAidTtlSeconds: number;
  };
  maxResults: {
    announcements: number;
    events: number;
    tasks: number;
    pages: number;
    previewChars: number;
    diningItemsPerStation: number;
    diningStations: number;
    calendar: number;
    pageBodyChars: number;
  };
  limits: {
    eventFetchLimit: number;
    eventWindowDays: number;
  };
}

export class ConfigError extends Error {
  readonly code = "config_invalid";
  constructor(
    readonly path: string,
    readonly issues: string[],
  ) {
    super(`invalid config ${path}: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

const TRUE_WORDS = ["1", "true", "yes", "on", "enabled"];
const FALSE_WORDS = ["0", "false", "no", "off", "disabled"];

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function envFlag(name: string): boolean | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  throw new ConfigError("<env>", [`${name} must be one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`]);
}

function envInteger(name: string, min: number, max: number): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError("<env>", [`${name} must be an integer between ${min} and ${max}`]);
  }
  return value;
}

export function configDir(): string {
  return expandHome(envValue("UNW_MCP_CONFIG_DIR") ?? join(homedir(), ".config", "unw-mcp"));
}

export function configFile(): string {
  return expandHome(envValue("UNW_MCP_CONFIG_FILE") ?? join(configDir(), "config.yaml"));
}

export function parseConfigYaml(text: string, path = "<string>"): FileConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (error) {
    throw new ConfigError(path, [`YAML parse error: ${(error as Error).message}`]);
  }
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      path,
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return result.data;
}

/** TTL env overrides, expressed in minutes like the YAML keys. */
const TTL_ENV: Record<keyof FileConfig["cache"], string> = {
  dashboard_ttl_minutes: "UNW_MCP_DASHBOARD_TTL_MINUTES",
  announcements_ttl_minutes: "UNW_MCP_ANNOUNCEMENTS_TTL_MINUTES",
  tasks_ttl_minutes: "UNW_MCP_TASKS_TTL_MINUTES",
  events_ttl_minutes: "UNW_MCP_EVENTS_TTL_MINUTES",
  quick_links_ttl_minutes: "UNW_MCP_QUICK_LINKS_TTL_MINUTES",
  profile_ttl_minutes: "UNW_MCP_PROFILE_TTL_MINUTES",
  dining_ttl_minutes: "UNW_MCP_DINING_TTL_MINUTES",
  academic_calendar_ttl_minutes: "UNW_MCP_ACADEMIC_CALENDAR_TTL_MINUTES",
  pages_ttl_minutes: "UNW_MCP_PAGES_TTL_MINUTES",
  page_search_ttl_minutes: "UNW_MCP_PAGE_SEARCH_TTL_MINUTES",
  schedule_ttl_minutes: "UNW_MCP_SCHEDULE_TTL_MINUTES",
  grades_ttl_minutes: "UNW_MCP_GRADES_TTL_MINUTES",
  gpa_ttl_minutes: "UNW_MCP_GPA_TTL_MINUTES",
  holds_ttl_minutes: "UNW_MCP_HOLDS_TTL_MINUTES",
  registration_ttl_minutes: "UNW_MCP_REGISTRATION_TTL_MINUTES",
  terms_ttl_minutes: "UNW_MCP_TERMS_TTL_MINUTES",
  balances_ttl_minutes: "UNW_MCP_BALANCES_TTL_MINUTES",
  chapel_ttl_minutes: "UNW_MCP_CHAPEL_TTL_MINUTES",
  financial_aid_ttl_minutes: "UNW_MCP_FINANCIAL_AID_TTL_MINUTES",
};

let memo: { path: string; mtimeMs: number; size: number; value: ResolvedConfig } | undefined;

/** Forget the memoised config (tests, or after editing config.yaml). */
export function resetConfigCache(): void {
  memo = undefined;
}

export function config(): ResolvedConfig {
  const path = configFile();
  let stat: { mtimeMs: number; size: number } | undefined;
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    stat = undefined;
  }

  if (
    memo &&
    memo.path === path &&
    memo.mtimeMs === (stat?.mtimeMs ?? -1) &&
    memo.size === (stat?.size ?? -1)
  ) {
    return memo.value;
  }

  const file = stat ? parseConfigYaml(readFileSync(path, "utf8"), path) : fileSchema.parse({});

  const timezone = envValue("UNW_MCP_TIMEZONE") ?? file.timezone;
  if (!isValidTimeZone(timezone)) {
    throw new ConfigError(path, [
      `timezone: "${timezone}" is not an IANA time zone (check UNW_MCP_TIMEZONE)`,
    ]);
  }

  const ttl = (key: keyof FileConfig["cache"]): number =>
    (envInteger(TTL_ENV[key], 1, 1440) ?? file.cache[key]) * 60;

  const dir = configDir();
  const value: ResolvedConfig = {
    configDir: dir,
    configFile: path,
    profileDir: expandHome(envValue("UNW_MCP_PROFILE_DIR") ?? join(dir, "browser-profile")),
    cacheDir: expandHome(
      envValue("UNW_MCP_CACHE_DIR") ??
        join(envValue("XDG_CACHE_HOME") ?? join(homedir(), ".cache"), "unw-mcp"),
    ),
    timezone,
    headless: envFlag("UNW_MCP_HEADLESS") ?? file.headless,
    portalOrigin: DEFAULT_PORTAL_ORIGIN,
    flowOrigin: DEFAULT_FLOW_ORIGIN,
    registrationOrigin: DEFAULT_REGISTRATION_ORIGIN,
    studentOrigin: DEFAULT_STUDENT_ORIGIN,
    requestTimeoutMs: envInteger("UNW_MCP_REQUEST_TIMEOUT_MS", 5_000, 120_000) ?? 30_000,
    navigationTimeoutMs: envInteger("UNW_MCP_NAVIGATION_TIMEOUT_MS", 10_000, 180_000) ?? 90_000,
    reauthTimeoutMs: envInteger("UNW_MCP_REAUTH_TIMEOUT_MS", 5_000, 120_000) ?? 30_000,
    cache: {
      dashboardTtlSeconds: ttl("dashboard_ttl_minutes"),
      announcementsTtlSeconds: ttl("announcements_ttl_minutes"),
      tasksTtlSeconds: ttl("tasks_ttl_minutes"),
      eventsTtlSeconds: ttl("events_ttl_minutes"),
      quickLinksTtlSeconds: ttl("quick_links_ttl_minutes"),
      profileTtlSeconds: ttl("profile_ttl_minutes"),
      diningTtlSeconds: ttl("dining_ttl_minutes"),
      academicCalendarTtlSeconds: ttl("academic_calendar_ttl_minutes"),
      pagesTtlSeconds: ttl("pages_ttl_minutes"),
      pageSearchTtlSeconds: ttl("page_search_ttl_minutes"),
      scheduleTtlSeconds: ttl("schedule_ttl_minutes"),
      gradesTtlSeconds: ttl("grades_ttl_minutes"),
      gpaTtlSeconds: ttl("gpa_ttl_minutes"),
      holdsTtlSeconds: ttl("holds_ttl_minutes"),
      registrationTtlSeconds: ttl("registration_ttl_minutes"),
      termsTtlSeconds: ttl("terms_ttl_minutes"),
      balancesTtlSeconds: ttl("balances_ttl_minutes"),
      chapelTtlSeconds: ttl("chapel_ttl_minutes"),
      financialAidTtlSeconds: ttl("financial_aid_ttl_minutes"),
    },
    maxResults: {
      announcements: file.max_results.announcements,
      events: file.max_results.events,
      tasks: file.max_results.tasks,
      pages: file.max_results.pages,
      previewChars: file.max_results.preview_chars,
      diningItemsPerStation: file.max_results.dining_items_per_station,
      diningStations: file.max_results.dining_stations,
      calendar: file.max_results.calendar,
      pageBodyChars: file.max_results.page_body_chars,
    },
    limits: {
      eventFetchLimit: file.limits.event_fetch_limit,
      eventWindowDays: file.limits.event_window_days,
    },
  };

  memo = { path, mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1, value };
  return value;
}
