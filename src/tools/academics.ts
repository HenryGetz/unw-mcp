/**
 * `unw_academics`: the student's academic record.
 *
 * Eight ops over Flow, Banner and the portal widget claims token. Rows are
 * projected (5–12 fields), dates/times use the configured zone, and today's
 * classes come from Banner meeting-day flags rather than the empty events feed.
 */
import { z } from "zod";
import {
  loadAcademicProfile,
  loadDegreeAudit,
  loadGpa,
  loadGrades,
  loadHolds,
  loadRegistration,
  loadSchedule,
  loadToday,
  type AcademicDeps,
} from "../portal/academics.js";
import { opOf, stringArg, textResult, toolError, unknownOp, type ToolModule } from "./shared.js";
import type { AppContext } from "./context.js";

const OPS = [
  "profile",
  "today",
  "schedule",
  "grades",
  "gpa",
  "holds",
  "registration",
  "degree_audit",
] as const;

export function academicsTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_academics",
    title: "myUNW academics",
    description:
      "Academic record: profile/GPA, today's classes, schedule by term, grades by term, official GPA hours, holds, registration standing, and degree audit. Read-only. Times are America/Chicago local; term accepts a Banner code (202610) or name (Fall 2026).",
    shape: {
      op: z
        .enum(OPS)
        .describe(
          "profile; today; schedule; grades; gpa; holds; registration; degree_audit",
        ),
      term: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("schedule/grades only: Banner term code or name; default is the current term / recent graded terms"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_academics", typeof args.op === "string" ? args.op : "", OPS);
      const deps: AcademicDeps = {
        portal: ctx.portal,
        banner: ctx.banner,
        cfg: ctx.cfg,
        cache: ctx.cache,
        now: ctx.now,
      };
      const term = stringArg(args, "term");
      try {
        switch (op) {
          case "profile":
            return textResult({ op, ...(await loadAcademicProfile(deps)) });
          case "today":
            return textResult({ op, ...(await loadToday(deps)) });
          case "schedule":
            return textResult({ op, ...(await loadSchedule(deps, term)) });
          case "grades":
            return textResult({ op, ...(await loadGrades(deps, term)) });
          case "gpa":
            return textResult({ op, ...(await loadGpa(deps)) });
          case "holds":
            return textResult({ op, ...(await loadHolds(deps)) });
          case "registration":
            return textResult({ op, ...(await loadRegistration(deps)) });
          case "degree_audit":
            return textResult({ op, ...(await loadDegreeAudit(deps)) });
        }
        return unknownOp("unw_academics", op, OPS);
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
