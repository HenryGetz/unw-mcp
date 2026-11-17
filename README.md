# unw-mcp

Read-only, token-efficient MCP server for the **University of Northwestern – St. Paul**
student portal (`my.unw.edu`). It signs in through the portal's SAML/Entra flow using a
persistent Chromium profile, then projects portal and Banner data into compact JSON for an
assistant.

> **Status: phase 3 / first release** — session, dashboard, academics, finances, dining,
> academic calendar and page search. Read-only.

## ⚠️ Unofficial — use at your own risk

This is an **unofficial personal project**. It is **not affiliated with, endorsed by, or
supported by** University of Northwestern – St. Paul, Pathify, Ellucian, Microsoft, or Bon
Appétit. Use **your own account**, comply with every applicable term and policy (automation
may violate them), and verify anything that matters against the official portal. There is no
warranty and no liability for account lockout, data loss, policy/FERPA problems, or decisions
made from the data. No credentials or PII are included in this repository — your local
credentials and profile are yours to protect.

Read [`DISCLAIMER.md`](DISCLAIMER.md) before running anything. Licensed under the
[MIT License](LICENSE).

## Surface

| Tool | Ops | Backing endpoints | Cache | Returns |
|---|---|---|---|---|
| `unw_session` | `status`, `reauth` | `GET /api/v1/users/me/` probe; dashboard navigation for SAML | — | authenticated flag, auth method, cookie lifetimes (no values) |
| `unw_dashboard` | `overview` | profile + notices + tasks + today's events | 2–10 min | identity, degree progress, advisors, 3 notices, 5 pending tasks, today's events |
| | `day` | today's classes + next-24h events + tasks + notices + next meal | 2–10 min (reuses caches) | plan-my-day: 8 classes, 8 de-duplicated events (`duplicate_count`), 5 tasks, 2 notices, one meal with 6×8 options |
| | `announcements` | `GET /api/v1/notices/?notice_type=Emergency&notice_type=Alert&status=NO_STATUS&status=APPROVED&scheduled=false&expired=false&dismissed=false&limit=N&offset=0` | 2 min | title, type, preview, dates, ack flag |
| | `tasks` | `GET flow.my.unw.edu/pathify-api/v1/users/me/tasks/` | 2 min | title, preview, due, required/complete, link |
| | `events` | `GET /api/v2/events/?current=true&limit=N&field=id&field=title&field=start_date&field=end_date&field=all_day&field=location&field=calendar` | 5 min | title, start/end, local time, all-day, location, calendar |
| | `quick_links` | `GET /api/v1/dashboard/quick-link-cards/?active=true` | 10 min | card title + label/url pairs |
| `unw_academics` | `profile` | `GET /api/v1/users/me/` + `GET flow…/pathify-api/v1/users/me/?field=…` | 10 min | name, e-mail, role, GPA, degree progress, advisors, hold |
| | `today` | `GET registration-ss…/registrationHistory/reset?term=<current>` | 10 min | today's classes with local times and rooms |
| | `schedule` | same, requested/current term | 10 min | course, CRN, title, credits, instructors, meetings (days/times/room/dates) |
| | `grades` | same history endpoint for recent completed terms | 30 min | graded courses per term, credits |
| | `gpa` | `GET student-ss…/studentProfile/viewGPAHoursList?studentId=…` | 30 min | overall GPA/hours plus per-level rows |
| | `holds` | `GET student-ss…/studentHolds/showHolds?studentId=…` | 5 min | description, type, dates, releasable, amount owed |
| | `registration` | `GET student-ss…/studentProfile/viewRegistrationNotices?studentId=…` | 5 min | standing, allowsRegistration, status, time-ticket state |
| | `degree_audit` | `GET /api/v1/widgets/?shown=true` claims → `GET flow…/upstream/v1/degree-audit/degreeworks?claims=…` | none (claims 300 s) | degree/major/minor names, percent, credits, GPA, requirements; `requirements_available` is false when upstream has no requirement array |
| `unw_finances` | `balances` | `GET flow…/upstream/v1/balances` | 5 min | Student Account and Dining Funds amounts |
| | `financial_aid` | `GET student-ss…/applicantActiveAidYears/…` → `getAwardInfo`, `getCostOfAttendance` | 60 min | aid year, award rows, per-period totals, cost rows and total |
| | `chapel` | `GET flow…/upstream/chapel_summary` | 15 min | credits earned/required, remaining, percent, period |
| `unw_dining` | `locations` | `GET flow.my.unw.edu/upstream/v2/bonappetit` (public, ~1.8 MB) | 60 min | cafe name, address, plain-text hours/message |
| | `today` | same projected dataset | 60 min | requested date's cafes → dayparts → stations → item labels; `detail:"brief"` (default, 6×8) or `"full"`; `meal` filter |
| | `week` | same | 60 min | 7 rolling dates, daypart item/station counts and samples; `meal` filter |
| `unw_calendar` | `academic` | public Google ICS discovered from `unwsp.edu/academics/academic-calendar/` | 6 h | upcoming semester/break/deadline dates |
| | `breaks` | same | 6 h | recess/holiday/no-classes rows |
| | `deadlines` | same | 6 h | add/drop, withdraw, registration and other deadlines |
| | `events` | `GET /api/v2/events/?current=true&limit=N&field=…` | 5 min | campus events filtered to the local-date window |
| `unw_pages` | `search` | `GET /api/v1/pages/?search=<q>&limit=N` | 10 min | ranked slug/title/category/excerpt; exact title/slug first; `count` + `truncated`; `excerpt_chars` (default 120, max 400) |
| | `get` | `GET /api/v1/pages/slug/<slug>/` | 24 h | plain-text body (4,000-char cap), body_chars, body_truncated |

Output rules enforced in code: 5–12 fields per row, HTML stripped, ISO **and**
`America/Chicago` local times, nulls omitted, lists capped, no raw Pathify/Banner
envelopes. The portal's event `count` is global, so events are filtered client-side to the
requested local-date window (`days`, default 7; `0` = today).

Arguments are shared per tool to keep schema tokens low:

```
unw_session   { op }
unw_dashboard { op, limit?, days?, include_completed? }  # op=day takes no extra args
unw_academics { op, term? }      # term: Banner code (202610) or name (Fall 2026)
unw_finances  { op, aid_year? }  # aid_year: code (2627) or label (2026-2027)
unw_dining    { op, date?, cafe?, meal?, detail? }  # detail defaults to brief
unw_calendar  { op, days?, limit?, query? }  # query filters academic/breaks/deadlines titles
unw_pages     { op, query?, slug?, limit?, excerpt_chars? }
```

## Install (no clone)

Requirements: Node >= 22 and Playwright Chromium (`npx playwright install chromium`); a Linux
desktop/Xvfb only if you set `headless: false`.

Point your MCP client at the GitHub repository directly — npm fetches the source, installs
devDependencies, runs `prepare` (`npm run build`) and links the `unw-mcp` binary. No clone, no
local build:

```json
{
  "mcpServers": {
    "unw": {
      "command": "npx",
      "args": ["-y", "github:HenryGetz/unw-mcp"],
      "env": { "UNW_MCP_TIMEZONE": "America/Chicago", "UNW_MCP_HEADLESS": "1" }
    }
  }
}
```

Other installs:

```bash
npx -y github:HenryGetz/unw-mcp          # run once (stdio; the client normally spawns it)
npm pack github:HenryGetz/unw-mcp        # builds dist/ inside the tarball
npm install -g ./unw-mcp-0.1.0.tgz       # global `unw-mcp` command
```

Use the tarball form for a global install: `npm install -g github:HenryGetz/unw-mcp` is
unreliable because npm ≥ 11 runs the git checkout's build with the global install's flags
inherited, so the build fails inside the checkout (`npm error git dep preparation failed`).
That is an npm limitation, not a problem with the tarball or `npx` path.

Or let [`add-mcp`](https://www.npmjs.com/package/add-mcp) write the client config for you
(`claude-code`, `claude-desktop`, `cursor`, `vscode`, `opencode`, `codex`, `zed`, `windsurf`):

```bash
npx -y add-mcp github:HenryGetz/unw-mcp -a cursor -n unw \
  --env UNW_MCP_TIMEZONE=America/Chicago -y
```

The **first run downloads the source, builds `dist/`, installs dependencies (~60–90 s with a
cold npm cache), then launches Chromium and completes the SAML/Entra handshake — expect ~90 s
cold** on an empty profile. Warm starts answer `unw_session op=status` in about a second.
Playwright's Chromium binary is not bundled: on a clean machine run
`npx playwright install chromium` once. `npx` caches the resolved commit, so after new commits
clear it (`npm cache clean --force`) to pick them up.

## Install from source (for development)

```bash
npm install          # runs `prepare` → builds dist/
npm run smoke        # tools/list over stdio, no browser
npm run live-proof   # session + all dashboard/academic/finance ops, read-only
```

Register the local checkout (see `mcp.example.json`):

```json
{
  "mcpServers": {
    "unw": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/unw-mcp",
      "env": { "UNW_MCP_TIMEZONE": "America/Chicago", "UNW_MCP_HEADLESS": "1" }
    }
  }
}
```

## Authentication

The portal is a Pathify/Angular app behind **SAML 2.0** with **Microsoft Entra ID**
(tenant `<tenant-id>`). There is no API key and no portal bearer token.

- Persistent profile: `~/.config/unw-mcp/browser-profile` (mode `0700`).
- Credentials (only needed when Entra itself expires):
  `~/.config/unw-mcp/credentials.json` (mode `0600`), falling back to
  `~/.config/teams-mcp/credentials.json`. Shape: `{ "username", "password", "totpSecret" }`
  (`totp_secret` is accepted too). Secrets are never copied into this repository.
- Warm profile: `status` and portal calls reuse the `sessionid` cookie (30 days, fixed).
- On `401`/`403`, a redirect to sign-in, or HTML where JSON was expected, the session
  reloads `/dashboard` once. Entra's `ESTSAUTHPERSISTENT` cookie usually makes this a silent
  SAML round trip (~7–11 s). If that fails, the server clears only `.my.unw.edu` cookies and
  retries once, then falls back to e-mail + password + TOTP. A rejected password is never
  retried (lockout protection).
- All browser work is serialized through one mutex; a cross-process profile lock prevents
  two MCP instances from sharing the Chromium profile.
- Portal and Flow requests use `browserContext.request`. Banner origins
  (`registration-ss.oci.unw.edu`, `student-ss.oci.unw.edu`) use `page.evaluate(fetch)`,
  because each Banner app owns a separate SAML session.

**Banner per-app sessions.** Before a Banner read, the server probes the portal session,
navigates that app's `registerPostSignIn` / `studentProfile` entry, and if the app returns a
login redirect or HTML it clears only that app's cookies and redoes the SAML handshake once.
A guest `JSESSIONID` cannot suppress the handshake because the retry clears it. A second
failure becomes `auth_required`. All Banner requests are GET-only.

**Degree audit.** The widget catalog carries a 300-second `claims` JWT. It is re-fetched
before every audit call, passed URL-encoded to Flow, retried once with fresh claims, and
never logged or cached.

## Startup and latency

The server does **not** launch Chromium at startup; the first authenticated tool call does.
On an isolated/cold profile the first call can take **~90 s** while the portal session and
Banner app sessions bootstrap. A warm persistent profile answers `unw_session status` in
about a second and dashboard/academic calls in 0.2–7 s. Call `unw_session op=status` first if
you want to pay the warm-up explicitly; subsequent questions in the same process reuse the
profile, portal session and in-memory caches.

## Configuration

Precedence: environment > `~/.config/unw-mcp/config.yaml` > defaults. See
`config.example.yaml` and `.env.example`.

| Setting | Default | Notes |
|---|---|---|
| `timezone` | `America/Chicago` | all rendering, event windows, today's classes |
| `headless` | `true` | `false` needs a display/xvfb |
| `cache.dashboard_ttl_minutes` | 5 | overview |
| `cache.announcements_ttl_minutes` / `tasks` | 2 | personalized lists |
| `cache.events_ttl_minutes` | 5 | portal events |
| `cache.quick_links_ttl_minutes` | 10 | dashboard links |
| `cache.profile_ttl_minutes` | 10 | portal + Flow profile |
| `cache.schedule_ttl_minutes` | 10 | terms and registration history |
| `cache.grades_ttl_minutes` | 30 | graded-term aggregation |
| `cache.gpa_ttl_minutes` | 30 | Banner GPA/hours |
| `cache.holds_ttl_minutes` / `registration_ttl_minutes` | 5 | Banner student data |
| `cache.terms_ttl_minutes` | 60 | Banner term list |
| `cache.balances_ttl_minutes` | 5 | Flow balances |
| `cache.chapel_ttl_minutes` | 15 | chapel summary |
| `cache.financial_aid_ttl_minutes` | 60 | award + cost bundle |
| `cache.dining_ttl_minutes` | 60 | projected 7-day dining dataset |
| `cache.academic_calendar_ttl_minutes` | 360 | discovered ICS feeds |
| `cache.page_search_ttl_minutes` / `pages_ttl_minutes` | 10 / 1440 | search rows / page bodies |
| `max_results.*` | 5–20 rows, 300 preview chars, 25 full-dining items/station, 12 full stations, 4,000 page chars | per-call caps; dining brief is fixed at 6 stations × 8 items |
| `limits.event_fetch_limit` / `event_window_days` | 60 / 7 | client-side event filter |

Environment overrides: `UNW_MCP_CONFIG_DIR`, `UNW_MCP_PROFILE_DIR`, `UNW_MCP_TIMEZONE`,
`UNW_MCP_HEADLESS`, `UNW_MCP_REQUEST_TIMEOUT_MS`, `UNW_MCP_NAVIGATION_TIMEOUT_MS`,
`UNW_MCP_REAUTH_TIMEOUT_MS`, and per-cache `UNW_MCP_*_TTL_MINUTES` (see `.env.example`).

## Token efficiency

- Every list request passes an upstream `limit`; projections drop internal flags and
  redundant fields.
- In-process TTL cache with single-flight loading. Concurrent tool calls do not duplicate
  requests.
- Observed live sizes: dashboard overview 4.3 KB, dashboard day 5.0 KB, announcements
  0.37 KB, tasks 1.2 KB, events (10 rows) 2.5 KB, quick links 1.1 KB, academic profile
  0.24 KB, today 0.6 KB, schedule 1.7 KB, grades 1.1 KB, GPA 0.3 KB, holds 0.2 KB,
  registration 0.25 KB, degree audit 1.1 KB, balances 0.12 KB, chapel 0.18 KB, financial
  aid 5.7 KB, dining locations 1.2 KB, dining today brief 3.4 KB / full 7.0 KB / one meal
  1.1 KB, dining week 5.8 KB, academic calendar 1.1 KB, breaks 1.2 KB, deadlines 1.1 KB,
  page search (10) 2.6 KB, page body 0.55 KB, calendar breaks filtered by query 0.45 KB.
- Financial aid and a full dining day are the largest payloads (22 awards + 22 cost rows;
  ~300 item labels). Both are explicitly capped and never include internal upstream fields.
- The dining endpoint is ~1.8 MB; only the projected dataset is cached, and only the
  requested date/cafe leaves the server. The raw payload is never returned.

## Verification

Measured in this repository on 2026-11-17:

| Command | Result |
|---|---|
| `npm run typecheck` | clean (strict TypeScript, `noUncheckedIndexedAccess`) |
| `npm test` | **137 tests / 14 files** pass |
| `npm run build` | clean `dist/` |
| `npm run smoke` | 7 tools; all op enums listed; missing/unknown op rejected |
| `npm run live-proof` | all seven tools returned live data: session, dashboard, day (3 classes/8 de-duplicated events/3 tasks/1 notice/next meal, 5.0 KB), profile, today, schedule, grades, GPA, holds (1), registration, degree audit (5 degrees; 1/5 has requirement detail), balances (2), chapel (8/20), financial aid (22 awards/22 cost rows), dining brief 3.4 KB vs full 7.0 KB vs one meal 1.1 KB, 7-day week, academic/breaks/deadlines rows, Thanksgiving-filtered breaks (445 B), campus events (10 rows), page search (56 hits, top 10, 2.6 KB), page get |

Unit coverage: config precedence/validation, redaction, sign-in classification, response
classification (401 vs SAML HTML vs 5xx vs 302), session status, Banner page fetch plus
one-shot re-handshake, TTL/single-flight cache, dashboard projections, Banner term/schedule/
today/grades/GPA/holds/registration projections, degree-audit projection and claims
refresh, balance/chapel/aid projections and loaders, dining dataset/day/week/locations
projection, brief/full detail, meal filtering and caps, day assembly and next-meal selection,
ICS discovery/parsing/cohort merging and date filtering, page HTML→text search/ranking/get,
tool schemas and error mapping.

Live proof prints counts, field names and timings only; no names, e-mail addresses, IDs or
balances are written to the repository. Live proof is read-only.

## Known limitations / not exposed

- **Time ticket text**: `viewRegistrationNotices` returns an empty `timeTickets` array for
  this account. The time ticket lives only in the `prepareRegistration` HTML after a
  term-selection POST; this server does not issue that POST, so `time_ticket_source` is
  `not_exposed` and standing/allowsRegistration are still returned.
- **Housing assignment/roommates**: no endpoint exists in the portal.
- **Meal-plan swipe counts**: only the Dining Funds balance exists.
- **Degree requirements**: Flow returns requirement rows only on the degree record;
  majors/minors report completion percentages with `requirements_available: false` and
  `requirements_total: 0`. On the live account **4 of 5 programs** have no requirement
  detail; only the degree record does. This is an upstream limitation, not an inference of
  "complete".
- **Banner pre-registration holds**: the JSON `showHolds` endpoint is authoritative;
  registration-notice holds text is not parsed from HTML.
- **Dining**: the public payload covers 7 rolling days only; some cafes (e.g. Heritage) may
  publish no menu for a date. `today` reports `no_menu` per cafe rather than inventing items.
  Default `detail:"brief"` caps each station at 8 items and each daypart at 6 stations;
  `detail:"full"` uses the configured 12/25 caps. Use `meal` and `cafe` to scope further.
- **Academic calendar**: discovery depends on the public page embedding Google Calendars.
  If the layout changes, the tool returns `unavailable` instead of guessed dates. Cohort
  prefixes (`TRAD:`, `DE:`, `AGS:`) are merged into one row with `audiences`.
- **Pages**: search covers portal content pages only, not users/directory; results are
  ranked with exact title/slug matches first and carry `count`/`truncated`. Bodies are capped
  at 4,000 chars; `body_truncated`/`body_chars` say what was cut.

## Repository / CI

This repository is **public** ([MIT](LICENSE)). It contains no account data, credentials,
browser profiles or raw portal captures; `.gitignore` excludes `node_modules/`, `dist/`, `.env*`,
`config.yaml`, `credentials.json`, `browser-profile/`, `.recon/`, `artifacts/` and `*.tgz`.
Everything the server reads from `my.unw.edu` is **read-only** — the portal and Banner code
paths issue GETs only (registration is never posted).

`ci.yml` runs on pushes and pull requests with a read-only `GITHUB_TOKEN`, no secrets and no
network access to the portal:

1. `npm ci` — lockfile install; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` because unit tests never
   launch Chromium
2. `npm run typecheck` — `tsc --noEmit` (strict)
3. `npm test` — `vitest run`, mocked HTTP, no browser or credentials
4. `npm run build` — clean `dist/`

Live checks are operator-only and never run in CI: `npm run smoke` (tools/list over stdio) and
`npm run live-proof` (requires a warm authenticated profile on the operator's machine).

## Layout

```
src/
  index.ts              stdio MCP entrypoint
  config.ts             YAML + env configuration
  cache.ts              in-memory TTL + single-flight cache
  format.ts, time.ts    projection and America/Chicago rendering helpers
  auth/
    browser.ts          persistent Chromium, SAML driver, portal-ready probe
    session.ts          mutex, portal re-auth, Banner per-app sessions
    credentials.ts      0600 credential discovery with teams-mcp fallback
    response.ts         auth vs availability classification
    redact.ts           log/URL/token redaction
    signin.ts           pure Entra page classifier
    lock.ts             cross-process profile lock
    totp.ts             RFC 6238
  banner/client.ts      per-app client; GET-only page fetches
  portal/
    client.ts           origin-locked portal/Flow reader
    values.ts           tolerant upstream accessors
    dashboard.ts        dashboard projections + loaders
    academics.ts        term/schedule/grades/GPA/holds/registration/audit
    finances.ts         balances, chapel, financial aid
    dining.ts           public menu dataset + day/week projections
    calendar.ts         ICS discovery/parsing + campus events
    pages.ts            page search and slug lookup
  tools/                registry, envelopes, four op-dispatched tools
scripts/recon/          reconnaissance behind docs/portal-recon.md
scripts/dev/            smoke and live proof
test/                   unit tests (no browser, mock HTTP)
docs/                   portal recon, design notes, usage examples
```

See `SECURITY.md` for the threat model and secret handling. See `docs/design.md` for the
projection/caching design and `docs/usage.md` for example conversations and payloads.
