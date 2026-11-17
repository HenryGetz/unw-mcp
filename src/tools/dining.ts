/**
 * `unw_dining`: public campus menus.
 *
 * The 1.8 MB upstream payload is projected and cached; output contains only the
 * requested date/cafe (or a compact 7-day overview).
 */
import { z } from "zod";
import { loadDiningDay, loadDiningLocations, loadDiningWeek, type DiningDeps } from "../portal/dining.js";
import { opOf, stringArg, textResult, toolError, unknownOp, type ToolModule } from "./shared.js";
import type { AppContext } from "./context.js";

const OPS = ["locations", "today", "week"] as const;

function diningDeps(ctx: AppContext): DiningDeps {
  return {
    cfg: ctx.cfg,
    cache: ctx.cache,
    now: ctx.now,
    fetch: ctx.fetch,
  };
}

export function diningTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_dining",
    title: "UNW dining",
    description:
      "Campus dining menus: locations, one day's cafes/dayparts/stations/items, or a compact 7-day overview. Public data, cached hourly; never returns the raw menu payload.",
    shape: {
      op: z.enum(OPS).describe("locations; today (one day); week (7 rolling days)"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
        .optional()
        .describe("today/week: start date; default is today in the configured zone"),
      cafe: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe("filter by cafe name or id (case-insensitive substring)"),
      meal: z
        .enum(["breakfast", "lunch", "dinner"])
        .optional()
        .describe("today/week: only this daypart (case-insensitive substring)"),
      detail: z
        .enum(["brief", "full"])
        .default("brief")
        .describe("today: brief (6 stations × 8 items) or full (configured caps)"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_dining", typeof args.op === "string" ? args.op : "", OPS);
      const deps = diningDeps(ctx);
      const date = stringArg(args, "date");
      const cafe = stringArg(args, "cafe");
      const meal = stringArg(args, "meal");
      const detail = (stringArg(args, "detail") as "brief" | "full" | undefined) ?? "brief";
      const query = { ...(cafe ? { cafe } : {}), ...(meal ? { meal } : {}), detail } as const;
      try {
        switch (op) {
          case "locations":
            return textResult({ op, ...(await loadDiningLocations(deps)) });
          case "today":
            return textResult({ op, ...(await loadDiningDay(deps, date, query)) });
          case "week":
            return textResult({ op, ...(await loadDiningWeek(deps, date, query)) });
        }
        return unknownOp("unw_dining", op, OPS);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
