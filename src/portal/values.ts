/**
 * Tolerant accessors for upstream JSON.
 *
 * Portal, Flow and Banner payloads are untyped and drift between versions.
 * These helpers turn `unknown` into the narrow shapes the projections need
 * without throwing on a missing field.
 */
export type Dict = Record<string, unknown>;

export function dict(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Round to one decimal; `72.933334` -> `72.9`. */
export function round1(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 10) / 10;
}

/** Keep a money value numeric when possible, otherwise the upstream string. */
export function money(value: unknown): number | string | undefined {
  const parsed = numeric(value);
  return parsed !== undefined ? parsed : text(value);
}
