/**
 * `unw_finances`: balances, chapel credit and financial aid.
 *
 * Read-only. Amounts are numeric when the upstream value is numeric; the
 * financial-aid view can select a year by code (2627) or label (2026-2027).
 */
import { z } from "zod";
import { loadBalances, loadChapel, loadFinancialAid, type FinanceDeps } from "../portal/finances.js";
import { opOf, stringArg, textResult, toolError, unknownOp, type ToolModule } from "./shared.js";
import type { AppContext } from "./context.js";

const OPS = ["balances", "financial_aid", "chapel"] as const;

export function financesTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_finances",
    title: "myUNW finances",
    description:
      "Student account and dining-funds balances, chapel/spiritual-development credit, and financial-aid awards plus cost of attendance for the active aid year. Read-only; amounts are in USD.",
    shape: {
      op: z.enum(OPS).describe("balances; financial_aid; chapel"),
      aid_year: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("financial_aid only: aid year code (2627) or label (2026-2027); default is current"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_finances", typeof args.op === "string" ? args.op : "", OPS);
      const deps: FinanceDeps = {
        portal: ctx.portal,
        banner: ctx.banner,
        cfg: ctx.cfg,
        cache: ctx.cache,
        now: ctx.now,
      };
      try {
        switch (op) {
          case "balances":
            return textResult({ op, ...(await loadBalances(deps)) });
          case "financial_aid":
            return textResult({ op, ...(await loadFinancialAid(deps, stringArg(args, "aid_year"))) });
          case "chapel":
            return textResult({ op, ...(await loadChapel(deps)) });
        }
        return unknownOp("unw_finances", op, OPS);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
