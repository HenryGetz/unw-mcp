/**
 * `unw_dashboard`: the student's home screen in five compact views.
 *
 * Rows are projected (5–12 fields), HTML is stripped, dates use the configured
 * zone, and every list is capped. No write operations exist.
 */
import { z } from "zod";
import {
  loadAnnouncements,
  loadEvents,
  loadOverview,
  loadQuickLinks,
  loadTasks,
} from "../portal/dashboard.js";
import { loadDay, type DayDeps } from "../portal/day.js";
import {
  booleanArg,
  numberArg,
  opOf,
  pageSize,
  textResult,
  toolError,
  unknownOp,
  type ToolModule,
} from "./shared.js";
import type { AppContext } from "./context.js";
import type { DashboardDeps } from "../portal/dashboard.js";

const OPS = ["overview", "day", "announcements", "tasks", "events", "quick_links"] as const;

export function dashboardTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_dashboard",
    title: "myUNW dashboard",
    description:
      "Student dashboard. day is the plan-my-day view: today's classes, next-24h campus events, pending tasks and the next meal with a few options. overview adds identity/degree progress and announcements; announcements/tasks/events/quick_links return one list. Read-only.",
    shape: {
      op: z
        .enum(OPS)
        .describe(
          "overview: identity + 3 notices + 5 tasks + today; day: classes + 24h events + tasks + next meal; announcements; tasks; events; quick_links",
        ),
      limit: z.number().int().min(1).max(50).optional().describe("rows to return (default per op)"),
      days: z.number().int().min(0).max(31).optional().describe("events only: today + N days (default 7)"),
      include_completed: z.boolean().optional().describe("tasks only: include completed items"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_dashboard", typeof args.op === "string" ? args.op : "", OPS);
      const deps: DashboardDeps = {
        portal: ctx.portal,
        cfg: ctx.cfg,
        cache: ctx.cache,
        now: ctx.now,
      };
      try {
        switch (op) {
          case "overview":
            return textResult({ op, ...(await loadOverview(deps)) });
          case "day": {
            const dayDeps: DayDeps = {
              academic: {
                portal: ctx.portal,
                banner: ctx.banner,
                cfg: ctx.cfg,
                cache: ctx.cache,
                now: ctx.now,
              },
              dashboard: deps,
              dining: { cfg: ctx.cfg, cache: ctx.cache, now: ctx.now, fetch: ctx.fetch },
              cfg: ctx.cfg,
              now: ctx.now,
            };
            return textResult({ op, ...(await loadDay(dayDeps)) });
          }
          case "announcements": {
            const limit = pageSize(args, "limit", ctx.cfg.maxResults.announcements, 50);
            const result = await loadAnnouncements(deps);
            return textResult({ op, count: result.count, items: result.items.slice(0, limit) });
          }
          case "tasks": {
            const limit = pageSize(args, "limit", ctx.cfg.maxResults.tasks, 50);
            const includeCompleted = booleanArg(args, "include_completed") ?? false;
            const result = await loadTasks(deps);
            const pending = result.items.filter((task) => task.complete !== true);
            const items = (includeCompleted ? result.items : pending).slice(0, limit);
            return textResult({ op, count: result.count, pending: pending.length, items });
          }
          case "events": {
            const limit = pageSize(args, "limit", ctx.cfg.maxResults.events, 50);
            const days = numberArg(args, "days");
            const result = await loadEvents(deps, {
              ...(days !== undefined ? { days } : {}),
              limit,
            });
            return textResult({ op, ...result });
          }
          case "quick_links": {
            const result = await loadQuickLinks(deps);
            return textResult({ op, ...result });
          }
        }
        return unknownOp("unw_dashboard", op, OPS);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
