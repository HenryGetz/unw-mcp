// Filesystem contract for the UNW recon scripts.
//
// Secrets never enter the repo:
//   ~/.config/unw-mcp/credentials.json   (0600; optional local copy)
//   ~/.config/unw-mcp/browser-profile/   (0700; persistent SSO profile)
//   ~/.cache/unw-mcp-recon/              (raw captures, screenshots)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const PORTAL_ORIGIN = 'https://my.unw.edu';
export const DASHBOARD_URL = `${PORTAL_ORIGIN}/dashboard`;

function expand(p) {
  return p.replace(/^~(?=$|\/)/, HOME);
}

export function configDir() {
  const override = process.env.UNW_MCP_CONFIG_DIR?.trim();
  return override ? expand(override) : path.join(HOME, '.config', 'unw-mcp');
}

export function profileDir() {
  const override = process.env.UNW_MCP_PROFILE_DIR?.trim();
  return override ? expand(override) : path.join(configDir(), 'browser-profile');
}

export function cacheDir() {
  const override = process.env.UNW_MCP_CACHE_DIR?.trim();
  return override ? expand(override) : path.join(HOME, '.cache', 'unw-mcp-recon');
}

export function artifactsDir(sub = '') {
  const dir = path.join(cacheDir(), sub);
  ensurePrivateDir(dir, 0o700);
  return dir;
}

/** Candidate credential files, in priority order. The teams-mcp file is read-only here. */
export function credentialCandidates() {
  return [path.join(configDir(), 'credentials.json'), path.join(HOME, '.config', 'teams-mcp', 'credentials.json')];
}

export function credentialsSource() {
  const found = credentialCandidates().find((f) => fs.existsSync(f));
  if (!found) {
    throw new Error(`no credentials file found (looked for ${credentialCandidates().join(', ')})`);
  }
  return found;
}

export function credentials() {
  const file = credentialsSource();
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`credentials file ${file} is group/world readable; chmod 600 it first`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['username', 'password']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`credentials file is missing "${key}"`);
  }
  return parsed;
}

export function ensurePrivateDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* best effort */ }
  return dir;
}

export function redactUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const key of ['code', 'id_token', 'access_token', 'refresh_token', 'state', 'SAMLRequest', 'SAMLResponse', 'RelayState', 'session', 'token', 'ticket', 'claims', 'studentId', 'bannerId']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, `<redacted:${u.searchParams.get(key).length}>`);
    }
    return u.toString();
  } catch {
    return String(rawUrl);
  }
}
