import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import { buildTools } from "../src/tools/registry.js";
import type { AppContext, SessionApi } from "../src/tools/context.js";
import type { PortalReader } from "../src/portal/client.js";
import type { BannerApi, BannerReader } from "../src/banner/client.js";
import {
  AppSessionExpiredError,
  AuthRequiredError,
  type SessionStatus,
} from "../src/auth/session.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const NOW = new Date("2026-11-17T15:00:00Z");

const status: SessionStatus = {
  authenticated: true,
  state: "authenticated",
  checked_at: NOW.toISOString(),
  cookies: {
    portal_session: null,
    csrf: null,
    flow_session: true,
    entra_sso: true,
  },
};

const session: SessionApi = {
  status: async () => status,
  reauth: async () => status,
  dispose: async () => undefined,
};

class RoutingPortal implements PortalReader {
  constructor(
    private readonly handler: (kind: "portal" | "flow", url: string) => unknown = () => ({}),
  ) {}
  getPortalJson<T>(url: string): Promise<T> {
    return Promise.resolve(this.handler("portal", url) as T);
  }
  getFlowJson<T>(url: string): Promise<T> {
    return Promise.resolve(this.handler("flow", url) as T);
  }
}

function fakeBanner(overrides: Partial<BannerApi> = {}): BannerReader {
  const api: BannerApi = {
    getTerms: async () => [{ code: "202610", description: "Fall 2026" }],
    registrationHistory: async () => ({ data: { registrations: [] } }),
    viewGpaHours: async () => ({
      overallGpa: "3.500",
      overallHours: 30,
      gpas: [{ gpa: "3.500", hours: 30, hoursAttempted: 30, levelDesc: "Undergraduate", typeDesc: "Overall" }],
    }),
    showHolds: async () => ({ holds: [], holdCount: 0 }),
    registrationNotices: async () => ({}),
    aidYears: async () => ({ ActiveAidyears: [], CurrentActiveAidyear: {} }),
    awardInfo: async () => ({}),
    costOfAttendance: async () => ({}),
    ...overrides,
  };
  return {
    registration: async (task) => task(api),
    student: async (task) => task(api),
  };
}

type TestFetch = (input: string, init?: RequestInit) => Promise<Response>;

function context(
  portal: PortalReader = new RoutingPortal(),
  banner: BannerReader = fakeBanner(),
  fetchImpl: TestFetch = async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
): AppContext {
  return {
    cfg: config(),
    session,
    portal,
    banner,
    cache: new TtlCache(),
    now: () => NOW,
    fetch: fetchImpl,
  };
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe("tool registry", () => {
  it("exposes the phase-2 surface", () => {
    const tools = buildTools(context());
    expect(tools.map((tool) => tool.name)).toEqual([
      "unw_session",
      "unw_dashboard",
      "unw_academics",
      "unw_finances",
      "unw_dining",
      "unw_calendar",
      "unw_pages",
    ]);
  });

  it("validates op enums and bounds in every schema", () => {
    const tools = buildTools(context());
    const shape = (name: string) => tools.find((tool) => tool.name === name)!.shape;

    expect(shape("unw_session").op?.safeParse("logout").success).toBe(false);
    expect(shape("unw_session").op?.safeParse("reauth").success).toBe(true);

    const dashboard = shape("unw_dashboard");
    for (const op of ["overview", "day", "announcements", "tasks", "events", "quick_links"]) {
      expect(dashboard.op?.safeParse(op).success).toBe(true);
    }
    expect(dashboard.op?.safeParse("grades").success).toBe(false);
    expect(dashboard.limit?.safeParse(51).success).toBe(false);
    expect(dashboard.days?.safeParse(-1).success).toBe(false);

    const academics = shape("unw_academics");
    for (const op of [
      "profile",
      "today",
      "schedule",
      "grades",
      "gpa",
      "holds",
      "registration",
      "degree_audit",
    ]) {
      expect(academics.op?.safeParse(op).success).toBe(true);
    }
    expect(academics.op?.safeParse("transcript").success).toBe(false);
    expect(academics.term?.safeParse("Fall 2026").success).toBe(true);
    expect(academics.term?.safeParse("").success).toBe(false);

    const finances = shape("unw_finances");
    for (const op of ["balances", "financial_aid", "chapel"]) {
      expect(finances.op?.safeParse(op).success).toBe(true);
    }
    expect(finances.op?.safeParse("awards").success).toBe(false);
    expect(finances.aid_year?.safeParse("2627").success).toBe(true);

    const dining = shape("unw_dining");
    for (const op of ["locations", "today", "week"]) {
      expect(dining.op?.safeParse(op).success).toBe(true);
    }
    expect(dining.op?.safeParse("menu").success).toBe(false);
    expect(dining.date?.safeParse("2026-11-17").success).toBe(true);
    expect(dining.date?.safeParse("11/17/2026").success).toBe(false);
    expect(dining.meal?.safeParse("lunch").success).toBe(true);
    expect(dining.meal?.safeParse("snack").success).toBe(false);
    expect(dining.detail?.safeParse(undefined).data).toBe("brief");
    expect(dining.detail?.safeParse("full").success).toBe(true);
    expect(dining.detail?.safeParse("verbose").success).toBe(false);

    const calendar = shape("unw_calendar");
    for (const op of ["academic", "breaks", "deadlines", "events"]) {
      expect(calendar.op?.safeParse(op).success).toBe(true);
    }
    expect(calendar.op?.safeParse("today").success).toBe(false);
    expect(calendar.days?.safeParse(731).success).toBe(false);
    expect(calendar.query?.safeParse("thanksgiving").success).toBe(true);
    expect(calendar.query?.safeParse("a").success).toBe(false);

    const pages = shape("unw_pages");
    expect(pages.op?.safeParse("search").success).toBe(true);
    expect(pages.op?.safeParse("get").success).toBe(true);
    expect(pages.query?.safeParse("a").success).toBe(false);
    expect(pages.slug?.safeParse("meal-plan-information").success).toBe(true);
    expect(pages.excerpt_chars?.safeParse(120).success).toBe(true);
    expect(pages.excerpt_chars?.safeParse(500).success).toBe(false);
  });

  it("rejects a missing or unknown op as an error result", async () => {
    const tools = buildTools(context());
    for (const name of [
      "unw_dashboard",
      "unw_academics",
      "unw_finances",
      "unw_dining",
      "unw_calendar",
      "unw_pages",
    ]) {
      const tool = tools.find((item) => item.name === name)!;
      const missing = await tool.handle({});
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("requires op");

      const unknown = await tool.handle({ op: "nope" });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain("unknown op");
    }
  });

  it("dispatches session status and reauth", async () => {
    const tool = buildTools(context()).find((item) => item.name === "unw_session")!;
    const result = await tool.handle({ op: "status" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).authenticated).toBe(true);
  });

  it("dispatches an academic op through portal + Banner", async () => {
    const portal = new RoutingPortal((kind) => (kind === "portal" ? { alternate_id: "00000000" } : {}));
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_academics")!;
    const result = await tool.handle({ op: "gpa" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).overall_gpa).toBe(3.5);
    expect(textOf(result)).not.toContain("00000000");
  });

  it("dispatches a finance op through Flow", async () => {
    const portal = new RoutingPortal((kind) =>
      kind === "flow"
        ? {
            balances: [
              { name: "Student Account", amount: -12.5 },
              { name: "Dining Funds", amount: 100 },
            ],
          }
        : {},
    );
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_finances")!;
    const result = await tool.handle({ op: "balances" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).count).toBe(2);
  });

  it("dispatches dining locations from the public payload", async () => {
    const fakeFetch: TestFetch = async () =>
      new Response(
        JSON.stringify({
          campuses: { "76": { cafes: { "1": { name: "Cafe One", address: "1 Main" } } } },
          data: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const tool = buildTools(context(new RoutingPortal(), fakeBanner(), fakeFetch)).find(
      (item) => item.name === "unw_dining",
    )!;
    const result = await tool.handle({ op: "locations" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).count).toBe(1);
  });

  it("defaults calendar events to ten rows", async () => {
    const portal = new RoutingPortal((kind, url) =>
      kind === "portal" && url.includes("/api/v2/events/")
        ? {
            count: 30,
            results: Array.from({ length: 20 }, (_, index) => ({
              id: index + 1,
              title: `Event ${index + 1}`,
              start_date: "2026-11-17T15:55:00Z",
              end_date: "2026-11-17T16:35:00Z",
              all_day: false,
              location: "Room",
              calendar: { name: "Campus" },
            })),
          }
        : {},
    );
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_calendar")!;
    const result = await tool.handle({ op: "events" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).items).toHaveLength(10);
  });

  it("defaults page search to ten rows and reports truncation", async () => {
    const portal = new RoutingPortal((kind, url) =>
      kind === "portal" && url.includes("/api/v1/pages/")
        ? {
            count: 56,
            results: Array.from({ length: 20 }, (_, index) => ({
              slug: `registration-${index + 1}`,
              title: `Registration ${index + 1}`,
              body: "text",
            })),
          }
        : {},
    );
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_pages")!;
    const result = await tool.handle({ op: "search", query: "registration" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).items).toHaveLength(10);
    expect(parse(result).count).toBe(56);
    expect(parse(result).truncated).toBe(true);
  });

  it("dispatches page get and validates its arguments", async () => {
    const portal = new RoutingPortal((kind, url) =>
      kind === "portal" && url.includes("/pages/slug/")
        ? { slug: "meal-plan-information", title: "Meal Plan", body: "Details" }
        : {},
    );
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_pages")!;
    const result = await tool.handle({ op: "get", slug: "meal-plan-information" });
    expect(result.isError).toBeFalsy();
    expect(parse(result).body).toBe("Details");

    const missing = await tool.handle({ op: "search" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("requires query");
  });

  it("maps an auth failure to an auth_required tool error", async () => {
    const portal = new RoutingPortal(() => {
      throw new AuthRequiredError("session expired", "run op=reauth");
    });
    const tool = buildTools(context(portal)).find((item) => item.name === "unw_dashboard")!;
    const result = await tool.handle({ op: "overview" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("auth_required");
    expect(textOf(result)).toContain("session expired");
  });

  it("maps an expired Banner app session to auth_required", async () => {
    const banner = fakeBanner({
      viewGpaHours: async () => {
        throw new AppSessionExpiredError("HTML login");
      },
    });
    const portal = new RoutingPortal((kind) => (kind === "portal" ? { alternate_id: "00000000" } : {}));
    const tool = buildTools(context(portal, banner)).find((item) => item.name === "unw_academics")!;
    const result = await tool.handle({ op: "gpa" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("auth_required");
    expect(textOf(result)).toContain("Banner app session");
  });
});
