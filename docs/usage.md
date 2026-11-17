# Usage

All examples are synthetic. Replace dates and amounts with whatever the tools return; never
commit real student data.

## Start every session with a status check

```
unw_session { "op": "status" }
```

A warm profile answers in ~1 s:

```json
{
  "authenticated": true,
  "state": "authenticated",
  "cookies": {
    "portal_session": { "name": "sessionid", "daysLeft": 30, "httpOnly": true },
    "flow_session": true,
    "entra_sso": true
  }
}
```

If `authenticated` is false, call `unw_session { "op": "reauth" }` once. It returns the same
shape plus `auth_method` (`warm-profile`, `silent-saml`, or `credentials`). Do not retry a
failed password flow in a loop.

## "Plan my day"

```
unw_dashboard { "op": "day" }
```

`day` is the one-call agenda: today's classes with times/rooms, campus events starting in the
next 24 hours, pending tasks and the current/next Dining Center meal with a few options.

```json
{
  "op": "day",
  "date": "2026-11-17",
  "day": "Tue",
  "classes_total": 3,
  "classes": [{ "start": "10:00", "end": "10:50", "course": "TST 1010", "location": "TEST T101" }],
  "events": [{ "title": "Prayer Chapel", "local": "2026-11-17 09:55 → 10:35" }],
  "tasks_pending": 3,
  "tasks": [{ "title": "Task", "due": "2026-11-18T00:00:00Z" }],
  "announcements": [{ "title": "Registration window", "type": "Alert" }],
  "next_meal": {
    "cafe": "The Dining Center",
    "meal": "Lunch",
    "start": "10:30",
    "end": "14:35",
    "stations": [{ "label": "grill", "items": ["burger", "fries"] }]
  }
}
```

If the public menu is down, `dining_status: "unavailable"` is set and the rest of the day is
still returned. Call `unw_dashboard op=overview` for identity/degree progress/announcements.

## "What's on my plate today?"

```
unw_dashboard { "op": "overview" }
unw_academics { "op": "today" }
```

`overview` combines identity, degree progress, three notices, five pending tasks and today's
events. `today` is the class list derived from Banner meeting days:

```json
{
  "op": "today",
  "date": "2026-11-17",
  "day": "Tue",
  "term": { "code": "202610", "description": "Fall 2026" },
  "count": 1,
  "classes": [
    {
      "start": "10:00",
      "end": "10:50",
      "course": "TST 1010",
      "title": "Example Course",
      "crn": "10001",
      "location": "TEST T101",
      "instructors": ["Doe, Jane"]
    }
  ]
}
```

A `count` of 0 with a correct `date`/`day` means no meetings, not a failed call.

## "Show my schedule / grades"

```
unw_academics { "op": "schedule" }
unw_academics { "op": "schedule", "term": "Spring 2027" }
unw_academics { "op": "grades" }
unw_academics { "op": "grades", "term": "202520" }
```

`schedule` returns courses with meeting rows (`days`, `start`, `end`, `location`, `from`,
`to`) and a term credit total. `grades` without a term checks the three most recent terms at
or before the current one and returns only completed courses; `latest_term` tells you which
term the grades came from.

## "What's my GPA / do I have holds?"

```
unw_academics { "op": "gpa" }
unw_academics { "op": "holds" }
unw_academics { "op": "registration" }
```

GPA is Banner's official `viewGPAHoursList`: overall GPA/hours plus per-level rows
(institution, transfer, overall). Zero GPAs are values, not missing data. Holds show
description, type, date range, releasability and any amount owed. Registration returns
standing and `allowsRegistration`; `time_ticket_source: "not_exposed"` means the window is
only in HTML that this read-only server does not fetch.

## "How close am I to finishing?"

```
unw_academics { "op": "degree_audit" }
```

```json
{
  "op": "degree_audit",
  "count": 2,
  "degrees": [
    {
      "name": "Degree: Bachelor of Science",
      "percent": 75,
      "credits": 90,
      "gpa": 3.25,
      "requirements_total": 3,
      "requirements_available": true,
      "requirements": [
        {
          "name": "Bachelor of Science degree minimum credits",
          "target": 120,
          "progress": 90,
          "needed": 30,
          "percent": 75
        }
      ]
    }
  ]
}
```

Majors/minors report `requirements_available: false` with no `requirements` array when the
upstream audit has no requirement detail. That means "not exposed", not "complete"; on the
live account 4 of 5 programs have no detail and only the degree record does. Requirements are capped at 50 per degree and
`requirements_total` preserves the real count.

## "What do I owe / how is financial aid?"

```
unw_finances { "op": "balances" }
unw_finances { "op": "financial_aid" }
unw_finances { "op": "financial_aid", "aid_year": "2025-2026" }
unw_finances { "op": "chapel" }
```

Balances return `Student Account` and `Dining Funds`; a negative account balance is a credit.
Financial aid returns the selected aid year, award rows with `amount`/`offered`/`status`,
per-period totals, cost-of-attendance rows and `cost_total`. Pass a code (`2627`) or a label
(`2026-2027`) to inspect a different year. Chapel returns `credits_earned`,
`credits_required`, `remaining`, `percent` and the period label.

## "What's for lunch? / What's open this week?"

```
unw_dining { "op": "locations" }
unw_dining { "op": "today" }                                  # brief: 6 stations × 8 items
unw_dining { "op": "today", "cafe": "eagles" }
unw_dining { "op": "today", "meal": "lunch" }                 # one daypart
unw_dining { "op": "today", "cafe": "Dining Center", "meal": "lunch" }
unw_dining { "op": "today", "detail": "full" }                # configured 12 × 25 caps
unw_dining { "op": "today", "date": "2026-11-18" }
unw_dining { "op": "week" }
```

`today` returns only the requested date's cafes:

```json
{
  "op": "today",
  "date": "2026-11-17",
  "status": "ok",
  "cafes": [
    {
      "name": "The Dining Center",
      "status": "ok",
      "dayparts": [
        {
          "label": "Breakfast",
          "start": "07:20",
          "end": "09:30",
          "stations": [
            { "label": "breakfast", "items": ["cage-free egg", "pork sausage"] }
          ]
        }
      ]
    },
    { "name": "The Heritage Café", "status": "no_menu" }
  ]
}
```

`status: "no_menu"` on a cafe means no menu is published for that date; `no_meal` means the
cafe has a menu but not the requested daypart. `not_available` means the date is outside the
7 rolling days and `available_dates` lists what exists. `week` keeps only daypart counts and
five sample labels per daypart.

## "When is Thanksgiving break / finals / spring semester?"

```
unw_calendar { "op": "breaks", "query": "thanksgiving" }
unw_calendar { "op": "deadlines" }
unw_calendar { "op": "academic", "days": 365, "limit": 20 }
unw_calendar { "op": "events", "days": 7 }
```

```json
{
  "op": "breaks",
  "kind": "breaks",
  "window": { "from": "2026-11-17", "to": "2027-11-17", "days": 365 },
  "count": 2,
  "items": [
    { "date": "2026-11-25", "summary": "No Classes - Thanksgiving Recess", "audiences": ["TRAD"] },
    { "date": "2027-03-26", "summary": "No Classes - Easter Recess", "audiences": ["TRAD"] }
  ]
}
```

Cohort prefixes from the three public feeds are merged into `audiences`. The academic
calendar is public and cached for six hours. `events` is the authenticated campus-events
feed, filtered to the local-date window.

## "Find the registration holds page"

```
unw_pages { "op": "search", "query": "registration", "limit": 10, "excerpt_chars": 120 }
unw_pages { "op": "get", "slug": "registration-holds-trad" }
```

Search rows carry `slug`, `title`, `category` and `excerpt`, ranked with exact title/slug
matches first. Excerpts default to 120 characters (`excerpt_chars`, max 400). The result
also has upstream `count` and `truncated` (more matches exist than the returned rows). `get` returns the plain-text body (4,000-char cap) plus `body_chars` and
`body_truncated`. A missing slug returns `{ "status": "not_found", "slug": "…" }`; it is not
an error.

## Agent guidance

- Call `unw_session status` before a batch of academic/finance work; one reauth covers the
  rest. The first authenticated call on a cold profile can take ~90 s; warm calls are ~1 s.
- Prefer `unw_dashboard op=day` for "plan my day"; it reuses the same caches as the
  individual academic/event/dining ops.
- Prefer one op that answers the question over several. `overview` is cheaper than
  `announcements` + `tasks` + `events` separately.
- Use `term` only when the user named a term or the default answer is clearly wrong.
- For food, ask which cafe/day only if the user did; `today` already scopes to the requested
  date and `week` is compact enough to scan.
- For dates, prefer `breaks`/`deadlines` over `academic`; `academic` is the broader list.
- Treat `not_exposed`/`unavailable`/`status: "not_found"`/`status: "no_menu"` as facts to
  report. Do not invent a time ticket, housing assignment, meal-swipe count, menu item or
  calendar date.
- Do not paste names, e-mail addresses, IDs or balances from tool output into a repository,
  ticket or log.
