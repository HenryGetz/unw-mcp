/**
 * Finance projections and loaders: account balances, chapel credit, and
 * financial-aid award/cost rows.
 *
 * Amounts are passed through as numbers when the upstream value is numeric.
 * No student id, name or alternate id leaves these functions.
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import type { BannerReader } from "../banner/client.js";
import type { PortalReader } from "./client.js";
import { dict, list, money, numeric, round1, text } from "./values.js";

export interface FinanceDeps {
  portal: PortalReader;
  banner: BannerReader;
  cfg: ResolvedConfig;
  cache: TtlCache;
  now?: () => Date;
}

export interface BalanceRow {
  name: string;
  amount?: number | string;
}

export interface BalancesResult {
  count: number;
  accounts: BalanceRow[];
}

export function projectBalances(raw: unknown): BalancesResult {
  const accounts = list(dict(raw).balances).flatMap((entry): BalanceRow[] => {
    const account = dict(entry);
    const name = text(account.name);
    if (!name) return [];
    const amount = money(account.amount);
    return [{ name, ...(amount !== undefined ? { amount } : {}) }];
  });
  return { count: accounts.length, accounts };
}

export interface ChapelResult {
  credits_earned?: number;
  credits_required?: number;
  remaining?: number;
  percent?: number;
  period?: string;
  updated?: string;
  as_of?: string;
}

export function projectChapel(raw: unknown): ChapelResult {
  const summary = dict(raw);
  const info = dict(summary.responseInfo);
  const earned = numeric(info.credits_earned);
  const required = numeric(info.credits_required);
  const remaining =
    earned !== undefined && required !== undefined ? Math.max(0, required - earned) : undefined;
  const percent =
    earned !== undefined && required !== undefined && required > 0
      ? round1((earned / required) * 100)
      : undefined;
  const updated = text(info.modified_date)?.replace(" ", "T").slice(0, 19);
  const when = numeric(summary.when);
  return {
    ...(earned !== undefined ? { credits_earned: earned } : {}),
    ...(required !== undefined ? { credits_required: required } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(text(info.period_description) ? { period: text(info.period_description) } : {}),
    ...(updated ? { updated } : {}),
    ...(when !== undefined ? { as_of: new Date(when).toISOString() } : {}),
  };
}

export interface AidYearRow {
  code: string;
  period: string;
}

export interface AidYearsProjection {
  years: AidYearRow[];
  current?: string;
}

export function projectAidYears(raw: unknown): AidYearsProjection {
  const body = dict(raw);
  const years = list(body.ActiveAidyears).flatMap((entry): AidYearRow[] => {
    const year = dict(entry);
    const code = text(year.aidyCode);
    if (!code) return [];
    return [{ code, period: text(year.period) ?? code }];
  });
  const current = text(dict(body.CurrentActiveAidyear).aidyCode);
  return { years, ...(current ? { current } : {}) };
}

export function resolveAidYear(
  input: string | undefined,
  years: AidYearRow[],
  current: string | undefined,
): AidYearRow | undefined {
  const clean = input?.trim();
  if (!clean) {
    return years.find((year) => year.code === current) ?? years[0];
  }
  const lower = clean.toLowerCase();
  return (
    years.find((year) => year.code === lower) ??
    years.find((year) => year.period.toLowerCase() === lower) ??
    years.find((year) => year.period.toLowerCase().includes(lower)) ?? { code: clean, period: clean }
  );
}

export interface AwardRow {
  fund: string;
  code?: string;
  type?: string;
  period?: string;
  amount?: number;
  offered?: number;
  status?: string;
}

export interface CostRow {
  description: string;
  amount?: number;
  period?: string;
  category?: string;
  billable?: boolean;
}

export interface FinancialAidResult {
  status: "ok" | "not_exposed";
  aid_year?: AidYearRow;
  available_years: AidYearRow[];
  award_count: number;
  awards: AwardRow[];
  totals_by_period: Record<string, number>;
  cost: CostRow[];
  cost_total?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function projectFinancialAid(
  rawAward: unknown,
  rawCost: unknown,
  aidYear: AidYearRow | undefined,
  availableYears: AidYearRow[],
): FinancialAidResult {
  if (!aidYear?.code) {
    return {
      status: "not_exposed",
      available_years: availableYears,
      award_count: 0,
      awards: [],
      totals_by_period: {},
      cost: [],
    };
  }
  const awardBody = dict(rawAward);
  const awardRows = list(dict(awardBody.awardInfo).data).length > 0
    ? list(dict(awardBody.awardInfo).data)
    : list(awardBody.data);
  const awards = awardRows.slice(0, 40).flatMap((entry): AwardRow[] => {
    const award = dict(entry);
    const fund = text(award.fundTitle);
    if (!fund) return [];
    const amount =
      numeric(award.activeAmount) ??
      numeric(award.periodOfferAmt) ??
      numeric(award.amt) ??
      numeric(award.awrdOfferAmt);
    const offered = numeric(award.awrdOfferAmt);
    return [
      {
        fund,
        ...(text(award.fundCode) ? { code: text(award.fundCode) } : {}),
        ...(text(award.fundType) ? { type: text(award.fundType) } : {}),
        ...(text(award.periodDesc) ? { period: text(award.periodDesc) } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(offered !== undefined ? { offered } : {}),
        ...(text(award.activeStatus) ?? text(award.status)
          ? { status: text(award.activeStatus) ?? text(award.status) }
          : {}),
      },
    ];
  });

  const totals: Record<string, number> = {};
  for (const award of awards) {
    if (award.amount === undefined) continue;
    const key = award.period ?? "total";
    totals[key] = round2((totals[key] ?? 0) + award.amount);
  }

  const cost = list(dict(rawCost).data).slice(0, 30).flatMap((entry): CostRow[] => {
    const row = dict(entry);
    const description = text(row.longDesc);
    if (!description) return [];
    const amount = numeric(row.amount);
    return [
      {
        description,
        ...(amount !== undefined ? { amount } : {}),
        ...(text(row.periodDesc) ? { period: text(row.periodDesc) } : {}),
        ...(text(row.bcatCode) ? { category: text(row.bcatCode) } : {}),
        ...(row.billableInd !== undefined ? { billable: String(row.billableInd).toUpperCase() === "Y" } : {}),
      },
    ];
  });
  const costTotal = cost.reduce((sum, row) => sum + (row.amount ?? 0), 0);

  return {
    status: "ok",
    aid_year: aidYear,
    available_years: availableYears,
    award_count: awardRows.length,
    awards,
    totals_by_period: totals,
    cost,
    ...(cost.length > 0 ? { cost_total: round2(costTotal) } : {}),
  };
}

export async function loadBalances(deps: FinanceDeps): Promise<BalancesResult> {
  return deps.cache.get("fin:balances", deps.cfg.cache.balancesTtlSeconds, async () => {
    const raw = await deps.portal.getFlowJson<unknown>("/upstream/v1/balances");
    return projectBalances(raw);
  });
}

export async function loadChapel(deps: FinanceDeps): Promise<ChapelResult> {
  return deps.cache.get("fin:chapel", deps.cfg.cache.chapelTtlSeconds, async () => {
    const raw = await deps.portal.getFlowJson<unknown>("/upstream/chapel_summary");
    return projectChapel(raw);
  });
}

export async function loadFinancialAid(
  deps: FinanceDeps,
  aidYearInput?: string,
): Promise<FinancialAidResult> {
  const key = `fin:aid:${aidYearInput?.trim().toLowerCase() ?? "current"}`;
  return deps.cache.get(key, deps.cfg.cache.financialAidTtlSeconds, async () => {
    const bundle = await deps.banner.student(async (api) => {
      const yearsProjection = projectAidYears(await api.aidYears());
      const year = resolveAidYear(aidYearInput, yearsProjection.years, yearsProjection.current);
      if (!year?.code) {
        return { years: yearsProjection.years, year: undefined, award: undefined, cost: undefined };
      }
      const award = await api.awardInfo(year.code);
      const cost = await api.costOfAttendance(year.code);
      return { years: yearsProjection.years, year, award, cost };
    });
    return projectFinancialAid(bundle.award, bundle.cost, bundle.year, bundle.years);
  });
}
