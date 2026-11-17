import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../src/auth/browser.js";
import {
  AppSessionExpiredError,
  AuthRequiredError,
  PortalSession,
  buildSessionStatus,
} from "../src/auth/session.js";
import { config } from "../src/config.js";

const now = Date.parse("2026-11-17T12:00:00Z");
const inDays = (days: number): number => Math.floor((now + days * 86_400_000) / 1000);

function cookie(name: string, expires: number, domain = ".my.unw.edu") {
  return {
    name,
    value: "secret-value-not-read",
    domain,
    path: "/",
    expires,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  };
}

describe("buildSessionStatus", () => {
  it("summarizes cookie lifetimes without values", () => {
    const status = buildSessionStatus({
      probe: { authenticated: true },
      cookies: {
        portal: [cookie("sessionid", inDays(30)), cookie("csrftoken", inDays(300))],
        flow: [cookie("JSESSIONID_ihub-frontend", -1, "flow.my.unw.edu")],
        entra: [cookie("ESTSAUTHPERSISTENT", inDays(80), "login.microsoftonline.com")],
      },
      now,
      authMethod: "silent-saml",
    });
    expect(status.authenticated).toBe(true);
    expect(status.state).toBe("authenticated");
    expect(status.cookies.portal_session?.daysLeft).toBe(30);
    expect(status.cookies.flow_session).toBe(true);
    expect(status.cookies.entra_sso).toBe(true);
    expect(status.auth_method).toBe("silent-saml");
    expect(JSON.stringify(status)).not.toContain("secret-value-not-read");
  });

  it("adds an actionable hint when unauthenticated", () => {
    const status = buildSessionStatus({
      probe: { authenticated: false, reason: "HTTP 401" },
      cookies: { portal: [], flow: [], entra: [] },
      now,
    });
    expect(status.authenticated).toBe(false);
    expect(status.state).toBe("unauthenticated");
    expect(status.error).toBe("HTTP 401");
    expect(status.hint).toContain("op=reauth");
  });
});

interface FakeOptions {
  status?: number;
  body?: string;
  contentType?: string;
}

function fakeBrowser(options: FakeOptions = {}): BrowserSession {
  const status = options.status ?? 200;
  const body = options.body ?? "{}";
  const contentType = options.contentType ?? "application/json";
  const ctx = {
    request: {
      get: async (url: string) => ({
        status: () => status,
        headers: () => ({ "content-type": contentType }),
        url: () => url,
        text: async () => body,
      }),
    },
    cookies: async (urls: string | string[]) => {
      const list = Array.isArray(urls) ? urls : [urls];
      const cookies = [cookie("sessionid", inDays(30))];
      if (list.some((url) => url.includes("login.microsoftonline.com"))) {
        cookies.push(cookie("ESTSAUTHPERSISTENT", inDays(80), "login.microsoftonline.com"));
      }
      if (list.some((url) => url.includes("flow.my.unw.edu"))) {
        cookies.push(cookie("JSESSIONID_ihub-frontend", -1, "flow.my.unw.edu"));
      }
      return cookies;
    },
    clearCookies: async () => undefined,
    close: async () => undefined,
  };
  return { ctx, page: {} } as unknown as BrowserSession;
}

/** Each session gets its own profile dir so the cross-process lock never collides. */
function sessionFor(browser: BrowserSession): PortalSession {
  const profileDir = join(mkdtempSync(join(tmpdir(), "unw-mcp-session-test-")), "browser-profile");
  return new PortalSession({
    config: { ...config(), profileDir },
    launcher: async () => browser,
    now: () => now,
    log: () => undefined,
  });
}

describe("PortalSession", () => {
  it("reports status from the live probe and cookie jar", async () => {
    const session = sessionFor(fakeBrowser());
    try {
      const status = await session.status();
      expect(status.authenticated).toBe(true);
      expect(status.cookies.portal_session?.daysLeft).toBe(30);
      expect(status.cookies.entra_sso).toBe(true);
      expect(status.cookies.flow_session).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("reports an unauthenticated probe without throwing", async () => {
    const session = sessionFor(fakeBrowser({ status: 401, body: "" }));
    try {
      const status = await session.status();
      expect(status.authenticated).toBe(false);
      expect(status.error).toContain("401");
    } finally {
      await session.dispose();
    }
  });

  it("redoes a Banner SAML handshake once when an app session expires", async () => {
    let url = "https://my.unw.edu/dashboard";
    const cleared: string[] = [];
    const browser = {
      ctx: {
        request: {
          get: async (target: string) => ({
            status: () => 200,
            headers: () => ({ "content-type": "application/json" }),
            url: () => target,
            text: async () => "{}",
          }),
        },
        cookies: async () => [],
        clearCookies: async ({ domain }: { domain: string }) => {
          cleared.push(domain);
        },
        close: async () => undefined,
      },
      page: {
        goto: async (target: string) => {
          url = target;
        },
        url: () => url,
        waitForTimeout: async () => undefined,
        evaluate: async () => ({}),
      },
    } as unknown as BrowserSession;
    const session = sessionFor(browser);
    try {
      let attempts = 0;
      const value = await session.withAppSession(
        "https://student-ss.oci.unw.edu",
        "/StudentSelfService/ssb/studentProfile",
        async () => {
          attempts += 1;
          if (attempts === 1) throw new AppSessionExpiredError("HTML login");
          return "ok";
        },
      );
      expect(value).toBe("ok");
      expect(attempts).toBe(2);
      expect(cleared).toEqual(["student-ss.oci.unw.edu"]);
    } finally {
      await session.dispose();
    }
  });

  it("converts a second Banner app-session failure to auth_required", async () => {
    let url = "https://my.unw.edu/dashboard";
    const browser = {
      ctx: {
        request: {
          get: async (target: string) => ({
            status: () => 200,
            headers: () => ({ "content-type": "application/json" }),
            url: () => target,
            text: async () => "{}",
          }),
        },
        cookies: async () => [],
        clearCookies: async () => undefined,
        close: async () => undefined,
      },
      page: {
        goto: async (target: string) => {
          url = target;
        },
        url: () => url,
        waitForTimeout: async () => undefined,
        evaluate: async () => ({}),
      },
    } as unknown as BrowserSession;
    const session = sessionFor(browser);
    try {
      await expect(
        session.withAppSession(
          "https://registration-ss.oci.unw.edu",
          "/StudentRegistrationSsb/ssb/registration/registerPostSignIn?mode=registration",
          async () => {
            throw new AppSessionExpiredError("HTML login");
          },
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError);
    } finally {
      await session.dispose();
    }
  });

  it("fetches Banner JSON through page.evaluate", async () => {
    let evaluated = 0;
    const fake = {
      ctx: {
        request: {
          get: async () => {
            throw new Error("browserContext.request must not be used for Banner");
          },
        },
        cookies: async () => [],
        clearCookies: async () => undefined,
        close: async () => undefined,
      },
      page: {
        evaluate: async (_fn: unknown, url: string) => {
          evaluated += 1;
          return {
            status: 200,
            contentType: "application/json",
            finalUrl: url,
            body: '{"overallGpa":"3.5"}',
          };
        },
      },
    } as unknown as BrowserSession;
    const session = sessionFor(fake);
    try {
      const body = await session.getPageJson<{ overallGpa: string }>(
        "https://student-ss.oci.unw.edu/StudentSelfService/studentProfile/viewGPAHoursList",
      );
      expect(body.overallGpa).toBe("3.5");
      expect(evaluated).toBe(1);
    } finally {
      await session.dispose();
    }
  });

  it("serializes concurrent authenticated calls", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const gates: Array<() => void> = [];
    const response = {
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      url: () => "https://my.unw.edu/api/v1/users/me/",
      text: async () => "{}",
    };
    const gated = {
      ctx: {
        request: {
          get: async () => {
            started += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => {
              gates.push(() => {
                active -= 1;
                resolve();
              });
            });
            return response;
          },
        },
        cookies: async () => [],
        clearCookies: async () => undefined,
        close: async () => undefined,
      },
      page: {},
    } as unknown as BrowserSession;
    const session = sessionFor(gated);
    try {
      const url = "https://my.unw.edu/api/v1/users/me/";
      const results = Promise.all([
        session.getJson<Record<string, unknown>>(url),
        session.getJson<Record<string, unknown>>(url),
        session.getJson<Record<string, unknown>>(url),
      ]);
      for (let index = 0; index < 3; index += 1) {
        const expected = index + 1;
        await vi.waitFor(() => expect(started).toBe(expected), { timeout: 2000 });
        expect(active).toBe(1);
        gates.shift()?.();
      }
      expect(await results).toHaveLength(3);
      expect(maxActive).toBe(1);
    } finally {
      await session.dispose();
    }
  });
});
