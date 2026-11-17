# Cold-agent use-case eval: myUNW MCP as a student-info secretary

Date: 2026-11-17. Harness: `opencode` v2.2.7 (standalone, `--format json`),
model `deepseek/deepseek-v4-pro`, one session, ten natural prompts, no tool
hints, no repo access. Server under test:
`node <repo>/dist/index.js` (stdio). Account data was live but the
run was strictly read-only. Everything below is measurement; the server was not
modified and no fixes are proposed in code.

> Privacy: no names, IDs, emails, balances, GPA values or page bodies are
> reproduced here. Correctness is reported as match/mismatch against a direct
> read-only check, plus counts and shapes.

## 1. Method

| Piece | Detail |
| --- | --- |
| Isolation | separate `HOME=/tmp/unw-eval/home`, separate `opencode` data dir, config `/tmp/unw-eval/home/.config/opencode/opencode.json` |
| MCP config | exactly one server: `unw` → `node <repo>/dist/index.js` |
| Agent | default primary agent, permissions deny `read/write/edit/shell/glob/grep/webfetch/websearch/subagent/task_*`; only MCP + `question` survive |
| Session | one `opencode` session (`ses_unweval_eval-2`), ten `run --session …` turns in order, so context accumulates as in a real chat |
| Driver | `scripts/dev/eval-unw-cold-agent.sh` (writes `turn-NN.json`, `.rc`, wall-clock marks, `summary.json`) |
| Analyzer | `scripts/dev/eval-unw-summarize.py` (steps, MCP calls, ops, tool bytes, tokens, retries) |
| Surface probe | `scripts/dev/eval-unw-verify.py` (independent stdio client; prints op enums and response *shapes* only) |

Environment caveat, reported honestly: this `opencode` build is a fork whose
Code Mode also exposes non-`unw` servers (`charlotte` browser control,
`google_search`, `opencode`). They cannot be removed by config. They were only
touched in turn 7 (8 wasted calls, all failing) — no data came from them.

Measurement definitions: a "step" is one assistant turn inside `opencode`;
"unw call" is one `tools.unw.<tool>({op})` invocation, which may batch several
ops in one step; "tool bytes" is the MCP payload handed to the model (the token
tax), "answer bytes" is the student-facing reply.

## 2. Surface the agent actually saw

7 tools / 27 ops, all read-only:

| Tool | Ops |
| --- | --- |
| `unw_session` | status, reauth |
| `unw_dashboard` | overview, announcements, tasks, events, quick_links |
| `unw_academics` | profile, today, schedule, grades, gpa, holds, registration, degree_audit |
| `unw_finances` | balances, financial_aid, chapel |
| `unw_dining` | locations, today, week |
| `unw_calendar` | academic, breaks, deadlines, events |
| `unw_pages` | search, get |

The tools are opaque to the harness index: `search({query:"gpa"})` and friends
return `{"items":[]}`. The only way to discover `tools.unw.*` is
`search({query:"", namespace:"unw"})` (4.8 KB of schema), which the agent found
late in turn 7. Every other turn paid 3 empty `search` calls before calling
`unw`.

## 3. Results

| # | Prompt | Steps | unw calls (ops) | aux calls | tool out B (unw / aux) | answer B | tokens in/out | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | lunch at the Dining Center | 4 | 2 (dining.locations, dining.today) | 4 | 16,994 / 2,025 | 993 | 11,070 / 684 | 34.2 |
| 2 | classes today, times, locations | 3 | 1 (academics.today) | 3 | 893 / 153 | 441 | 1,933 / 362 | 105.2 |
| 3 | Thanksgiving / finals / spring start | 3 | 2 (calendar.breaks, calendar.academic) | 3 | 5,650 / 153 | 354 | 3,293 / 348 | 20.6 |
| 4 | GPA and holds | 3 | 2 (academics.gpa, academics.holds) | 3 | 822 / 1,094 | 312 | 2,107 / 327 | 22.5 |
| 5 | dining funds and account balance | 3 | 1 (finances.balances) | 3 | 188 / 153 | 145 | 1,798 / 252 | 16.8 |
| 6 | degree progress across programs | 3 | 1 (academics.degree_audit) | 3 | 1,586 / 102 | 637 | 2,130 / 370 | 24.9 |
| 7 | portal page about registration holds | 10 | 4 (dashboard.quick_links, academics.registration, pages.search, pages.get) | 8 | 8,227 / 19,435 | 1,269 | 9,552 / 1,163 | 52.7 |
| 8 | pending announcements and tasks | 3 | 2 (dashboard.announcements, dashboard.tasks) | 3 | 1,924 / 153 | 895 | 2,292 / 476 | 20.4 |
| 9 | campus events this week | 3 | 1 (calendar.events) | 3 | 16,879 / 102 | 1,781 | 8,002 / 745 | 30.7 |
| 10 | best way to plan my day | 1 | 0 | 0 | 0 / 0 | 1,886 | 157 / 539 | 24.6 |
| **Σ** | | **36** | **16** | **33** | **53.2 KB / 23.4 KB** | **8.7 KB** | **42.3K / 5.3K** | **353** |

Cache reads across the session: 924 K tokens. Cost: $0.068 for the whole
session. Errors: 1 (a `question` tool call that cannot work headless, not the
MCP). Retries: 0. Every turn exited 0.

## 4. Correctness (checked against direct read-only calls)

Each answer was re-derived independently by the stdio probe and compared
value-for-value; only the verdict is recorded here.

| # | Verdict | Notes |
| --- | --- | --- |
| 1 | correct | Lunch daypart, stations and items matched exactly, including the late-night café alternative. One label bug: it wrote "Mon, Nov 17"; the date is a Tuesday (the dining payload carries no date/day field to anchor it). |
| 2 | correct | 3 classes, times and rooms matched; it independently flagged the real 4:40/4:45 overlap between the last two. |
| 3 | correct | Thanksgiving recess (TRAD), finals 14–17 Dec, spring start 11 Jan 2027 — all matched, including the MLK exclusion note. |
| 4 | correct | GPA, hours split and the single active hold (type, window, non-releasable) matched. |
| 5 | correct values | Both balances matched to the cent. The *interpretation* ("negative means credit in your favour") is the model's inference: the payload is `{name, amount}` with no sign convention, so this is an unlabelled trap. |
| 6 | correct | 5 programs, percentages and credit totals matched, including the remaining-credit gap. A zero GPA was rendered "—" (good call: 0 here means ungraded, not failing). |
| 7 | correct | Page body matched; it also cross-referenced the student's actual hold against the page's "common holds" list and correctly said the student's hold is not on it. |
| 8 | correct | 1 announcement (requires ack) and 3 pending tasks matched, including the overdue-August caveat. |
| 9 | correct, minor label | All listed events matched; recurring chapel/hall events were sensibly compressed. Window was stated as "Tue 17 – Mon 23" while the payload ran to Nov 24 (one recurring event, no material loss). |
| 10 | sound synthesis | Zero tool calls: reused turn 2/9/8 data, correctly re-flagged the class overlap, and proposed an order of operations. No invented values. |

Nothing was wrong in a way that would mislead a student materially. Two
correctness-adjacent risks are model-side inferences (sign of the account
balance, weekday label), both traceable to thin payloads rather than bad data.

## 5. Where the agent over-read, and what it cost

- Turn 1: `dining.today` returns **every café × every daypart** (17 KB) for a
  question about one lunch. The agent first had to call `dining.locations` to
  disambiguate "Dining Center", and even opened a clarifying `question` (dead
  in headless mode). A `cafe` filter exists but the op still returns the whole
  day, so lunch costs breakfast+dinner tokens.
- Turn 7: 10 steps, 27.7 KB of tool output, 9 of 12 calls spent on discovery or
  third-party servers (only the page search/get pair produced the answer). Two
  causes: (a) `pages.search` returned **69 hits**
  for "registration holds" with no ranking, so the slug had to be guessed from
  the first excerpt; (b) the harness tool index does not know `unw`, so three
  `search` calls returned empty.
- Turn 9: `calendar.events` returned 50 rows / 16.9 KB, dominated by recurring
  chapel and hall Bible studies; the model did the de-duplication by hand.
- Every turn 1–9: 3 empty `search` calls (33 aux calls total vs 16 unw calls),
  ≈2.5 KB and ~2 s of tool time per turn, plus the tokens to reason about them.

## 6. Latency

Two regimes, both visible in one session:

- **Cold (first authenticated call of the process): 87.6 s** for
  `academics.today`; my independent probe measured 78 s for `academics.profile`.
  This is the portal/browser session bootstrapping.
- **Warm: 0.2–7.4 s per call** (dining/finances/calendar < 2 s once primed;
  degree audit 7.4 s). The whole ten-turn conversation took 5 min 53 s wall,
  of which ~90 s was that one cold call.

For "ask it a question in the morning" use, the 90 s first answer is the
dominant cost; subsequent questions in the same session feel fast.

## 7. Top gaps, ranked by student value / token cost

1. **No daily-agenda primitive.** `dashboard.overview` gives identity +
   announcements + tasks + *events* — but not today's classes, meal window or
   balances. Turn 10 is exactly the question students ask, and answering it
   cold needs 4–6 calls across 4 tools. Highest value, and it is the cheapest
   to serve (the server already has every piece).
2. **Degree audit has no remaining-requirement detail.** `degree_audit`
   returns five programs but `requirements: []` and `requirements_total: 0`
   for the four component programs; the student sees a percentage and cannot
   act on it. The one program with detail (BS) showed 3 requirements.
3. **Dining op granularity.** One café, one daypart is the natural unit;
   today's op returns all cafés × all meals (17 KB for a lunch question).
   A `cafe` + `daypart`/`meal` scoping (or a slim default of the current
   daypart) is the single largest token win observed.
4. **`pages.search` relevance.** 69 hits / 4.8 KB for a two-word query, no
   ranking, no slug in the excerpt. Top-5 ranked results with slug+category
   would cut turn 7's discovery cost by an order of magnitude.
5. **Event stream noise.** 50 rows / 16.9 KB per week with recurring chapel
   and hall studies inline. A `recurring` flag or an `exclude_recurring`
   switch lets the model compress without guessing, and prevents accidental
   omission when it compresses.
6. **Unlabelled sign convention on balances.** `{name, amount}` with a
   negative student-account amount forced the model to infer "credit". One
   wrong inference here is a money question; a `label`/`display` field is cheap.
7. **90 s cold start.** Acceptable per session, painful per question if the
   student re-asks in a new process. Persisting the portal session across MCP
   server restarts (or a warm-up ping) would fix the felt latency.
8. **Small anchors.** `dining.today` has no `date`/`day` in the response (the
   model invented "Mon"); `unw_pages` bodies are plain text with no stable
   heading map, so summaries are model-shaped.

Cheap wins that did not rank high enough on their own: a `help`/`capabilities`
op returning the 27-op menu in one small payload (the harness index won't
learn the tools otherwise), and date/day fields wherever times are returned.

## 8. Safety and final state

- 16 MCP calls, all in `{profile, today, gpa, holds, degree_audit, balances,
  breaks, academic, events, announcements, tasks, quick_links, registration,
  pages.search, pages.get, dining.locations, dining.today}` — read-only by
  construction; the server exposes no write op at all.
- No `unw_session reauth`, no portal navigation to action URLs, no form
  submissions, no registration/payment calls. The one browser-control attempt
  (turn 7, third-party `charlotte` server) failed at launch and fetched nothing.
- No portal state change: the run only ever read. Independent probe calls after
  the session returned the same values the agent had reported, so no drift.
- Credentials used for the eval were copies under `/tmp/unw-eval/home`; nothing
  was written back to the real `~/.config/unw-mcp` profile.

## 9. Verdict

**Usable daily as a read-only student-info secretary: yes, with caveats.**
Every question was answered correctly from live data, with no retries, no
hallucinated values and a coherent multi-turn memory; the total cost was under
$0.07 and under six minutes. What keeps it from being a *good* daily
secretary is not accuracy but shape: 3 discovery calls before every first
MCP call, a 90 s cold start, and payloads that hand the model an entire week
of events or an entire day of dining when the question was "what's for lunch".
Fixing gaps 1, 3 and 4 (agenda op, dining scoping, pages ranking) would cut the
observed token volume roughly in half without touching what already works.
It is not a planner or an actor: it cannot register, pay or submit, and it
should not be sold as one.

## 10. Reproduce

```bash
# one isolated HOME, one session, ten prompts, JSON per turn
scripts/dev/eval-unw-cold-agent.sh eval-2

# per-turn table (steps / unw calls / bytes / tokens / wall / errors)
python3 scripts/dev/eval-unw-summarize.py /tmp/unw-eval/raw/eval-2

# independent surface + shape probe (read-only, no values printed)
python3 scripts/dev/eval-unw-verify.py unw_academics:gpa unw_finances:balances
```
