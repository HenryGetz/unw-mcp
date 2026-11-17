/**
 * `unw_calendar`: academic dates (public ICS) and campus events (portal).
 */
import { z } from "zod";
import {
  loadAcademicRows,
  loadCampusEvents,
  type CalendarDeps,
} from "../portal/calendar.js";
import {
  numberArg,
  opOf,
  pageSize,
  stringArg,
  textResult,
  toolError,
  unknownOp,
  type ToolModule,
} from "./shared.js";
import type { AppContext } from "./context.js";

const OPS = ["academic", "breaks", "deadlines", "events"] as const;

function calendarDeps(ctx: AppContext): CalendarDeps {
  return {
    portal: ctx.portal,
    cfg: ctx.cfg,
    cache: ctx.cache,
    now: ctx.now,
    fetch: ctx.fetch,
  };
}

export function calendarTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_calendar",
    title: "UNW calendar",
    description:
      "Academic calendar and campus events: upcoming semester dates, breaks/recesses, registration and withdrawal deadlines (public Google ICS, cached 6h), plus portal campus events filtered by local date. Read-only.",
    shape: {
      op: z.enum(OPS).describe("academic; breaks; deadlines; events"),
      days: z
        .number()
        .int()
        .min(0)
        .max(730)
        .optional()
        .describe("window from today in days (default 365 for academic/breaks/deadlines, 7 for events)"),
      limit: z.number().int().min(1).max(50).optional().describe("rows to return"),
      query: z
        .string()
        .min(2)
        .max(120)
        .optional()
        .describe("academic/breaks/deadlines: case-insensitive title filter"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_calendar", typeof args.op === "string" ? args.op : "", OPS);
      const deps = calendarDeps(ctx);
      const days = numberArg(args, "days");
      const query = stringArg(args, "query");
      try {
        switch (op) {
          case "academic":
            return textResult({
              op,
              ...(await loadAcademicRows(deps, "academic", {
                ...(days !== undefined ? { days } : { days: 365 }),
                ...(query ? { query } : {}),
                limit: pageSize(args, "limit", ctx.cfg.maxResults.calendar, 50),
              })),
            });
          case "breaks":
            return textResult({
              op,
              ...(await loadAcademicRows(deps, "breaks", {
                ...(days !== undefined ? { days } : { days: 365 }),
                ...(query ? { query } : {}),
                limit: pageSize(args, "limit", 10, 50),
              })),
            });
          case "deadlines":
            return textResult({
              op,
              ...(await loadAcademicRows(deps, "deadlines", {
                ...(days !== undefined ? { days } : { days: 365 }),
                ...(query ? { query } : {}),
                limit: pageSize(args, "limit", 10, 50),
              })),
            });
          case "events":
            return textResult({
              op,
              ...(await loadCampusEvents(deps, {
                ...(days !== undefined ? { days } : {}),
                limit: pageSize(args, "limit", ctx.cfg.maxResults.events, 50),
              })),
            });
        }
        return unknownOp("unw_calendar", op, OPS);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
