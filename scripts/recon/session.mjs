#!/usr/bin/env node
/**
 * Session lifecycle proof.
 *
 *   node scripts/recon/session.mjs           # cookies, storage keys, re-auth test
 *   node scripts/recon/session.mjs --json
 *
 * What it establishes:
 *   - which cookie actually carries the portal session (sessionid, 30 days);
 *   - the Entra "stay signed in" cookie that makes re-auth silent (~90 days);
 *   - that deleting portal cookies and reloading /dashboard re-authenticates
 *     through SAML without a password (the refresh path the MCP will use).
 *
 * READ-ONLY: no logout is performed.
 */
import { DASHBOARD_URL, redactUrl } from './lib/paths.mjs';
import { launch, portalReady, cookieInventory, storageInventory } from './lib/browser.mjs';

const AS_JSON = process.argv.includes('--json');

function days(iso) {
  if (iso === 'session') return 'session';
  return Math.round((Date.parse(iso) - Date.now()) / 86400000);
}

async function main() {
  const { ctx, page } = await launch({ headless: true });
  try {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const before = await portalReady(page);
    if (!before) throw new Error('not authenticated; run scripts/recon/login.mjs first');

    const cookies = await cookieInventory(ctx);
    const storage = await storageInventory(page);
    const interesting = cookies.filter((c) => /my\.unw\.edu|flow\.my\.unw\.edu|oci\.unw\.edu|microsoftonline|live\.com/.test(c.domain));

    const portalCookies = interesting.filter((c) => c.domain === '.my.unw.edu' || c.domain === 'my.unw.edu');
    const entra = interesting.filter((c) => /login\.microsoftonline\.com|\.live\.com/.test(c.domain));

    // Re-auth: remove only the portal session (keep the Entra SSO cookie).
    await ctx.clearCookies({ domain: 'my.unw.edu' });
    const t0 = Date.now();
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const reauthed = await portalReady(page);
    const reauthMs = Date.now() - t0;

    const result = {
      authenticated: before,
      portalCookies: portalCookies.map((c) => ({ name: c.name, expires: c.expires, daysLeft: days(c.expires), httpOnly: c.httpOnly })),
      entraCookies: entra.map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, daysLeft: days(c.expires) })),
      bannerAndFlowCookies: interesting.filter((c) => /oci\.unw\.edu|flow\.my\.unw\.edu/.test(c.domain)).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
      storageKeys: {
        localStorage: storage.localStorage.map((s) => ({ key: s.key, bytes: s.bytes, shape: s.shape })),
        sessionStorage: storage.sessionStorage.map((s) => ({ key: s.key, bytes: s.bytes, shape: s.shape })),
      },
      reauth: { ok: reauthed, ms: reauthMs, url: redactUrl(page.url()), method: 'silent SAML via Entra SSO cookie' },
    };

    if (AS_JSON) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`authenticated: ${result.authenticated}`);
    console.log('portal cookies:');
    for (const c of result.portalCookies) console.log(`  ${c.name.padEnd(12)} exp=${c.expires} (${c.daysLeft}${typeof c.daysLeft === 'number' ? 'd' : ''} left) httpOnly=${c.httpOnly}`);
    console.log('entra SSO cookies:');
    for (const c of result.entraCookies) console.log(`  ${c.name.padEnd(22)} ${c.domain.padEnd(30)} exp=${c.expires} (${c.daysLeft}${typeof c.daysLeft === 'number' ? 'd' : ''})`);
    console.log('banner/flow cookies:');
    for (const c of result.bannerAndFlowCookies) console.log(`  ${c.name.padEnd(24)} ${c.domain.padEnd(24)} exp=${c.expires}`);
    console.log(`storage keys: localStorage=${result.storageKeys.localStorage.length}, sessionStorage=${result.storageKeys.sessionStorage.length}`);
    console.log(`re-auth after clearing portal cookies: ok=${result.reauth.ok} in ${result.reauth.ms}ms (${result.reauth.method})`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error(`[session] FAILED: ${e.message}`); process.exit(1); });
