# Design notes

## Goals

1. **Read-only.** A student secretary can look up anything the portal exposes without a
   write path. Banner term selection (a session POST) is deliberately absent; the one data
   point that requires it, the pre-registration time ticket, degrades to `not_exposed`.
2. **Token-efficient.** Four tools with `op` dispatch, 5–12 fields per row, hard caps, and
   no upstream envelopes. A dashboard overview is ~4 KB; a schedule ~1.7 KB.
3. **Honest degradation.** Auth failures, availability failures and data that does not
   exist are distinct outcomes.

## Surface

```
unw_session   status | reauth
unw_dashboard overview | day | announcements | tasks | events | quick_links
unw_academics profile | today | schedule | grades | gpa | holds | registration | degree_audit
unw_finances  balances | financial_aid | chapel
unw_dining    locations | today | week
unw_calendar  academic | breaks | deadlines | events
unw_pages     search | get
```

Every tool shares one flat argument object (`op`, plus `term`, `days`, `limit`,
`include_completed`, `aid_year` where relevant). Adding an op adds no new schema tokens and
no new tool description at the top level.

## Layering

```
tools/*            validate args, dispatch, map errors
portal/*           projections + cached loaders (pure functions where possible)
banner/client.ts   per-app Banner session + GET-only page fetches
auth/session.ts    Chromium lifecycle, one mutex, portal re-auth, app handshakes
portal/client.ts   origin-locked portal/Flow reader
cache.ts           in-memory TTL + single-flight
```

Projections are pure functions over `unknown`. They do not throw on missing fields; rows
without the minimum identity (a title, a course label, a description) are dropped. This is
what makes upstream drift produce a smaller result instead of a crash.

## Cache matrix

| Data | TTL | Why |
|---|---|---|
| announcements / tasks | 2 min | personalized, changes during the day |
| dashboard / events / balances | 5 min | personalized but tolerant of seconds |
| quick links / profile / schedule / holds / registration | 5–10 min | stable within a session |
| grades / GPA | 30 min | posted grades rarely change |
| terms | 60 min | Banner publishes a handful per year |
| chapel | 15 min | weekly cadence |
| financial aid | 60 min | award letters change rarely |
| dining dataset | 60 min | public menu updates ~daily; 7 rolling days |
| academic ICS dataset | 6 h | public semester/break/deadline dates |
| page search / page body | 10 min / 24 h | search is query-shaped; body is near-static |
| degree audit | none | the claims JWT expires in 300 s; re-fetch claims and audit each call |

All caches are in process memory. A failed load is evicted, so the next call retries rather
than serving a cached error. Single-flight prevents concurrent identical loads.

## Authentication model

- Portal: `sessionid` (30 days, fixed) plus Entra `ESTSAUTHPERSISTENT`. A failed portal
  response triggers one silent dashboard reload, then one cookie-clear reload, then the
  credential + TOTP driver. One password submission per process run.
- Flow: shares the portal cookie jar; no separate handshake observed.
- Banner: each app (`registration-ss`, `student-ss`) has its own `JSESSIONID`. The server
  navigates the app entry, and on a login redirect/HTML clears only that host's cookies and
  redoes the SAML handshake once. A guest `JSESSIONID` is therefore harmless.
- Degree audit: `GET /api/v1/widgets/?shown=true` → `Degree Audit.claims` (300 s JWT) →
  `flow…/degree-audit/degreeworks?claims=…`. Re-fetched per call, retried once, never logged.
- One async mutex serializes every browser operation. `withAppSession` holds it across the
  handshake and all page fetches in that op.

## Derivation rules

**Today's classes.** `registrationHistory/reset?term=<current>` returns meeting-time rows
with `monday`…`sunday` flags and `startDate`/`endDate` in `MM/DD/YYYY`. The server:
1. derives the current term (`YYYY10` fall, `YYYY20` spring, `YYYY30` summer) in
   `America/Chicago`;
2. selects the current weekday in the same zone;
3. keeps meetings whose day flag is set and whose date range contains today;
4. sorts by `beginTime` and emits `{start, end, course, title, crn, location, instructors}`.

The portal events endpoint returns an empty class list; it is not used for this.

**Schedule / grades.** `term` accepts a Banner code or a description (`Fall 2026`, `fall`).
Without a term, schedule uses the current term. Grades default to the three most recent
terms at or before the current code, then keep only courses with a grade. This finds the
last completed semester without asking the user which term to inspect.

**Registration.** `viewRegistrationNotices` supplies standing, `allowsRegistration`,
enrollment status, and `timeTickets`. The live account returns `timeTickets: []`; the real
window only exists in `prepareRegistration` HTML after a `POST term/search`. Since this
server is GET-only, it returns `time_ticket_source: "not_exposed"` together with the
standing. It does not fabricate a window.

**Degree audit.** Each program reports `requirements_available`. When the upstream audit
returns no requirement array (the live majors/minors do), the projection returns
`requirements_available: false` and `requirements_total: 0` and omits `requirements`; it
does not imply the program is complete. `requirements` is only present when the array exists.

**Financial aid.** The active aid year comes from `CurrentActiveAidyear`; a caller may pass
a code or a label. Award rows use `activeAmount` (period amount) with `awrdOfferAmt` kept as
`offered`; per-period totals sum the active amounts. Cost rows keep description, amount,
period, category and billable flag. All names, alternate IDs and internal flags are dropped.

**Day.** `dashboard op=day` assembles the already-cached sections: today's classes,
campus events starting in the next 24 hours (de-duplicated by title/start/end with
`duplicate_count`), pending tasks (5), up to two active notices (omitted when none), and the
current/next meal at the Dining Center (fallback: first cafe with a menu). The meal keeps 6
stations × 8 items. It adds no new upstream source and caps every section; dining
availability failure degrades to `dining_status: "unavailable"` instead of failing the
whole day.

**Events.** The portal's `count` is the whole subscription set, not the filtered result.
The server requests `current=true` with a bounded `limit`, then filters to the local-date
window (`today … today+days`) and de-duplicates by id.

**Dining.** The public Bon Appétit payload is projected once into
`café metadata + date → cafe → dayparts → stations → item labels`. `dayparts` is an array
of arrays upstream; both levels are flattened, empty stations are dropped, and stations /
items are capped. `today` defaults to `detail:"brief"` (6 stations × 8 items) and accepts
`detail:"full"` (configured 12 × 25), plus `cafe` and `meal` filters; `no_meal` distinguishes
"this cafe has a menu but not that daypart" from `no_menu`. `week` returns 7 rolling dates
with per-daypart station/item counts and at most five sample labels. `weekly_schedule` and
`message` become plain text only when short. The raw payload is never retained after
projection.

**Academic calendar.** The public academic-calendar page is fetched, Google Calendar IDs are
extracted from the embed (`src=…%40group.calendar.google.com`), ICS-link and `cid=` forms.
Each ICS is parsed with line unfolding and `VALUE=DATE`/`TZID` support; all-day `DTEND` is
exclusive and is converted to an inclusive end. Events are merged across the three feeds:
`TRAD:`, `DE:` and `AGS:` prefixes are removed and collected in `audiences`, so one date
appears once. Breaks/deadlines use keyword filters over the normalized summary; an optional
`query` narrows academic/breaks/deadlines by a case-insensitive title substring without any
extra upstream call. A failed
feed is skipped; if every feed fails, the tool returns `unavailable` instead of guessing.
Campus events reuse the dashboard event path and its date filtering.

**Pages.** Search returns slug/title/category/excerpt (HTML stripped), optionally promotes
an exact title/slug match, then prefix and token matches; excerpts default to 120 characters
(`excerpt_chars`, max 400) and it reports upstream `count` and `truncated`. `get` prefers the text `body`, falls back to `body_html` → text, and caps at
4,000 characters with `body_chars`/`body_truncated`. A 404 becomes `status: "not_found"`
rather than an error.

## Error taxonomy

| Code | Meaning | Agent action |
|---|---|---|
| `auth_required` | portal or Banner needs a new session | `unw_session op=reauth`, then retry |
| `unavailable` | 5xx, timeout, malformed JSON, or no aid year | retry later; do not re-authenticate |
| `profile_locked` | another process owns the Chromium profile | close it; do not delete a live profile |
| `credentials_missing` | interactive sign-in needs a credentials file | operator action |
| `config_invalid` | bad YAML/env value | operator action |
| `invalid_argument` | unknown op or bad bound | use the listed ops |

Unknown errors bubble to the MCP runtime rather than being flattened into a plausible
answer.

## Testing

Unit tests never launch a browser. They cover pure projections, term/date helpers, response
classification, session status and mutex serialization, Banner re-handshake, TTL/single-
flight caching, and tool schemas/error mapping with fake portal and Banner readers. The live
proof script is the only integration test and is read-only; it prints counts, field names and
timings, never personal values.

## First release / future work

All seven tools ship in this release. The next iteration should be evaluated by an agent:
prompt-level evals will show whether `overview`, `today`, `academic` and `today` dining are
the right defaults, whether the dining day cap is too generous, and whether the calendar
rows need separate `audiences` or a compact `title` field. No write path is planned; adding
one would be a separate capability with its own guard, audit trail and explicit operator
enablement.
