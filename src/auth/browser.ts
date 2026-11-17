/**
 * Playwright plumbing for the myUNW (Pathify) portal.
 *
 * The portal's metadata declares SAML against Microsoft Entra ID:
 *   my.unw.edu/dashboard -> /api/core/saml_sso/1/ -> login.microsoftonline.com
 *   -> (password/TOTP) -> SAMLResponse -> /dashboard
 * A warm persistent profile usually skips everything after the first hop.
 */
import { mkdirSync, chmodSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { totp, secondsRemaining } from "./totp.js";
import { classifySignInPage, type SignInSnapshot } from "./signin.js";
import type { Credentials } from "./credentials.js";

export interface BrowserSession {
  ctx: BrowserContext;
  page: Page;
}

export interface LaunchOptions {
  headless: boolean;
  profileDir: string;
  timezone: string;
}

export class SignInError extends Error {
  readonly code = "sign_in_failed";
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

/** Persistent context rooted at the profile directory (0700), timezone pinned. */
export async function launchBrowser(options: LaunchOptions): Promise<BrowserSession> {
  mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(options.profileDir, 0o700);
  } catch {
    // best effort; a foreign-owned profile will fail the launch with a clear error
  }
  const ctx = await chromium.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: options.timezone,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

/** True when the Angular portal shell rendered an authenticated page. */
export async function portalReady(page: Page): Promise<boolean> {
  if (!page.url().startsWith("https://my.unw.edu")) return false;
  if (/\/api\/core\/saml_sso\//.test(page.url())) return false;
  return page
    .evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = body.innerText || "";
      const hasShell = Boolean(
        document.querySelector('campus-app, app-root, [class*="dashboard" i], nav, [role="navigation"]'),
      );
      return hasShell && text.trim().length > 40 && !/Sign in to your account|Pick an account/i.test(text);
    })
    .catch(() => false);
}

async function snapshot(page: Page): Promise<SignInSnapshot> {
  const base = await page
    .evaluate(() => {
      const query = (selector: string): HTMLElement | null => document.querySelector(selector);
      const email = query("#i0116") as HTMLInputElement | null;
      const password = query("#i0118") as HTMLInputElement | null;
      const button = query("#idSIButton9") as HTMLInputElement | null;
      const visible = (element: HTMLElement | null): boolean =>
        Boolean(element && element.offsetParent !== null);
      return {
        url: location.href,
        body: (document.body?.innerText ?? "").replace(/\s+/g, " "),
        buttonValue: button?.value ?? "",
        consentButton: Boolean(query("#idBtn_Accept")),
        otpInput: Boolean(
          query("#idTxtBcOtc") ||
            query('input[name="otc"]') ||
            query('input[autocomplete="one-time-code"]'),
        ),
        emailVisible: visible(email),
        emailValue: email?.value ?? "",
        passwordVisible: visible(password),
      };
    })
    .catch(() => ({
      url: page.url(),
      body: "",
      buttonValue: "",
      consentButton: false,
      otpInput: false,
      emailVisible: false,
      emailValue: "",
      passwordVisible: false,
    }));

  const mfaSwitcher =
    (await page
      .getByText(
        /Use a verification code|I can.t use my Microsoft Authenticator app right now|Use a different verification option|Sign in another way/i,
      )
      .first()
      .count()
      .catch(() => 0)) > 0;
  return { ...base, mfaSwitcher };
}

export interface DriveOptions {
  cred: Credentials;
  until: () => Promise<boolean>;
  maxSteps?: number;
  log?: (message: string) => void;
}

/**
 * Drive whatever Entra page is on screen until `until()` is satisfied.
 * At most one password submission per run: a repeated prompt is treated as a
 * rejected credential, never retried into a lockout.
 */
export async function driveSignIn(
  page: Page,
  { cred, until, maxSteps = 24, log = () => undefined }: DriveOptions,
): Promise<{ ok: boolean; reason: string; steps: number }> {
  let passwordAttempts = 0;
  for (let step = 1; step <= maxSteps; step += 1) {
    await page.waitForTimeout(1200);
    if (await until()) return { ok: true, reason: "signed-in", steps: step };

    const snap = await snapshot(page);
    if (/Your account or password is incorrect|invalid username or password/i.test(snap.body)) {
      return { ok: false, reason: "bad-password", steps: step };
    }
    const classification = classifySignInPage(snap);
    log(`[signin] step ${step}: ${classification.step}`);

    switch (classification.step) {
      case "aadsts":
        return { ok: false, reason: `aadsts:${classification.aadsts ?? "unknown"}`, steps: step };
      case "consent":
        await page.locator("#idBtn_Accept").click({ timeout: 5000 }).catch(() => undefined);
        break;
      case "totp": {
        if (secondsRemaining() < 5) await page.waitForTimeout(6000);
        const code = totp(cred.totpSecret);
        await page
          .locator('#idTxtBcOtc, input[name="otc"], input[autocomplete="one-time-code"]')
          .first()
          .fill(code, { timeout: 8000 })
          .catch(() => undefined);
        await page
          .locator("#idSubmit_SAOTCC_Continue, #idSIButton9")
          .first()
          .click()
          .catch(() => page.keyboard.press("Enter"));
        break;
      }
      case "mfa-switch":
        await page
          .getByText(
            /Use a verification code|I can.t use my Microsoft Authenticator app right now|Use a different verification option|Sign in another way/i,
          )
          .first()
          .click()
          .catch(() => undefined);
        break;
      case "account-picker":
        await page
          .locator(`div[role="button"]:has-text("${cred.username}")`)
          .first()
          .click({ timeout: 5000 })
          .catch(() =>
            page
              .getByText(cred.username, { exact: false })
              .first()
              .click()
              .catch(() => undefined),
          );
        break;
      case "kmsi":
        await page
          .locator("#idSIButton9")
          .click()
          .catch(() => page.getByRole("button", { name: /^Yes$/ }).first().click());
        break;
      case "password":
        if (passwordAttempts >= 1) {
          return { ok: false, reason: "password-retry-blocked", steps: step };
        }
        passwordAttempts += 1;
        await page.locator("#i0118").fill(cred.password, { timeout: 8000 }).catch(() => undefined);
        await page.locator("#idSIButton9").click().catch(() => page.keyboard.press("Enter"));
        break;
      case "identifier":
        await page.locator("#i0116").fill(cred.username, { timeout: 8000 }).catch(() => undefined);
        await page.locator("#idSIButton9").click().catch(() => page.keyboard.press("Enter"));
        break;
      case "mfa-setup":
        return { ok: false, reason: "mfa-setup-required", steps: step };
      case "unknown": {
        const cont = page.getByRole("button", { name: /^(Continue|Next|Sign in)$/i }).first();
        if ((await cont.count().catch(() => 0)) > 0) {
          await cont.click().catch(() => undefined);
        }
        break;
      }
      default:
        break;
    }
  }
  return { ok: false, reason: "max-steps", steps: maxSteps };
}
