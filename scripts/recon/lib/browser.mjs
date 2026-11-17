// Playwright + Microsoft sign-in state machine for the myUNW (Pathify) portal.
//
// The portal's metadata declares authentication=SAML with
// auth_redirect_url=/api/core/saml_sso/1/, so the flow is:
//   my.unw.edu/dashboard -> /api/core/saml_sso/1/ -> login.microsoftonline.com
//   -> (password/TOTP) -> back to /api/core/saml_sso/1/?SAMLResponse=... -> /dashboard
// A warm persistent profile usually skips everything after the first hop.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ensurePrivateDir, profileDir, artifactsDir, PORTAL_ORIGIN, redactUrl } from './paths.mjs';
import { totp, secondsRemaining } from './totp.mjs';

export const SIGN_IN_HOST = /login\.(microsoftonline|live)\.com|login\.microsoft\.com|login\.microsoftonline\.com/;

let shotSeq = 0;
export async function shot(page, label) {
  shotSeq += 1;
  const dir = artifactsDir('shots');
  const file = path.join(dir, `${String(shotSeq).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}

export async function launch({ headless = false, profile } = {}) {
  const dir = ensurePrivateDir(profile ?? profileDir(), 0o700);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

export function onPortal(page) {
  return page.url().startsWith(PORTAL_ORIGIN);
}

/** Portal shell is up when the Angular app rendered the authenticated chrome. */
export async function portalReady(page) {
  if (!onPortal(page)) return false;
  if (/\/api\/core\/saml_sso\//.test(page.url())) return false;
  return page
    .evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = body.innerText || '';
      const hasShell = Boolean(
        document.querySelector('campus-app, app-root, [class*="dashboard" i], nav, [role="navigation"]'),
      );
      return hasShell && text.trim().length > 40 && !/Sign in to your account|Pick an account/i.test(text);
    })
    .catch(() => false);
}

/**
 * Drive whatever sign-in page is on screen until `until()` is satisfied.
 * Handles account picker, identifier, password, TOTP, KMSI, consent, and the
 * occasional "use a verification code" switch. Never retries a rejected password.
 */
export async function driveSignIn(page, { cred, until, maxSteps = 24, log = () => {} } = {}) {
  const shots = [];
  let passwordAttempts = 0;
  let lastUrl = '';
  for (let step = 1; step <= maxSteps; step += 1) {
    await page.waitForTimeout(1500);
    if (await until({ page, step })) return { ok: true, reason: 'until', steps: step, shots };

    const url = page.url();
    const body = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).replace(/\s+/g, ' ');
    const buttonLabel = await page.locator('#idSIButton9').inputValue({ timeout: 400 }).catch(() => '');
    if (url !== lastUrl) {
      log(`[step ${step}] ${redactUrl(url).slice(0, 110)}`);
      lastUrl = url;
    }

    const aadsts = body.match(/AADSTS\d{5}[^.]{0,300}/);
    if (aadsts) {
      shots.push(await shot(page, 'aadsts-error'));
      return { ok: false, reason: 'aadsts', error: aadsts[0], steps: step, shots };
    }

    if (/Your account or password is incorrect|invalid username or password/i.test(body)) {
      shots.push(await shot(page, 'bad-password'));
      return { ok: false, reason: 'bad-password', error: 'credential rejected (not retried)', steps: step, shots };
    }

    if (await page.locator('#idBtn_Accept').count()) {
      shots.push(await shot(page, 'consent'));
      log('[act] consent');
      await page.locator('#idBtn_Accept').click();
      continue;
    }

    // SAML "Sign in with your organizational account" on the STS page sometimes
    // shows an email field with a Next button, handled below.

    const otp = page.locator('#idTxtBcOtc, input[name="otc"], input[autocomplete="one-time-code"]');
    if (await otp.count()) {
      if (secondsRemaining() < 5) await page.waitForTimeout(6000);
      const code = totp(cred.totpSecret);
      shots.push(await shot(page, 'totp'));
      log(`[act] TOTP (${secondsRemaining()}s left)`);
      await otp.first().fill(code);
      await page.locator('#idSubmit_SAOTCC_Continue, #idSIButton9').first().click().catch(() => page.keyboard.press('Enter'));
      continue;
    }

    const switcher = page
      .getByText(/Use a verification code|I can.t use my Microsoft Authenticator app right now|Use a different verification option|Sign in another way/i)
      .first();
    if (await switcher.count()) {
      shots.push(await shot(page, 'mfa-switch'));
      log('[act] switch MFA method');
      await switcher.click().catch(() => undefined);
      continue;
    }

    if (/Pick an account/i.test(body)) {
      shots.push(await shot(page, 'account-picker'));
      log('[act] pick cached account');
      await page
        .locator(`div[role="button"]:has-text("${cred.username}")`)
        .first()
        .click({ timeout: 5000 })
        .catch(() => page.getByText(cred.username, { exact: false }).first().click().catch(() => undefined));
      continue;
    }

    if (/Stay signed in\?/i.test(body) || /^Yes$/i.test(buttonLabel)) {
      shots.push(await shot(page, 'kmsi'));
      log('[act] stay signed in = yes');
      await page.locator('#idSIButton9').click().catch(() => page.getByRole('button', { name: /^Yes$/ }).first().click());
      continue;
    }

    const emailVisible = await page.locator('#i0116').isVisible().catch(() => false);
    const passwordVisible = await page.locator('#i0118').isVisible().catch(() => false);
    const emailValue = emailVisible ? await page.locator('#i0116').inputValue().catch(() => '') : '';
    const emailStep = emailVisible && !emailValue;
    const passwordStep = passwordVisible && !emailStep;

    if (passwordStep) {
      if (passwordAttempts >= 1) {
        shots.push(await shot(page, 'password-retry-blocked'));
        return { ok: false, reason: 'password-retry-blocked', error: 'password prompt repeated; refusing lockout risk', steps: step, shots };
      }
      passwordAttempts += 1;
      shots.push(await shot(page, 'password'));
      log('[act] fill password');
      await page.locator('#i0118').fill(cred.password, { timeout: 8000 }).catch((e) => log(`[err] ${e.message.slice(0, 80)}`));
      await page.locator('#idSIButton9').click().catch(() => page.keyboard.press('Enter'));
      continue;
    }

    if (emailStep) {
      shots.push(await shot(page, 'email'));
      log('[act] fill email');
      await page.locator('#i0116').fill(cred.username, { timeout: 8000 }).catch((e) => log(`[err] ${e.message.slice(0, 80)}`));
      await page.locator('#idSIButton9').click().catch(() => page.keyboard.press('Enter'));
      continue;
    }

    if (/More information required|Let.s keep your account secure/i.test(body)) {
      shots.push(await shot(page, 'mfa-setup-wall'));
      return { ok: false, reason: 'mfa-setup-required', error: body.slice(0, 200), steps: step, shots };
    }

    const cont = page.getByRole('button', { name: /^(Continue|Next|Sign in)$/i }).first();
    if (await cont.count()) {
      log('[act] generic continue');
      await cont.click().catch(() => undefined);
      continue;
    }

    log(`[wait] unmatched page at step ${step}`);
  }
  return { ok: false, reason: 'max-steps', steps: maxSteps, shots };
}

/** Ensure a usable display; re-exec under xvfb-run when there is none. */
export function ensureDisplay() {
  if (process.env.DISPLAY || process.env.UNW_MCP_XVFB_CHILD) return;
  const probe = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error('[warn] no DISPLAY and no xvfb-run: install xvfb or set DISPLAY');
    return;
  }
  const child = spawnSync('xvfb-run', ['-a', process.execPath, process.argv[1], ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, UNW_MCP_XVFB_CHILD: '1' },
  });
  process.exit(child.status ?? 1);
}

/** Network recorder that keeps JSON bodies in memory (never committed). */
export function recordNetwork(page, { maxBodies = 400 } = {}) {
  const entries = [];
  const onResponse = async (res) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(type)) return;
      const url = res.url();
      if (!/my\.unw\.edu\/api|pathify|unw\.edu/.test(url)) return;
      const ct = res.headers()['content-type'] ?? '';
      const entry = {
        method: req.method(),
        url: redactUrl(url),
        status: res.status(),
        type,
        contentType: ct,
        at: new Date().toISOString(),
      };
      if (/json/.test(ct) && entries.length < maxBodies) {
        entry.body = await res.json().catch(() => undefined);
      }
      entries.push(entry);
    } catch { /* ignore */ }
  };
  page.on('response', onResponse);
  return {
    entries,
    stop: () => page.off('response', onResponse),
    json: () => entries.filter((e) => e.body !== undefined),
  };
}

/** Redacted cookie inventory: names, domains, flags, lifetimes. */
export async function cookieInventory(ctx) {
  const cookies = await ctx.cookies();
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    expires: c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString(),
    valueLength: c.value.length,
    valuePrefix: c.value.slice(0, 4).replace(/[A-Za-z0-9]/g, 'x'),
  }));
}

/** localStorage/sessionStorage inventory: keys, sizes, value type — no values. */
export async function storageInventory(page) {
  return page
    .evaluate(() => {
      const dump = (store) => {
        const out = [];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          const value = store.getItem(key) ?? '';
          let shape = 'string';
          let keys = null;
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
              shape = Array.isArray(parsed) ? `array(${parsed.length})` : 'object';
              keys = Array.isArray(parsed) ? null : Object.keys(parsed).slice(0, 25);
            } else shape = typeof parsed;
          } catch { /* plain string */ }
          out.push({ key, bytes: value.length, shape, keys });
        }
        return out;
      };
      return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
    })
    .catch(() => ({ localStorage: [], sessionStorage: [] }));
}

/** Save a raw capture under ~/.cache/unw-mcp-recon (mode 0600). */
export function saveRaw(name, value) {
  const dir = artifactsDir('raw');
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}
