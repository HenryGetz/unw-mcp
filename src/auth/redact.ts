/**
 * Redaction for logs and error text.
 *
 * The portal deals in names, e-mail addresses, Banner ids, balances and a
 * short-lived degree-audit JWT. None of those may reach stdout/stderr, a tool
 * error, or the repository. Tool *data* is returned to the caller; this module
 * is only for diagnostics.
 */

const SECRET_QUERY_KEYS = [
  "code",
  "id_token",
  "access_token",
  "refresh_token",
  "state",
  "SAMLRequest",
  "SAMLResponse",
  "RelayState",
  "session",
  "token",
  "ticket",
  "claims",
  "studentId",
  "bannerId",
];

/** Redact query values that carry credentials, keeping their length as a hint. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of SECRET_QUERY_KEYS) {
      const value = url.searchParams.get(key);
      if (value !== null) url.searchParams.set(key, `<redacted:${value.length}>`);
    }
    return url.toString();
  } catch {
    return String(rawUrl);
  }
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BANNER_ID = /\b0\d{7}\b/g;

/** Strip PII/secrets from a diagnostic string. Does not alter tool payloads. */
export function redactText(value: string): string {
  return String(value)
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT, "[redacted-jwt]")
    .replace(EMAIL, "[redacted-email]")
    .replace(BANNER_ID, "[redacted-id]");
}

export interface CookieSummary {
  name: string;
  expires: string;
  daysLeft: number | null;
  httpOnly: boolean;
  secure: boolean;
}

/** Cookie inventory without values. Session cookies report `null` days left. */
export function summarizeCookie(cookie: {
  name: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}, now = Date.now()): CookieSummary {
  const session = cookie.expires <= 0;
  return {
    name: cookie.name,
    expires: session ? "session" : new Date(cookie.expires * 1000).toISOString(),
    daysLeft: session ? null : Math.round((cookie.expires * 1000 - now) / 86_400_000),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  };
}

/** True when a URL is an interactive sign-in page rather than portal content. */
export function isSignInUrl(url: string): boolean {
  return /login\.(microsoftonline|live)\.com|login\.microsoft\.com|\/external\/login|\/api\/core\/saml_sso\//i.test(
    url,
  );
}
