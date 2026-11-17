#!/usr/bin/env node
/**
 * Interactive-but-automated myUNW sign-in against the persistent profile.
 *
 *   node scripts/recon/login.mjs            # headed (auto-xvfb when no DISPLAY)
 *   node scripts/recon/login.mjs --headless # try the headless shell instead
 *   node scripts/recon/login.mjs --reuse-test
 *
 * Writes a redacted session report to stdout and a raw capture
 * (cookies + storage + redirects, still no token values) to
 * ~/.cache/unw-mcp-recon/raw/session-<ts>.json.
 */
import { DASHBOARD_URL, credentials, redactUrl } from './lib/paths.mjs';
import { launch, driveSignIn, portalReady, cookieInventory, storageInventory, ensureDisplay, recordNetwork, saveRaw } from './lib/browser.mjs';

const argv = new Set(process.argv.slice(2));
const HEADLESS = argv.has('--headless');
const REUSE_TEST = argv.has('--reuse-test');
const QUIET = argv.has('--quiet');
const log = QUIET ? () => {} : (...a) => console.error(...a);

export async function runLogin({ headless = HEADLESS, log: logFn = log } = {}) {
  const cred = credentials();
  const started = Date.now();
  const { ctx, page } = await launch({ headless });
  const redirects = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) redirects.push(redactUrl(frame.url()));
  });
  const net = recordNetwork(page);
  try {
    logFn(`[login] goto ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => logFn(`[login] goto: ${e.message}`));

    // The Angular shell needs a moment even when the session is valid; poll
    // before deciding that credentials are required.
    let warm = false;
    for (let i = 0; i < 10 && !warm; i += 1) {
      warm = await portalReady(page).catch(() => false);
      if (!warm) await page.waitForTimeout(700);
    }
    logFn(`[login] profile ${warm ? 'already authenticated' : 'needs sign-in'} (${page.url().slice(0, 80)})`);

    let result = { ok: warm, reason: warm ? 'warm-profile' : 'none', steps: 0, shots: [] };
    if (!warm) {
      result = await driveSignIn(page, {
        cred,
        until: async () => portalReady(page),
        log: logFn,
      });
      if (!result.ok) {
        const files = result.shots.slice(-3).join(', ');
        throw new Error(`sign-in failed (${result.reason}): ${result.error ?? 'see screenshots'} — ${files}`);
      }
      await page.waitForTimeout(4000);
    }

    // Let the dashboard widgets issue their API calls before snapshotting.
    await page.waitForTimeout(5000);
    const cookies = await cookieInventory(ctx);
    const storage = await storageInventory(page);
    const netJson = net.json();

    const report = {
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      signedInAs: cred.username,
      mode: warm ? 'warm-profile' : `fresh-login(${result.steps} steps)`,
      finalUrl: redactUrl(page.url()),
      redirects,
      cookies,
      storage,
      apiCalls: netJson.map((e) => ({ method: e.method, url: e.url, status: e.status })),
      jsonBodies: netJson,
    };
    const file = saveRaw(`session-${Date.now()}.json`, report);
    logFn(`[login] raw session capture: ${file}`);
    return { ...report, rawFile: file, page, ctx };
  } finally {
    net.stop();
  }
}

/** Does the teams-mcp Microsoft SSO session satisfy myUNW? Cookie-only, throwaway profile. */
export async function testTeamsReuse() {
  const { chromium } = await import('playwright');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const teamsProfile = path.join(os.homedir(), '.config', 'teams-mcp', 'browser-profile');
  if (!fs.existsSync(teamsProfile)) return { reusable: false, reason: 'no teams profile' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unw-reuse-'));
  const { ctx, page } = await launch({ headless: true, profile: tmp }).catch(() => ({ ctx: null, page: null }));
  if (!ctx) return { reusable: false, reason: 'launch failed' };
  try {
    // Copy only IdP cookies (not the whole profile) into the throwaway context.
    const src = await chromium.launchPersistentContext(teamsProfile, { headless: true });
    const cookies = await src.cookies();
    await src.close();
    const idp = cookies.filter((c) => /login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com/.test(c.domain));
    await ctx.addCookies(idp);
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const ok = await portalReady(page);
    const url = redactUrl(page.url());
    return { reusable: ok, idpCookieCount: idp.length, urlAfter: url, note: ok ? 'SSO session reused without credentials' : 'IdP cookies alone were not enough' };
  } finally {
    await ctx.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureDisplay();
  try {
    if (REUSE_TEST) {
      console.log(JSON.stringify(await testTeamsReuse(), null, 2));
      process.exit(0);
    }
    const report = await runLogin();
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          finalUrl: report.finalUrl,
          redirects: report.redirects,
          cookies: report.cookies,
          storage: report.storage,
          apiCallCount: report.apiCalls.length,
          rawFile: report.rawFile,
        },
        null,
        2,
      ),
    );
    await report.ctx.close();
    process.exit(0);
  } catch (error) {
    console.error(`[login] FAILED: ${error.message}`);
    process.exit(1);
  }
}
