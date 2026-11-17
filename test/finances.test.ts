import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import type { BannerApi, BannerReader } from "../src/banner/client.js";
import type { PortalReader } from "../src/portal/client.js";
import {
  loadBalances,
  loadChapel,
  loadFinancialAid,
  projectAidYears,
  projectBalances,
  projectChapel,
  projectFinancialAid,
  resolveAidYear,
  type FinanceDeps,
} from "../src/portal/finances.js";

const NOW = new Date("2026-11-17T15:00:00Z");

const yearsRaw = {
  ActiveAidyears: [
    { aidyCode: "2627", period: "2026-2027 Award Year", aidyEndYear: 2027 },
    { aidyCode: "2526", period: "2025-2026 Award Year", aidyEndYear: 2026 },
  ],
  CurrentActiveAidyear: { aidyCode: "2627", period: "2026-2027 Award Year", aidyEndYear: 2027 },
};

const awardRaw = {
  awardInfo: {
    data: [
      {
        periodDesc: "Fall 2026",
        fundCode: "1104",
        fundTitle: "UNW Grant",
        awrdOfferAmt: "1000",
        activeAmount: "500",
        periodOfferAmt: "500",
        fundType: "GRNT",
        activeStatus: "ACCEPTED",
        status: "Accepted",
      },
      {
        periodDesc: "Fall 2026",
        fundCode: "9001",
        fundTitle: "Federal Loan",
        awrdOfferAmt: "750",
        activeAmount: "375",
        fundType: "LOAN",
        activeStatus: "OFFERED",
      },
      {
        periodDesc: "Spring 2027",
        fundCode: "1104",
        fundTitle: "UNW Grant",
        awrdOfferAmt: "1000",
        activeAmount: "500",
        fundType: "GRNT",
        activeStatus: "ACCEPTED",
      },
    ],
  },
};

const costRaw = {
  data: [
    { longDesc: "Tuition", amount: "10000", periodDesc: "Fall 2026", bcatCode: "TUIT", billableInd: "Y" },
    { longDesc: "Housing", amount: "2000", periodDesc: "Fall 2026", bcatCode: "HOUS", billableInd: "Y" },
    { longDesc: "Books", amount: "100", periodDesc: "Fall 2026", bcatCode: "BOOK", billableInd: "N" },
  ],
};

class FakePortal implements PortalReader {
  readonly calls: string[] = [];
  constructor(private readonly handler: (url: string) => unknown) {}
  getPortalJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler(url) as T);
  }
  getFlowJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler(url) as T);
  }
}

class FakeBanner implements BannerReader {
  readonly calls: string[] = [];
  constructor(
    private readonly fixtures: {
      years?: unknown;
      award?: unknown;
      cost?: unknown;
    } = {},
  ) {}

  private api(): BannerApi {
    return {
      getTerms: async () => [],
      registrationHistory: async () => ({}),
      viewGpaHours: async () => ({}),
      showHolds: async () => ({}),
      registrationNotices: async () => ({}),
      aidYears: async () => {
        this.calls.push("aid_years");
        return this.fixtures.years ?? yearsRaw;
      },
      awardInfo: async (aidy) => {
        this.calls.push(`award:${aidy}`);
        return this.fixtures.award ?? awardRaw;
      },
      costOfAttendance: async (aidy) => {
        this.calls.push(`cost:${aidy}`);
        return this.fixtures.cost ?? costRaw;
      },
    };
  }

  registration<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }

  student<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }
}

function deps(portal: PortalReader, banner: BannerReader, cache = new TtlCache()): FinanceDeps {
  return { portal, banner, cfg: config(), cache, now: () => NOW };
}

describe("balance projection", () => {
  it("projects account names and numeric amounts", () => {
    const result = projectBalances({
      alternate_id: "00000000",
      balances: [
        { name: "Student Account", amount: -12.5 },
        { name: "Dining Funds", amount: 125 },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.accounts[1]).toEqual({ name: "Dining Funds", amount: 125 });
    expect(JSON.stringify(result)).not.toContain("00000000");
  });
});

describe("chapel projection", () => {
  it("computes remaining credit and percent", () => {
    const chapel = projectChapel({
      when: 1794929854833,
      responseInfo: {
        alternate_id: "00000000",
        credits_earned: 8,
        credits_required: 20,
        modified_date: "2026-11-16 19:04:41.825237",
        period_description: "Fall 2026 Quad 2",
      },
    });
    expect(chapel.credits_earned).toBe(8);
    expect(chapel.credits_required).toBe(20);
    expect(chapel.remaining).toBe(12);
    expect(chapel.percent).toBe(40);
    expect(chapel.period).toBe("Fall 2026 Quad 2");
    expect(chapel.updated).toBe("2026-11-16T19:04:41");
  });

  it("omits percentage when no requirement is set", () => {
    const chapel = projectChapel({ responseInfo: { credits_earned: 3, credits_required: 0 } });
    expect(chapel.remaining).toBe(0);
    expect(chapel.percent).toBeUndefined();
  });
});

describe("financial aid projection", () => {
  it("projects aid years and resolves a code or label", () => {
    const years = projectAidYears(yearsRaw);
    expect(years.current).toBe("2627");
    expect(years.years).toHaveLength(2);
    expect(resolveAidYear(undefined, years.years, years.current)?.code).toBe("2627");
    expect(resolveAidYear("2025-2026", years.years, years.current)?.code).toBe("2526");
    expect(resolveAidYear("2526", years.years, years.current)?.code).toBe("2526");
  });

  it("projects awards, per-period totals and cost rows", () => {
    const years = projectAidYears(yearsRaw);
    const aid = projectFinancialAid(awardRaw, costRaw, years.years[0], years.years);
    expect(aid.status).toBe("ok");
    expect(aid.aid_year?.code).toBe("2627");
    expect(aid.award_count).toBe(3);
    expect(aid.awards[0]?.fund).toBe("UNW Grant");
    expect(aid.awards[0]?.amount).toBe(500);
    expect(aid.awards[0]?.offered).toBe(1000);
    expect(aid.totals_by_period["Fall 2026"]).toBe(875);
    expect(aid.totals_by_period["Spring 2027"]).toBe(500);
    expect(aid.cost).toHaveLength(3);
    expect(aid.cost_total).toBe(12100);
    expect(aid.cost[2]?.billable).toBe(false);
    expect(JSON.stringify(aid)).not.toContain("alternate_id");
  });

  it("returns not_exposed when no aid year exists", () => {
    const aid = projectFinancialAid({}, {}, undefined, []);
    expect(aid.status).toBe("not_exposed");
    expect(aid.award_count).toBe(0);
    expect(aid.cost).toEqual([]);
  });
});

describe("finance loaders", () => {
  it("loads balances and caches them", async () => {
    const portal = new FakePortal(() => ({
      balances: [
        { name: "Student Account", amount: -12.5 },
        { name: "Dining Funds", amount: 100 },
      ],
    }));
    const d = deps(portal, new FakeBanner());
    const first = await loadBalances(d);
    const second = await loadBalances(d);
    expect(first.count).toBe(2);
    expect(second.accounts[1]?.amount).toBe(100);
    expect(portal.calls).toHaveLength(1);
  });

  it("loads chapel credit", async () => {
    const portal = new FakePortal(() => ({
      when: 1794929854833,
      responseInfo: { credits_earned: 8, credits_required: 20, period_description: "Fall 2026 Quad 2" },
    }));
    const result = await loadChapel(deps(portal, new FakeBanner()));
    expect(result.remaining).toBe(12);
    expect(result.percent).toBe(40);
  });

  it("loads the current aid year by default in one Banner session", async () => {
    const banner = new FakeBanner();
    const result = await loadFinancialAid(deps(new FakePortal(() => ({})), banner));
    expect(result.status).toBe("ok");
    expect(result.aid_year?.code).toBe("2627");
    expect(banner.calls).toEqual(["aid_years", "award:2627", "cost:2627"]);
  });

  it("honors a requested aid year", async () => {
    const banner = new FakeBanner();
    const result = await loadFinancialAid(deps(new FakePortal(() => ({})), banner), "2025-2026");
    expect(result.aid_year?.code).toBe("2526");
    expect(banner.calls).toEqual(["aid_years", "award:2526", "cost:2526"]);
  });

  it("caches the aid bundle per year", async () => {
    const banner = new FakeBanner();
    const d = deps(new FakePortal(() => ({})), banner);
    await loadFinancialAid(d);
    await loadFinancialAid(d);
    expect(banner.calls).toEqual(["aid_years", "award:2627", "cost:2627"]);
  });
});
