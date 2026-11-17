/**
 * Interpretation of an HTTP response from the portal, Flow, or Banner.
 *
 * The portal is a SAML app: when the portal session expires, API calls do not
 * return a clean 401 — the request follows redirects to Entra and returns HTML
 * with status 200. Both shapes must be classified as authentication failures,
 * while a genuine 5xx is an availability failure and must not trigger a login.
 */
import { isSignInUrl } from "./redact.js";

export type ResponseVerdict = "ok" | "auth" | "unavailable";

export interface ResponseShape {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
  /** The caller asked for JSON; an HTML 2xx then means the login shell came back. */
  expectJson: boolean;
}

export interface ResponseClassification {
  verdict: ResponseVerdict;
  /** Short, non-PII explanation for diagnostics. */
  reason: string;
}

function looksJson(contentType: string, body: string): boolean {
  if (/json/i.test(contentType)) return true;
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function classifyResponse(response: ResponseShape): ResponseClassification {
  if (response.status === 401 || response.status === 403) {
    return { verdict: "auth", reason: `HTTP ${response.status}` };
  }
  if (isSignInUrl(response.finalUrl)) {
    return { verdict: "auth", reason: "redirected to sign-in" };
  }
  if (response.status >= 500) {
    return { verdict: "unavailable", reason: `HTTP ${response.status}` };
  }
  if (response.status >= 300 && response.status < 400) {
    return { verdict: "auth", reason: `unexpected HTTP ${response.status}` };
  }
  if (response.status < 200 || response.status >= 300) {
    return { verdict: "unavailable", reason: `HTTP ${response.status}` };
  }
  if (response.expectJson && response.body.trim() !== "" && !looksJson(response.contentType, response.body)) {
    const isHtml = /html/i.test(response.contentType) || response.body.trimStart().startsWith("<");
    return isHtml
      ? { verdict: "auth", reason: "HTML where JSON was expected" }
      : { verdict: "unavailable", reason: "non-JSON payload" };
  }
  return { verdict: "ok", reason: "ok" };
}
