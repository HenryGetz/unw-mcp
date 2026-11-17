import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_TIMEZONE, config, resetConfigCache } from "../src/config.js";

const ENV_KEYS = [
  "UNW_MCP_CONFIG_DIR",
  "UNW_MCP_CONFIG_FILE",
  "UNW_MCP_TIMEZONE",
  "UNW_MCP_HEADLESS",
  "UNW_MCP_PROFILE_DIR",
  "UNW_MCP_DASHBOARD_TTL_MINUTES",
] as const;

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), "unw-mcp-config-test-"));
  process.env.UNW_MCP_CONFIG_DIR = dir;
  process.env.UNW_MCP_CONFIG_FILE = join(dir, "config.yaml");
  delete process.env.UNW_MCP_TIMEZONE;
  delete process.env.UNW_MCP_HEADLESS;
  delete process.env.UNW_MCP_PROFILE_DIR;
  delete process.env.UNW_MCP_DASHBOARD_TTL_MINUTES;
  resetConfigCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigCache();
});

describe("config", () => {
  it("applies documented defaults when no file exists", () => {
    const cfg = config();
    expect(cfg.timezone).toBe(DEFAULT_TIMEZONE);
    expect(cfg.headless).toBe(true);
    expect(cfg.profileDir).toBe(join(dir, "browser-profile"));
    expect(cfg.cache.dashboardTtlSeconds).toBe(300);
    expect(cfg.cache.diningTtlSeconds).toBe(3600);
    expect(cfg.cache.academicCalendarTtlSeconds).toBe(21_600);
    expect(cfg.cache.pagesTtlSeconds).toBe(86_400);
    expect(cfg.maxResults.announcements).toBe(5);
    expect(cfg.maxResults.diningItemsPerStation).toBe(25);
    expect(cfg.maxResults.pageBodyChars).toBe(4000);
    expect(cfg.cache.pageSearchTtlSeconds).toBe(600);
    expect(cfg.limits.eventWindowDays).toBe(7);
  });

  it("reads YAML overrides", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      ["timezone: UTC", "headless: false", "cache:", "  dashboard_ttl_minutes: 7", "max_results:", "  events: 3"].join(
        "\n",
      ),
    );
    const cfg = config();
    expect(cfg.timezone).toBe("UTC");
    expect(cfg.headless).toBe(false);
    expect(cfg.cache.dashboardTtlSeconds).toBe(420);
    expect(cfg.maxResults.events).toBe(3);
    // untouched keys keep defaults
    expect(cfg.cache.tasksTtlSeconds).toBe(120);
  });

  it("lets environment variables win over YAML", () => {
    writeFileSync(join(dir, "config.yaml"), "timezone: UTC\ncache:\n  dashboard_ttl_minutes: 7\n");
    process.env.UNW_MCP_TIMEZONE = "America/New_York";
    process.env.UNW_MCP_DASHBOARD_TTL_MINUTES = "9";
    const cfg = config();
    expect(cfg.timezone).toBe("America/New_York");
    expect(cfg.cache.dashboardTtlSeconds).toBe(540);
  });

  it("rejects an invalid timezone", () => {
    writeFileSync(join(dir, "config.yaml"), "timezone: Mars/Olympus\n");
    expect(() => config()).toThrow(ConfigError);
  });

  it("rejects an invalid boolean env value", () => {
    process.env.UNW_MCP_HEADLESS = "maybe";
    expect(() => config()).toThrow(/UNW_MCP_HEADLESS/);
  });

  it("reloads when the file changes", () => {
    writeFileSync(join(dir, "config.yaml"), "max_results:\n  tasks: 4\n");
    expect(config().maxResults.tasks).toBe(4);
    writeFileSync(join(dir, "config.yaml"), "max_results:\n  tasks: 9\n");
    expect(config().maxResults.tasks).toBe(9);
  });
});
