# myUNW portal recon (auth + data map)

Read-only reconnaissance for a University of Northwestern – St. Paul student-portal MCP.
Target: `https://my.unw.edu/dashboard`. Date: 2026-11-17.

Everything below was exercised with the scripts in `scripts/recon/`. Raw payloads and
screenshots stay outside the repo in `~/.cache/unw-mcp-recon/`; this document contains no
names, student IDs, e-mail addresses, balances, tokens or cookies.

---

## 1. What the portal is

| Layer | Finding |
|---|---|
| Frontend | Angular SPA, `PORTAL_VERSION` / `FRONTEND_VERSION` **6.61.9** |
| Product | **Pathify** campus experience platform (`cube.pathify.com`, `path-content` storage bucket) |
| Backend | `https://my.unw.edu/api` (`BACKEND_SERVER`), REST `/api/v1/…` and `/api/v2/…` |
| Auth | **SAML 2.0** against **Microsoft Entra ID** tenant `<tenant-id>`; `authentication: "SAML"`, `auth_auto_redirect: true`, `oauth_enabled: false` |
| Login entry | `/api/core/saml_sso/1/` (declared in page metadata as `auth_redirect_url`) |
| Session | Django `sessionid` cookie on `.my.unw.edu` (HttpOnly), CSRF cookie `csrftoken` |
| Side app | **Pathify Flow** at `https://flow.my.unw.edu` — hosts dashboard widgets and SIS proxies (`/upstream/…`, `/pathify-api/…`) |
| SIS | **Ellucian Banner 9 Self-Service**: `registration-ss.oci.unw.edu` (registration) and `student-ss.oci.unw.edu` (profile, holds, GPA, financial aid) |
| Degree audit | `degreeaudit.oci.unw.edu` (Degree Works), proxied by Flow |

Key globals read from the dashboard HTML:

```js
BACKEND_SERVER = "https://my.unw.edu/api";
SESSION_DOMAIN = ".my.unw.edu";
CSRF_COOKIE_NAME = "csrftoken";
FLOW_SERVER = "https://flow.my.unw.edu";
CUBE_API_URL = "https://cube.pathify.com/cubejs-api/v1";
METADATA.authentication = "SAML";
METADATA.auth_redirect_url = "https://my.unw.edu/api/core/saml_sso/1/";
```

---

## 2. Authentication

### 2.1 Observed flow (fresh profile)

```
GET https://my.unw.edu/dashboard
  -> 302 https://my.unw.edu/external/login?redirectTo=%2Fdashboard
  -> 302 https://login.microsoftonline.com/<tenant>/saml2?SAMLRequest=…&RelayState=…
  -> Entra ID: e-mail -> password -> TOTP ("Enter code")
  -> "Stay signed in?" = Yes
  -> https://my.unw.edu/external/login-success?redirectTo=%2Fdashboard
  -> https://my.unw.edu/dashboard
```

- **Identity provider:** Microsoft Entra ID (UNW tenant).
- **MFA:** TOTP verification code (the existing `totpSecret` works); no push/consent prompt was shown.
- **Consent:** none — the tenant has already consented to the portal SP.
- **"Stay signed in":** yes; creates `ESTSAUTHPERSISTENT` (≈90 days).
- **Result:** `sessionid` cookie issued for `.my.unw.edu`, expiry **30 days** out.

### 2.2 Warm profile

Second run: `mode: warm-profile`, zero credential steps, dashboard rendered from the
persistent profile at `~/.config/unw-mcp/browser-profile` (0700).

### 2.3 Is the existing teams-mcp Microsoft session reusable?

**Yes in principle, but do not depend on it.** A throwaway profile loaded with only the five
Entra cookies from `~/.config/teams-mcp/browser-profile` reached `/dashboard` without
credentials (`reusable: true`). Same account, same tenant. The new MCP keeps its **own**
profile because:

- two processes must not share one Chromium profile (lock contention);
- the portal profile also holds Flow/Banner sessions that Teams does not need;
- a dedicated profile makes the login/re-auth path deterministic and auditable.

Credentials are read from `~/.config/unw-mcp/credentials.json` if present, otherwise from the
existing `~/.config/teams-mcp/credentials.json` (never copied into the repo).

### 2.4 Session lifetime and cookies

| Cookie | Domain | Lifetime | Notes |
|---|---|---|---|
| `sessionid` | `.my.unw.edu` | 30 days, **fixed** | HttpOnly; the portal API session. Expiry did not slide after further requests. |
| `csrftoken` | `.my.unw.edu` | ~365 days | Required for POSTs; the MCP is read-only. |
| `devicetype` | `.my.unw.edu` | session | UI hint. |
| `ESTSAUTHPERSISTENT` | `.login.microsoftonline.com` | ~90 days | Entra "stay signed in"; enables silent re-auth. |
| `brcap`, `buid`, `fpc` | Entra | 30–390 days | Entra bookkeeping. |
| `JSESSIONID_ihub-frontend`, `GCLB` | `flow.my.unw.edu` | session | Flow session. |
| `JSESSIONID` (+ `X-Oracle-BMC-LBS-*`) | `registration-ss.oci.unw.edu`, `student-ss.oci.unw.edu` | session | One per Banner app; each app needs its own SAML handshake. |

There is **no bearer/refresh token** for the portal itself. The only JWT in the system is the
Flow **degree-audit `claims`** token, embedded in the dashboard widget list:

- `GET /api/v1/widgets/?shown=true` → widget `Degree Audit` → `.claims`;
- JWT `iat`/`exp` → **300 s TTL** (measured 298 s remaining);
- pass it as `?claims=<jwt>` to `flow.my.unw.edu/upstream/v1/degree-audit/degreeworks`.
- It contains name/e-mail/student id — **never log it**.

### 2.5 Re-authentication / refresh path (proved)

1. Delete only the `.my.unw.edu` cookies (keep Entra).
2. `GET https://my.unw.edu/dashboard`.
3. The portal redirects through `/external/login` → SAML → Entra, which auto-submits because
   `ESTSAUTHPERSISTENT` is valid; a new `sessionid` is issued.

Measured: **silent success in ~7–11 s including a 6 s settle wait** (`scripts/recon/session.mjs`).
If Entra also expires, the same driver falls back to e-mail + password + TOTP.

Logout endpoint (documented from the SPA, not exercised): `GET /api/core/saml_logout/`.
Banner apps use `/…/saml2/logout`; Flow uses its own `JSESSIONID`.

### 2.6 Auth matrix (measured without cookies)

| Endpoint | Unauthenticated |
|---|---|
| `GET my.unw.edu/api/v1/users/me/` | `401 {"errors":[{"message":"Authentication credentials were not provided."}]}` |
| `GET my.unw.edu/api/v2/events/?calendar=11` | `401` |
| `GET my.unw.edu/api/v1/notices/?limit=1` | `200` but empty result set (public subset only) |
| `GET flow.my.unw.edu/upstream/v1/balances` | `401 {"error":"not authenticated"}` |
| `GET flow.my.unw.edu/upstream/chapel_summary` | `200 {"when":…}` (no student data) |
| `GET flow.my.unw.edu/upstream/v2/bonappetit` | `200`, full 1.8 MB menu payload |
| `GET flow.my.unw.edu/pathify-api/v1/users/me/tasks/` | `401` |
| `GET registration-ss…/classSearch/getTerms` | `200` public term list |
| `GET registration-ss…/registrationHistory/reset` | `302` to SAML |
| `GET student-ss…/ssb/studentProfile` | `302` to SAML |
| `GET my.unw.edu/api/v2/events/calendars/ical/<uuid>/` | `200 text/calendar` |

---

## 3. Data map

Shapes are abbreviated; `<…>` marks redacted values. All portal lists are DRF-paginated
(`count`, `next`, `previous`, `results`) and accept `limit`/`offset`. Pathify also accepts
repeated `field=` parameters to trim payloads.

### 3.1 Dashboard

| What | Endpoint | Auth | Shape |
|---|---|---|---|
| Profile / identity | `GET /api/v1/users/me/` | session | `{advisors:[{id,name,email,campus_user}], alternate_id, email, name, extra_data:{degree:[{name,progress}],student_hold}, majors, schools, meal_plan_id, …}` |
| Dashboard layout | `GET /api/v1/dashboard/dashboards/active/` | session | `{id,name,is_default,content:{type:"root",children:[…sections/widgets…]}}` |
| Quick links | `GET /api/v1/dashboard/quick-link-cards/?active=true` | session | `[{id,title,links:[{title,url,…}]}]` (3 cards) |
| Widget catalog | `GET /api/v1/widgets/?shown=true` | session | `[{id,name,component,base_url,claims?,supports_theming,…}]` (14 widgets; includes the Degree Audit claims JWT) |
| Announcements / alerts | `GET /api/v1/notices/?notice_type=Emergency&notice_type=Alert&status=NO_STATUS&status=APPROVED&scheduled=false&expired=false&dismissed=false&limit=10&offset=0` | session | `{count,next,previous,results:[{id,notice_type,title,text,text_html,start_date,end_date,require_acknowledgment,seen_by_user,…}]}` |
| Task reminders | `GET /api/v1/tasks/reminders/me/?pending=true` | session | `{count,results:[…]}` (often 0; Flow `/tasks/` has the full list) |
| Favorites / tools | `GET /api/v1/favorites/` | session | `[{id,content_type,content_object:{title,link,category}}]` (6; e-mail, Moodle, schedule, …) |
| Subscribed calendars | `GET /api/v2/events/calendars/subscriptions/` | session | `[{id,calendar:{id,name,ical_feed_url},color}]` (20) |
| Today's events | `GET /api/v2/events/?offset=0&limit=10&current=true&field=id&field=title&field=start_date&field=end_date&field=all_day&field=location` | session | `{count,results:[{id,title,start_date,end_date,all_day,location,…}]}` — `count` is the whole subscription set, so filter by date client-side |
| Academic-calendar events | `GET /api/v2/events/?calendar=11&limit=…&current=true` | session | same shape (35 current events) |
| Flow tasks | `GET flow…/pathify-api/v1/users/me/tasks/` | session | `[{id,title,text,cta_text,link,due,is_required,is_complete,…}]` (3) |
| Inbox unread counts | `GET /api/v1/conversations/messages/unread-counts-by-parent/` | session | `[{parent, unread_count}]` |

The dashboard's own `content` tree only positions widgets; useful data comes from the widget
endpoints above, not from the layout JSON.

### 3.2 Student information

| What | Endpoint | Auth | Shape / notes |
|---|---|---|---|
| Academic profile | `GET flow…/pathify-api/v1/users/me/?field=extra_data&field=gpa&field=advisors` | session | `{gpa, extra_data:{degree:[{name,progress}],student_hold}, advisors:[…], major, schools, campus, course, department}` |
| Degree audit | `GET flow…/upstream/v1/degree-audit/degreeworks?claims=<jwt>` | session + 5-min JWT | `{degrees:[{name,courses,credits,enrollmentCumulativeGPA,enrollmentCreditsCompleted,percentComplete,requirements:[{name,target,progress,needed,percent}]}]}` — 5 degrees (BS + 2 majors + 2 minors) |
| Official GPA / hours | `GET student-ss…/StudentSelfService/studentProfile/viewGPAHoursList?studentId=<id>` | Banner session | `{overallGpa,overallHours,gpas:[{gpa,hours,hoursAttempted,levelDesc,typeDesc,gpaTypeIndicatorDesc}]}` |
| Holds | `GET student-ss…/StudentSelfService/studentHolds/showHolds?studentId=<id>` | Banner session | `{holds:[{description,fromDate,toDate,typeCode,amountOwed,releasableFlag,showWeb}],holdCount,currencyCode,hasHidden}` |
| Registration standing | `GET student-ss…/StudentSelfService/studentProfile/viewRegistrationNotices?studentId=<id>` | Banner session | `{standingAsOf,academicStanding,timeTickets:[],enrollmentStatus,regStudentStatus:{allowsRegistration,description},timeTicketRequired,count}` |
| Banner terms | `GET registration-ss…/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=20` | **public** | `[{code:"202620",description:"Spring 2027"}]` |
| Schedule + grades by term | `GET registration-ss…/StudentRegistrationSsb/ssb/registrationHistory/reset?term=<code>` | Banner session | `{data:{registrations:[{subject,courseNumber,courseTitle,courseReferenceNumber,creditHour,grade,gradeDate,instructorNames,partOfTerm,startDate,addDate,meetingTimes:[{beginTime,endTime,monday…sunday,building,room,startDate,endDate}]}],totalCredit,totalBill,…}}` |
| Pre-registration status / time ticket | `POST …/ssb/term/search?mode=preReg` with `term=<code>`, then HTML `…/ssb/prepareRegistration/prepareRegistration` | Banner session | HTML with holds list, class standing, earned hours (institution + transfer), time ticket window — **no JSON endpoint** |
| Financial aid years | `GET student-ss…/StudentSelfService/ssb/applicantActiveAidYears/getApplicantActiveAidYears` | Banner session | `{ActiveAidyears:[{aidyCode,period,aidyEndYear}]}` |
| Aid offer | `GET student-ss…/StudentSelfService/ssb/awardLetter/getAwardInfo?aidyCode=<2627>` | Banner session | `{awardInfo:{data:[{fundCode,fundTitle,awrdOfferAmt,fundType,accept,activeStatus,…}]},…}` (22 awards) |
| Cost of attendance | `GET …/awardLetter/getCostOfAttendance?aidyCode=<2627>` | Banner session | `{data:[{longDesc,amount,periodDesc,bcatCode,billableInd}]}` |
| Award history | `GET …/awardHistory/getAwardHistoryForAidYearDetails?aidyCode=ALL&aidyDesc=All+Years` | Banner session | `{awardHistory:[{aidyCode,fundTitle,paidAmount,acceptAmount,fundType,…}]}` |
| Student account + dining funds | `GET flow…/upstream/v1/balances` | session | `{alternate_id, balances:[{name:"Student Account",amount},{name:"Dining Funds",amount}]}` |
| Chapel / spiritual-development credit | `GET flow…/upstream/chapel_summary` | session | `{when,responseInfo:{alternate_id,credits_earned,credits_required,modified_date,period_description}}` |
| Meal plan | — | — | Only the `Dining Funds` balance and static `meal-plan-information` page; no swipe-count endpoint found |
| Housing | — | — | No assignment/roommate endpoint found. Only content pages (`housing` category) and the Mazevo room-reservation tool |

`studentId` is the Banner ID (`alternate_id` from `/api/v1/users/me/`), not the e-mail.
Banner apps each have **separate** sessions; a `JSESSIONID` created by an unauthenticated
request makes `registerPostSignIn` skip SAML, so clear guest cookies before the handshake.

### 3.3 Dining (public — no login)

`GET https://flow.my.unw.edu/upstream/v2/bonappetit` → 1.8 MB, ~0.4–1.3 s.

```jsonc
{
  "lastUpdated": 1794921268614,          // epoch ms
  "campuses": { "76": { "cafes": {
    "189": { "name": "The Dining Center", "address": "...", "city": "Roseville",
             "weekly_schedule": "<html>...", "message": "<html>...", "eod": "02:00",
             "timezone": "America/Chicago", "menu_type": 1 }
  }}},
  "data": { "189": { "2026-11-17": {
    "days": [{ "date": "2026-11-17", "cafes": { "189": {
      "dayparts": [[{ "label": "Breakfast", "starttime": "07:20", "endtime": "09:30",
        "stations": [{ "label": "breakfast", "items": ["5332645", "..."] }] }]]
    }}}],
    "items": { "5332645": { "label": "cage-free egg", "recipes": {...} } }
  }}}
}
```

- 3 cafes: The Dining Center, Eagles' Nest, The Heritage Café & Coffee Shop.
- Menus cover **7 rolling days** (`data.<cafeId>.<YYYY-MM-DD>`); item labels live in
  `data.<cafeId>.<date>.items[id].label` (inside the day, **not** at the payload root).
- Heritage Café had no published menu on the sampled date (open/closed status only).
- `weekly_schedule` is HTML; `message` carries holiday/closure notices.
- Public alternative: the `unwsp.edu` site links to Bon Appétit, but this upstream JSON is the
  cleanest machine source and needs no auth.

Proof: `node scripts/recon/dining.mjs` (prints today's stations and items).

### 3.4 Academic calendar (public — no login)

The university page `https://www.unwsp.edu/academics/academic-calendar/` embeds **three public
Google Calendars**. Their ICS feeds are the best source:

```
https://calendar.google.com/calendar/ical/<calendar-id>/public/basic.ics
```

Discovered IDs (truncated here):

| Feed | Events | Contents |
|---|---|---|
| `584a1799…` | 39 | AGS / adult & graduate |
| `c9a1b80a…` | 86 | Dual enrollment / online |
| `7i7krnhh…` | 856 | **TRAD** — semester dates, breaks, finals, deadlines |

TRAD ICS includes (verified):

```
20261125 TRAD: No Classes - Thanksgiving Recess
20261211 TRAD: Courses End - Fall Semester & Quad 2
20261214 TRAD: Final Exams - Fall Semester & Quad 2
20261217 TRAD: Semester Ends - Fall 2026
20270111 TRAD: Semester Begins - Spring 2027
20270326 TRAD: No Classes - Easter Recess
20270510 TRAD: Final Exams - Spring Semester & Quad 4
```

Proof: `node scripts/recon/calendar.mjs` (discovers the feeds from the public page, parses ICS,
prints upcoming breaks/deadlines). Portal calendar id `11` ("Trad Academic Calendar") also works
but needs a session and adds nothing over the ICS.

### 3.5 ICS feeds

- **Public per-calendar ICS:** `GET my.unw.edu/api/v2/events/calendars/ical/<uuid>/` — 4 of the
  20 subscribed calendars expose `ical_feed_url` (Core Student Activities, SDC Daily/Alternative
  Chapel, Student Government, UNW Eagle Scholars). The rest are empty strings.
- **Classes:** no student-specific ICS feed. Generate one from Banner
  `registrationHistory/reset` meeting times (day flags + `beginTime`/`endTime`).
- **Academic calendar:** use the Google ICS feeds above.

### 3.6 Search, notifications, content pages

| What | Endpoint | Auth | Notes |
|---|---|---|---|
| Global search | Pathify search UI (`/search` routes) backed by `/api/v1/pages/?search=`, `/api/v1/users/?search=` | session | `searchUsers` and page search exist; no single unified search endpoint found |
| Page search | `GET /api/v1/pages/?search=<q>&limit=10` | session | DRF list; pages include `body`, `body_html`, `category` |
| Page by slug | `GET /api/v1/pages/slug/<slug>/` | session | Full HTML/markdown content (e.g. `registration-holds-trad`, `meal-plan-information`, `student-accounts-home`) |
| Notifications | `GET /api/v1/users/me/notifications/` and `/api/v1/notifications/preferences/` | session | Preferences list 36 types; notifications support pagination + `markallasread` (write — not used) |
| Directory | `/api/v1/directory/…` | session | Not needed for a secretary workflow |

---

## 4. Token-efficient extraction plan

| Data | Call | Cache TTL | Trimming |
|---|---|---|---|
| Session/auth | `GET /api/v1/users/me/` | — | Use as health check; discard body after extracting `alternate_id`, `extra_data` |
| Announcements | notices with `limit=5` | 2 min | Request only `id,notice_type,title,text,start_date,end_date`; strip HTML |
| Today's schedule | `registrationHistory/reset?term=<current>` | 10 min | Filter meeting day flags to today, sort by `beginTime`; return 5 fields |
| Full schedule/grades | same endpoint per term | 30 min | Course + `meetingTimes` only; drop override flags |
| GPA/credits | `viewGPAHoursList` + degree audit | 30 min | Return `overallGpa`, `overallHours`, per-level rows |
| Holds | `showHolds` | 5 min | Return description/dates/releasable only |
| Registration | `viewRegistrationNotices` + prepareRegistration HTML regex | 5 min | Parse time ticket + standing; do not return raw HTML |
| Degree audit | widgets → claims → upstream | 10 min (claims 5) | Return degree names, percent, credits, requirements |
| Balances | `upstream/v1/balances` | 5 min | Two rows only |
| Chapel | `upstream/chapel_summary` | 15 min | 4 fields |
| Dining | `upstream/v2/bonappetit` | 1 h (public) | **Never return the 1.8 MB payload**: project `cafes → dayparts → station labels + item labels` for the requested date; keep a 7-day local cache |
| Academic calendar | 3 Google ICS | 6 h | Parse only `SUMMARY`/`DTSTART`; filter keywords (break/recess/final/deadline) |
| Events | `/api/v2/events/` with `field=` | 5 min | Always pass `limit`, `current=true`, and date bounds |
| Content pages | `/api/v1/pages/slug/<slug>/` | 24 h | Return `body` text, drop `body_html` unless asked |
| Financial aid | aid years → award letter | 1 h | Return fund title/amount/status rows; drop messages |

Rules of thumb:

- Prefer **Pathify `field=`** and Banner endpoints that already return only what is needed.
- Never fetch `events` without `limit`; `count` is global, so filter client-side.
- Strip HTML from notices, pages, dining schedules before returning to an LLM.
- Cache dining and calendar aggressively (public, slow-changing); cache personalized data for
  minutes, not hours.

---

## 5. Proof

All commands run from the repo root, Node 22+ and Playwright Chromium installed.

| Command | Proves |
|---|---|
| `node scripts/recon/login.mjs` | Fresh login (6 steps: e-mail, password, TOTP, KMSI) or warm profile; writes a redacted session report |
| `node scripts/recon/login.mjs --reuse-test` | Teams-mcp Entra cookies alone reach the dashboard (`reusable: true`) |
| `node scripts/recon/session.mjs` | Cookie inventory + lifetimes; clears portal cookies and silently re-authenticates |
| `node scripts/recon/probe.mjs` | 25+ authenticated endpoints: profile, dashboard, notices, events, Flow, degree audit, Banner history/holds/GPA/financial aid; prints counts/shapes and today's classes |
| `node scripts/recon/dining.mjs` | Public dining menus for today, all 3 cafes, no session |
| `node scripts/recon/calendar.mjs` | Public academic calendar: 3 ICS feeds, 981 events, upcoming breaks/finals |

Observed proof points:

- dashboard fetch returned the student profile, degree progress, advisor record, 14 widgets,
  3 quick-link cards, 1 alert notice, 20 calendar subscriptions, 609 current events;
- degree audit returned 5 degree/major/minor records with completion percentages;
- Banner returned three terms of registration history (Spring 2026, Fall 2026, Spring 2027),
  including grades for completed terms and meeting days/times for the current term;
- today's schedule derived from Banner contained 3 Tuesday classes;
- dining returned 3 cafes × 7 days with station-level item labels;
- academic calendar returned Thanksgiving recess, final exams, semester end, spring start, and
  Easter recess from the public ICS.

Raw evidence: `~/.cache/unw-mcp-recon/raw/{session,probe}-<ts>.json`,
`banner-history.json`, `grades.json`, `student-ss-menu.json`,
`prepareRegistration.html`; screenshots in `~/.cache/unw-mcp-recon/shots/`.

---

## 6. Blockers and caveats

1. **Housing assignment/roommate data is not exposed.** Only housing content pages exist; no
   StarRez/room-selection API was found. Room *reservations* use Mazevo (separate login).
2. **Meal plan usage** (swipes left) is not in the portal; only the Dining Funds balance is.
3. **Time ticket and hold text** have no JSON endpoint in registration-ss; they must be parsed
   from `prepareRegistration` HTML (brittle but stable text). Holds themselves are JSON in
   student-ss.
4. **Grades page** (`studentGrades/term`) only offered Spring 2026 and returned no courses for
   it; use `registrationHistory/reset` for posted grades and `viewGPAHoursList` for GPA.
5. **`getRegistrationEvents`** returned an empty array in several runs even when a term was
   selected; do not depend on it. Derive today's classes from history meeting days.
6. **Banner sessions are per-app.** `registration-ss` and `student-ss` each need their own SAML
   handshake. A guest `JSESSIONID` suppresses the handshake — clear it first.
7. **Degree audit claims** expire in 5 minutes and contain PII; re-fetch `/api/v1/widgets/`
   before each audit call and never log the JWT.
8. **No class ICS feed.** Generate it from Banner meeting times if the MCP needs one.
9. **Pathify version drift**: `6.61.9` APIs are stable REST but not contractual; shape checks
   and graceful degradation are required.
10. **Write operations** (register/drop, form submission, payments, personal info) were not
    exercised; the MCP should ship read-only for now.

---

## 7. Recommended MCP tool surface (build phase, not implemented)

Keep the surface small and op-dispatched; each tool returns compact text (or JSON on request).

| Tool | Ops | Backing calls | Cache |
|---|---|---|---|
| `unw_session` | `status`, `reauth` | profile probe; silent SAML | — |
| `unw_dashboard` | `overview`, `announcements`, `tasks`, `events`, `quick_links` | `/api/v1/users/me/`, notices, flow tasks, events, quick links | 2–5 min |
| `unw_academics` | `profile`, `today`, `schedule`, `grades`, `gpa`, `holds`, `registration`, `degree_audit` | Banner history/GPA/holds/preReg, Flow degree audit | 5–30 min |
| `unw_finances` | `balances`, `financial_aid`, `meal_plan` | balances, aid years/award letter, dining funds | 5–60 min |
| `unw_dining` | `today`, `week`, `locations` | public bonappetit JSON | 1 h |
| `unw_calendar` | `academic`, `breaks`, `deadlines`, `events`, `ics` | Google ICS + Pathify events | 5 min–6 h |
| `unw_pages` | `search`, `get` | `/api/v1/pages/…` | 24 h |

Design notes:

- **One `PortalClient`** owning a single headless persistent Chromium context. Use
  `browserContext.request` for `my.unw.edu`/`flow.my.unw.edu`; use `page.evaluate(fetch)` for
  Banner origins because their SSO cookie does not reliably reach the API request context.
- **Re-auth middleware:** on `401`, `302 → /external/login`, or an HTML body where JSON was
  expected, navigate once to `/dashboard` (or `/api/core/saml_sso/1/`), wait for the shell, and
  retry the call exactly once. Only if that fails, run the credential+TOTP driver.
- **Serialization:** Playwright contexts/pages are not concurrency-safe; queue requests through
  one async mutex. Parallelize only pure `fetch` calls (dining, Google ICS).
- **Projection at the edge:** each tool maps upstream JSON to 5–12 fields. Do not forward raw
  Pathify/Banner objects; they are large and contain PII and internal flags.
- **Redaction:** strip `alternate_id`, e-mail, names, balances and tokens from logs. The
  degree-audit `claims` JWT must never be cached on disk.
- **Failure semantics:** distinguish `auth_required` (needs login), `unavailable` (portal down),
  `not_exposed` (housing/meal swipes) so the assistant can answer honestly.

---

## 8. Files

```
scripts/recon/login.mjs        # persistent-profile login + session capture + teams reuse test
scripts/recon/session.mjs      # cookie lifetimes + silent re-auth proof
scripts/recon/probe.mjs        # authenticated endpoint catalog (redacted output)
scripts/recon/dining.mjs       # public dining menus
scripts/recon/calendar.mjs     # public academic calendar / ICS
scripts/recon/lib/paths.mjs    # config/cache paths, credentials, redaction
scripts/recon/lib/browser.mjs  # launcher, SAML state machine, network/cookie capture
scripts/recon/lib/totp.mjs     # RFC 6238 TOTP
docs/portal-recon.md           # this document
```

Secrets and profiles live only under `~/.config/unw-mcp/`; raw captures only under
`~/.cache/unw-mcp-recon/`.
