/**
 * Portal session lifecycle.
 *
 * One headless persistent Chromium context owns the SAML session. Every browser
 * operation is serialized through one in-process mutex (Playwright contexts are
 * not concurrency-safe). Authenticated calls that fail with a login redirect are
 * retried exactly once after a silent SAML re-auth; only if that fails does the
 * credential + TOTP driver run.
 *
 * Read-only: this module issues GET/HEAD requests and navigations only.
 */
import type { BrowserContext, Page } from "playwright";
import type { ResolvedConfig } from "../config.js";
import {
  launchBrowser,
  portalReady,
  driveSignIn,
  SignInError,
  type BrowserSession,
  type LaunchOptions,
} from "./browser.js";
import { readCredentials, CredentialsError, type Credentials } from "./credentials.js";
import { acquireFileLock, LockTimeoutError } from "./lock.js";
import { classifyResponse } from "./response.js";
import { isSignInUrl, redactText, summarizeCookie, type CookieSummary } from "./redact.js";

export const DASHBOARD_URL = "https://my.unw.edu/dashboard";

export interface CookieLike {
  name: string;
  domain: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface SessionProbe {
  authenticated: boolean;
  reason?: string;
}

export interface CookieInventory {
  portal: CookieLike[];
  flow: CookieLike[];
  entra: CookieLike[];
}

export interface SessionStatus {
  authenticated: boolean;
  state: "authenticated" | "unauthenticated";
  checked_at: string;
  auth_method?: "warm-profile" | "silent-saml" | "credentials";
  cookies: {
    portal_session: CookieSummary | null;
    csrf: CookieSummary | null;
    flow_session: boolean;
    entra_sso: boolean;
  };
  last_reauth_at?: string;
  error?: string;
  hint?: string;
}

/**
 * Turn the probe and cookie jar into the compact status object. Pure, so the
 * session's observable state is testable without a browser.
 */
export function buildSessionStatus(input: {
  probe: SessionProbe;
  cookies: CookieInventory;
  now: number;
  authMethod?: SessionStatus["auth_method"];
  lastReauthAt?: string;
  lastError?: string;
}): SessionStatus {
  const portalCookie = (name: string): CookieSummary | null => {
    const cookie = input.cookies.portal.find((candidate) => candidate.name === name);
    return cookie ? summarizeCookie(cookie, input.now) : null;
  };
  const authenticated = input.probe.authenticated;
  return {
    authenticated,
    state: authenticated ? "authenticated" : "unauthenticated",
    checked_at: new Date(input.now).toISOString(),
    ...(input.authMethod ? { auth_method: input.authMethod } : {}),
    cookies: {
      portal_session: portalCookie("sessionid"),
      csrf: portalCookie("csrftoken"),
      flow_session: input.cookies.flow.some((cookie) => /JSESSIONID/i.test(cookie.name)),
      entra_sso: input.cookies.entra.some((cookie) => cookie.name === "ESTSAUTHPERSISTENT"),
    },
    ...(input.lastReauthAt ? { last_reauth_at: input.lastReauthAt } : {}),
    ...(!authenticated ? { error: input.lastError ?? input.probe.reason ?? "not authenticated" } : {}),
    ...(!authenticated
      ? { hint: "run unw_session op=reauth to sign in with the stored profile or credentials" }
      : {}),
  };
}

export class AuthRequiredError extends Error {
  readonly code = "auth_required";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class PortalUnavailableError extends Error {
  readonly code = "unavailable";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PortalUnavailableError";
  }
}

/**
 * A Banner app session (registration-ss / student-ss) answered with a login
 * redirect or HTML. `withAppSession` clears that app's cookies and redoes the
 * SAML handshake exactly once.
 */
export class AppSessionExpiredError extends Error {
  readonly code = "app_session_expired";
  constructor(readonly reason: string) {
    super(`Banner app session expired (${reason})`);
    this.name = "AppSessionExpiredError";
  }
}

export type BrowserLauncher = (options: LaunchOptions) => Promise<BrowserSession>;

export interface PortalSessionOptions {
  config: ResolvedConfig;
  launcher?: BrowserLauncher;
  credentialsLoader?: () => Credentials;
  now?: () => number;
  log?: (message: string) => void;
}

interface RawResponse {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
  expectJson: boolean;
}

export class PortalSession {
  private readonly cfg: ResolvedConfig;
  private readonly launcher: BrowserLauncher;
  private readonly credentialsLoader: () => Credentials;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private browser: BrowserSession | undefined;
  private releaseLock: (() => Promise<void>) | undefined;
  private disposed = false;
  private lastReauthAt: string | undefined;
  private lastError: string | undefined;
  private authMethod: SessionStatus["auth_method"];

  /** Tail of the serialization queue; never rejects. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: PortalSessionOptions) {
    this.cfg = options.config;
    this.launcher = options.launcher ?? launchBrowser;
    this.credentialsLoader = options.credentialsLoader ?? (() => readCredentials());
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** Run `task` after every previously queued browser operation. */
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const gate = Promise.withResolvers<void>();
    this.tail = gate.promise;
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      gate.resolve();
    }
  }

  private async launchLocked(): Promise<BrowserSession> {
    if (this.disposed) throw new PortalUnavailableError("session has been disposed");
    if (this.browser) return this.browser;
    const lockPath = `${this.cfg.profileDir}.lock`;
    this.releaseLock = await acquireFileLock(lockPath);
    try {
      this.browser = await this.launcher({
        headless: this.cfg.headless,
        profileDir: this.cfg.profileDir,
        timezone: this.cfg.timezone,
      });
      this.log("[session] browser launched");
      return this.browser;
    } catch (error) {
      await this.releaseLock().catch(() => undefined);
      this.releaseLock = undefined;
      throw error;
    }
  }

  private async rawGetLocked(url: string, expectJson: boolean): Promise<RawResponse> {
    const browser = await this.launchLocked();
    const response = await browser.ctx.request.get(url, {
      timeout: this.cfg.requestTimeoutMs,
      headers: { Accept: "application/json, */*" },
      failOnStatusCode: false,
      maxRedirects: 10,
    });
    return {
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      finalUrl: response.url(),
      body: await response.text(),
      expectJson,
    };
  }

  /**
   * Same-origin GET in the browser page, so Banner's per-app cookies are used.
   * The page must already be on the target origin (phase 2 navigates first).
   */
  private async pageGetLocked(url: string): Promise<RawResponse> {
    const browser = await this.launchLocked();
    const result = await browser.page.evaluate(async (target) => {
      const response = await fetch(target, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json, */*" },
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        finalUrl: response.url,
        body: await response.text(),
      };
    }, url);
    return { ...result, expectJson: true };
  }

  private async probeLocked(): Promise<SessionProbe> {
    try {
      const response = await this.rawGetLocked(
        `${this.cfg.portalOrigin}/api/v1/users/me/`,
        true,
      );
      const classification = classifyResponse(response);
      if (classification.verdict === "ok") return { authenticated: true };
      return { authenticated: false, reason: classification.reason };
    } catch (error) {
      return { authenticated: false, reason: redactText((error as Error).message).slice(0, 200) };
    }
  }

  private async inventoryLocked(): Promise<CookieInventory> {
    const browser = await this.launchLocked();
    const read = async (urls: string[]): Promise<CookieLike[]> => {
      const cookies = await browser.ctx.cookies(urls).catch(() => []);
      return cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
      }));
    };
    const [portal, flow, entra] = await Promise.all([
      read([this.cfg.portalOrigin]),
      read([this.cfg.flowOrigin]),
      read(["https://login.microsoftonline.com"]),
    ]);
    return { portal, flow, entra };
  }

  private async clearPortalCookiesLocked(): Promise<void> {
    const browser = await this.launchLocked();
    await browser.ctx.clearCookies({ domain: "my.unw.edu" }).catch(() => undefined);
    await browser.ctx.clearCookies({ domain: ".my.unw.edu" }).catch(() => undefined);
  }

  /** Navigate to the dashboard and poll until the Angular shell is authenticated. */
  private async navigateDashboardLocked(): Promise<boolean> {
    const browser = await this.launchLocked();
    await browser.page
      .goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: this.cfg.navigationTimeoutMs })
      .catch(() => undefined);
    const deadline = this.now() + this.cfg.reauthTimeoutMs;
    while (this.now() < deadline) {
      if (await portalReady(browser.page)) return true;
      await browser.page.waitForTimeout(500);
    }
    return portalReady(browser.page);
  }

  /**
   * Restore a portal session.
   *
   * 1. reload the dashboard — usually a silent SAML round trip via the Entra
   *    "stay signed in" cookie (~7–11 s);
   * 2. if that fails, drop only the portal cookies and reload to force SAML;
   * 3. if Entra has also expired, run e-mail + password + TOTP.
   */
  private async reauthenticateLocked(reason: string): Promise<void> {
    this.log(`[session] re-authenticating (${redactText(reason)})`);
    let method: SessionStatus["auth_method"] = "silent-saml";
    let ready = await this.navigateDashboardLocked();
    if (!ready) {
      await this.clearPortalCookiesLocked();
      ready = await this.navigateDashboardLocked();
    }
    if (!ready) {
      method = "credentials";
      let cred: Credentials;
      try {
        cred = this.credentialsLoader();
      } catch (error) {
        const message =
          error instanceof CredentialsError ? error.message : "credentials unavailable";
        throw new AuthRequiredError(
          `silent sign-in failed and ${message}`,
          error instanceof CredentialsError ? error.hint : undefined,
        );
      }
      const browser = await this.launchLocked();
      this.log("[session] credential fallback");
      const result = await driveSignIn(browser.page, {
        cred,
        until: () => portalReady(browser.page),
        log: this.log,
      });
      if (!result.ok) {
        throw new AuthRequiredError(
          `sign-in failed (${result.reason})`,
          "verify the credentials file and TOTP secret; no password retry is attempted",
        );
      }
      await browser.page.waitForTimeout(1500);
      ready = await portalReady(browser.page);
    }
    if (!ready) {
      throw new AuthRequiredError(
        "portal did not reach an authenticated dashboard",
        "the portal may be down; retry later or run the recon login script",
      );
    }
    const probe = await this.probeLocked();
    if (!probe.authenticated) {
      throw new AuthRequiredError(
        `session probe failed after sign-in (${probe.reason ?? "unknown"})`,
        "retry unw_session op=reauth",
      );
    }
    this.authMethod = method;
    this.lastReauthAt = new Date(this.now()).toISOString();
    this.lastError = undefined;
    this.log(`[session] signed in via ${method}`);
  }

  /**
   * GET JSON from a portal/Flow URL, retrying once after re-auth when the
   * response is a login redirect, a 401/403, or HTML where JSON was expected.
   */
  async getJson<T>(url: string): Promise<T> {
    return this.exclusive(async () => {
      await this.launchLocked();
      return this.getJsonVia(() => this.rawGetLocked(url, true));
    });
  }

  /**
   * GET JSON through `page.evaluate(fetch)`.
   *
   * Banner Self-Service apps (`registration-ss`, `student-ss`) issue their own
   * SAML sessions; their cookies are attached by the page's own cookie jar, so
   * the call must originate inside the page, not from `browserContext.request`.
   * Used by phase 2 (schedule, grades, holds, GPA, aid).
   */
  async getPageJson<T>(url: string): Promise<T> {
    return this.exclusive(async () => {
      await this.launchLocked();
      return this.getJsonVia(() => this.pageGetLocked(url));
    });
  }

  /** Shared auth-retry + parse path; caller holds the mutex. */
  private async getJsonVia<T>(read: () => Promise<RawResponse>): Promise<T> {
    let response = await read();
    let classification = classifyResponse(response);
    if (classification.verdict === "auth") {
      await this.reauthenticateLocked(classification.reason);
      response = await read();
      classification = classifyResponse(response);
    }
    if (classification.verdict === "auth") {
      this.lastError = classification.reason;
      throw new AuthRequiredError(
        `portal session is not authenticated (${classification.reason})`,
        "run unw_session op=reauth",
      );
    }
    if (classification.verdict === "unavailable") {
      throw new PortalUnavailableError(
        `portal request failed (${classification.reason})`,
        "retry shortly; the portal may be unavailable",
      );
    }
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new PortalUnavailableError(
        "portal returned malformed JSON",
        "upstream shape may have changed; degrade gracefully and report it",
      );
    }
  }

  /**
   * Run `task` against a Banner app origin with a fresh-enough per-app session.
   *
   * Banner Self-Service apps each own a SAML session. A guest JSESSIONID can
   * suppress the handshake, so a failed fetch triggers one cookie clear +
   * re-handshake. Reads only: the task must issue GET requests.
   */
  async withAppSession<T>(origin: string, entryPath: string, task: (page: Page) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const browser = await this.launchLocked();
      const probe = await this.probeLocked();
      if (!probe.authenticated) {
        await this.reauthenticateLocked(probe.reason ?? "Banner app session");
      }
      await this.openAppLocked(origin, entryPath, false);
      try {
        return await task(browser.page);
      } catch (error) {
        if (!(error instanceof AppSessionExpiredError)) throw error;
        this.log("[session] Banner session expired; redoing SAML handshake");
        await this.openAppLocked(origin, entryPath, true);
        try {
          return await task(browser.page);
        } catch (retryError) {
          if (retryError instanceof AppSessionExpiredError) {
            throw new AuthRequiredError(
              "Banner session could not be established after a re-handshake",
              "run unw_session op=reauth, then retry",
            );
          }
          throw retryError;
        }
      }
    });
  }

  private isAppUrl(url: string, origin: string): boolean {
    return (
      url.startsWith(origin) &&
      !/login\.(microsoftonline|live)\.com|login\.microsoft\.com|\/saml2?\/|\/external\/login/i.test(url)
    );
  }

  private async openAppLocked(origin: string, entryPath: string, clearCookies: boolean): Promise<void> {
    const browser = await this.launchLocked();
    if (clearCookies) {
      await browser.ctx.clearCookies({ domain: new URL(origin).hostname }).catch(() => undefined);
    }
    const entry = new URL(entryPath, origin).toString();
    await browser.page
      .goto(entry, { waitUntil: "domcontentloaded", timeout: this.cfg.navigationTimeoutMs })
      .catch(() => undefined);
    const deadline = this.now() + 20_000;
    while (this.now() < deadline) {
      if (this.isAppUrl(browser.page.url(), origin)) return;
      await browser.page.waitForTimeout(300);
    }
    if (isSignInUrl(browser.page.url()) || /saml2?\//i.test(browser.page.url())) {
      let cred: Credentials;
      try {
        cred = this.credentialsLoader();
      } catch (error) {
        throw new AuthRequiredError(
          "Banner sign-in needs credentials that are not available",
          error instanceof CredentialsError ? error.hint : undefined,
        );
      }
      const result = await driveSignIn(browser.page, {
        cred,
        until: async () => this.isAppUrl(browser.page.url(), origin),
        log: this.log,
      });
      if (!result.ok) {
        throw new AuthRequiredError(
          `Banner sign-in failed (${result.reason})`,
          "verify the credentials file and TOTP secret",
        );
      }
      const settle = this.now() + 5_000;
      while (this.now() < settle) {
        if (this.isAppUrl(browser.page.url(), origin)) return;
        await browser.page.waitForTimeout(250);
      }
    }
    throw new AuthRequiredError(
      "Banner app session could not be established",
      "run unw_session op=reauth, then retry",
    );
  }

  /** Live status: session probe + cookie lifetimes. No re-auth. */
  async status(): Promise<SessionStatus> {
    return this.exclusive(async () => {
      const now = this.now();
      try {
        await this.launchLocked();
      } catch (error) {
        this.lastError = redactText((error as Error).message).slice(0, 300);
        return buildSessionStatus({
          probe: { authenticated: false, reason: this.lastError },
          cookies: { portal: [], flow: [], entra: [] },
          now,
          lastError: this.lastError,
        });
      }
      const probe = await this.probeLocked();
      const cookies = await this.inventoryLocked();
      if (probe.authenticated) this.lastError = undefined;
      return buildSessionStatus({
        probe,
        cookies,
        now,
        authMethod: this.authMethod,
        lastReauthAt: this.lastReauthAt,
        lastError: this.lastError,
      });
    });
  }

  /** Force a re-auth, returning the resulting status rather than throwing. */
  async reauth(): Promise<SessionStatus> {
    return this.exclusive(async () => {
      const now = this.now();
      try {
        await this.launchLocked();
        await this.reauthenticateLocked("requested");
      } catch (error) {
        this.lastError =
          error instanceof AuthRequiredError || error instanceof LockTimeoutError || error instanceof SignInError
            ? redactText(error.message)
            : redactText((error as Error).message ?? String(error));
      }
      const probe = await this.probeLocked();
      const cookies = await this.inventoryLocked().catch(() => ({ portal: [], flow: [], entra: [] }));
      return buildSessionStatus({
        probe,
        cookies,
        now,
        authMethod: this.authMethod,
        lastReauthAt: this.lastReauthAt,
        lastError: this.lastError,
      });
    });
  }

  /** Close the browser and release the profile lock. Safe to call twice. */
  async dispose(): Promise<void> {
    await this.exclusive(async () => {
      if (this.disposed) return;
      this.disposed = true;
      await this.browser?.ctx.close().catch(() => undefined);
      await this.releaseLock?.().catch(() => undefined);
      this.browser = undefined;
      this.releaseLock = undefined;
    });
  }

  /** Internal: the page for Banner same-origin fetch (phase 2). */
  async withPage<T>(task: (page: Page) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const browser = await this.launchLocked();
      return task(browser.page);
    });
  }

  /** Internal: the cookie jar for Banner per-app sessions (phase 2). */
  async withContext<T>(task: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const browser = await this.launchLocked();
      return task(browser.ctx, browser.page);
    });
  }

  /** Expose the lock for diagnostics; useful to tests that assert serialization. */
  get serialized(): Promise<unknown> {
    return this.tail;
  }
}

/** Re-exported so callers can distinguish config/credential failures. */
export { CredentialsError };
