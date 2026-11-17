import { describe, expect, it } from "vitest";
import { isSignInUrl, redactText, redactUrl, summarizeCookie } from "../src/auth/redact.js";

describe("redactUrl", () => {
  it("redacts credential query values and keeps the path", () => {
    const url = redactUrl(
      "https://flow.my.unw.edu/upstream/v1/degree-audit/degreeworks?claims=eyJhbGciOiJIUzI1NiJ9.long.token&studentId=00000000",
    );
    expect(url).toContain("/upstream/v1/degree-audit/degreeworks");
    expect(url).toContain("claims=%3Credacted%3A");
    expect(url).toContain("studentId=%3Credacted%3A");
    expect(url).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("returns non-URL text unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactText", () => {
  it("removes e-mail, JWT, bearer token and Banner id", () => {
    const text = redactText(
      "user student@example.edu id 00000000 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNlZ21lbnQ Bearer abc.def",
    );
    expect(text).not.toContain("student@example.edu");
    expect(text).not.toContain("00000000");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0");
    expect(text).toContain("[redacted-email]");
    expect(text).toContain("[redacted-id]");
    expect(text).toContain("[redacted-jwt]");
  });
});

describe("summarizeCookie", () => {
  it("reports days left for a persistent cookie", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    const summary = summarizeCookie(
      {
        name: "sessionid",
        expires: Math.floor((now + 30 * 86_400_000) / 1000),
        httpOnly: true,
        secure: true,
      },
      now,
    );
    expect(summary.daysLeft).toBe(30);
    expect(summary.httpOnly).toBe(true);
    expect(summary.expires).not.toBe("session");
  });

  it("reports a session cookie without an expiry date", () => {
    const summary = summarizeCookie(
      { name: "JSESSIONID", expires: -1, httpOnly: true, secure: true },
      Date.now(),
    );
    expect(summary.expires).toBe("session");
    expect(summary.daysLeft).toBeNull();
  });
});

describe("isSignInUrl", () => {
  it("recognizes Entra and portal login hops", () => {
    expect(isSignInUrl("https://login.microsoftonline.com/tenant/saml2")).toBe(true);
    expect(isSignInUrl("https://my.unw.edu/external/login?redirectTo=%2Fdashboard")).toBe(true);
    expect(isSignInUrl("https://my.unw.edu/api/core/saml_sso/1/")).toBe(true);
    expect(isSignInUrl("https://my.unw.edu/dashboard")).toBe(false);
  });
});
