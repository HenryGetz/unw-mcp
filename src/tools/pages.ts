/**
 * `unw_pages`: portal content pages (search and slug lookup).
 */
import { z } from "zod";
import { loadPage, loadPageSearch, type PageDeps } from "../portal/pages.js";
import {
  errorResult,
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

const OPS = ["search", "get"] as const;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function pageDeps(ctx: AppContext): PageDeps {
  return { portal: ctx.portal, cfg: ctx.cfg, cache: ctx.cache };
}

export function pagesTool(ctx: AppContext): ToolModule {
  return {
    name: "unw_pages",
    title: "myUNW pages",
    description:
      "Search myUNW content pages and read one by slug (registration, meal plans, student accounts, etc.). Bodies are plain text, capped at 4,000 chars with body_truncated/body_chars. Read-only; no directory or user search.",
    shape: {
      op: z.enum(OPS).describe("search; get"),
      query: z.string().min(2).max(120).optional().describe("search: words to find"),
      slug: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("get: page slug, e.g. registration-holds-trad"),
      limit: z.number().int().min(1).max(25).optional().describe("search: rows to return"),
      excerpt_chars: z
        .number()
        .int()
        .min(40)
        .max(400)
        .optional()
        .describe("search: excerpt length (default 120, max 400)"),
    },
    async handle(args) {
      const op = opOf(args, OPS);
      if (!op) return unknownOp("unw_pages", typeof args.op === "string" ? args.op : "", OPS);
      const deps = pageDeps(ctx);
      try {
        if (op === "search") {
          const query = stringArg(args, "query");
          if (!query) {
            return errorResult("invalid_argument", "unw_pages search requires query", "pass 2–120 characters");
          }
          const limit = pageSize(args, "limit", ctx.cfg.maxResults.pages, 25);
          const excerptChars = Math.min(
            Math.max(40, Math.trunc(numberArg(args, "excerpt_chars") ?? 120)),
            400,
          );
          return textResult({ op, ...(await loadPageSearch(deps, query, limit, excerptChars)) });
        }
        const slug = stringArg(args, "slug");
        if (!slug) {
          return errorResult("invalid_argument", "unw_pages get requires slug", "e.g. meal-plan-information");
        }
        if (!SLUG.test(slug)) {
          return errorResult(
            "invalid_argument",
            "slug must contain only letters, digits, underscore or hyphen",
            "copy the slug from unw_pages search",
          );
        }
        return textResult({ op, ...(await loadPage(deps, slug)) });
      } catch (error) {
        const mapped = toolError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
