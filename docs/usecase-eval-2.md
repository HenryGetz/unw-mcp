# Cold-agent use-case eval, round 2: rebuilt myUNW MCP

Date: 2026-11-17. Server rebuilt from the current tree with `npm run build`
(clean `dist/`), then exercised by a cold agent exactly as in round 1
(`docs/unw-usecase-eval.md`). Same harness, same isolation, same model, same
read-only envelope. Four prompts, one session, no tool hints.

> Privacy: no names, IDs, emails, balances, GPA values or page bodies appear
> here. Correctness is reported as match/mismatch against an independent
> read-only check, plus counts and shapes.

## 1. Method

| Piece | Detail |
| --- | --- |
| Build | `npm run build` in `<repo>` (tsc, clean `dist/`); server launched as `node <repo>/dist/index.js` |
| Isolation | `HOME=/tmp/unw-eval/home`, `opencode` config with a single `unw` MCP server; filesystem/shell/web/subagent tools denied at the agent layer |
| Session | one `opencode` session (`ses_unweval_round2`), four `run --session …` turns in order |
| Driver | `scripts/dev/eval-unw-cold-agent.sh` with `EVAL_PROMPTS_FILE` (new: prompt-set override); analyzer `scripts/dev/eval-unw-summarize.py` |
| Verification | `scripts/dev/eval-unw-verify.py` stdio client, direct read-only calls for `dashboard.day`, `dining` (brief/full), `pages.search`/`get`, `calendar.breaks`/`academic`, `academics.degree_audit` |
| Read-only | every call in the run is a read op; no `reauth`, no portal navigation, no submissions |

Environment note: the `opencode` fork still exposes non-`unw` servers in Code
Mode. This round the agent touched only `opencode.list_mcp_resources` (returned
empty) — no third-party data influenced an answer.

## 2. Results

| # | Prompt | Steps | Tool calls (unw / aux) | Ops | Tool bytes (unw / aux) | Answer B | Tokens in/out | Wall s | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | plan my day (classes, events, tasks, lunch) | 4 | 3 (2 / 1) | dashboard.day | 16,135 / 40 | 1,851 | 6,342 / 928 | 46.0 | 1 model-side `ReferenceError` |
| 2 | lunch at the Dining Center, briefly | 1 | 0 | — | 0 / 0 | 378 | 136 / 104 | 14.0 | 0 |
| 3 | registration-holds page + top matches | 3 | 2 (1 / 1) | pages.search, pages.get | 12,816 / 6,080 | 1,557 | 4,742 / 538 | 37.4 | 0 |
| 4 | Thanksgiving / finals / spring start | 3 | 2 (1 / 1) | calendar.breaks, academic, deadlines | 11,104 / 51 | 388 | 4,635 / 324 | 25.6 | 0 |
| **Σ** | | **11** | **7 (4 with unw, 3 aux; 7 unw invocations)** | 7 | **40,055 / 6,171** | **4,174** | **15,855 / 1,894** | **123.1** | 1 (model) |

Cache reads 164 K tokens; cost $0.0259; retries 0; all turns exit 0.

Turn 1's 16 KB is self-inflicted: the single data call returned
`dashboard.day` (5,027 B) bundled with two `search` results (3,008 B + 4,910 B
tool catalog). The day payload itself is 4,692 B.

## 3. Before / after against round 1

| Area | Round 1 | Round 2 | Verdict |
| --- | --- | --- | --- |
| Plan-my-day primitive | none; a cold answer needed `academics.today` + `dashboard.events` + `dashboard.tasks` + `dining.today` (≈29.8 KB across 4 tools) | `dashboard.day` alone: 4,692–5,027 B with classes, 24 h events, tasks and next meal in one object | **≈6× smaller payload, 1 call instead of 4** |
| Dining payload | `today` returned every café × breakfast/lunch/dinner: **14,562 B** for one lunch question | `today` + `cafe=Dining Center` + `meal=lunch` + `detail=brief`: **1,131 B**; scoped `detail=full`: 2,956 B | **12.9× smaller** for the same answer |
| `pages.search` ranking | 10 items / 4,827 B, correct hit #1, 69 total | 10 items / 4,379 B, correct hit #1 first, `truncated: true`, some reordering | −9% bytes, ordering clearer, **no real payload win** |
| Breaks / finals / spring | 2 ops (`breaks`, `academic`), 5,650 B, correct | 3 ops (`breaks`, `academic`, `deadlines`, `limit 30`), 11,053 B, correct | correct, but **2× the bytes** (model added `deadlines`) |
| Degree audit detail | 4 of 5 programs with `requirements_total: 0` | unchanged in the direct probe; not exercised by these four prompts | **still shallow** |
| Turn cost for pages | 10 steps, 27.7 KB (round 1 turn 7) | 3 steps, 12.8 KB (still a 6 KB catalog call) | better, discovery tax remains |
| Cold start | 87.6 s on the first authenticated call | 6.3 s this round | **not a code improvement**: profile/cookies were warm |

The two headline changes are real: `day` collapses the most common compound
question into one object, and `meal`/`detail` turns the dining payload from a
whole day for every café into the lunch the student asked about. The ranking
change is cosmetic for this query, and the calendar question got *more*
expensive because the model pulled an extra op.

## 4. Correctness (verified against direct read-only checks)

| # | Verdict | Evidence |
| --- | --- | --- |
| 1 | correct | 3 classes with matching times/rooms; 8 event rows (7 distinct — see gaps); 3 pending tasks with the same due dates and required flags; next meal = Dining Center lunch, 10:30–14:35, 6 stations, item text matching; date/day rendered correctly ("Tuesday, Nov 17, 2026"); the real 16:40/16:45 class conflict was flagged. |
| 2 | correct, context-served | Zero tool calls: answered from turn 1's `day` payload. Stations and items consistent, with one paraphrase loss ("spicy impossible beef black bean chili" → "spicy black bean chili"). Cheaper than round 1's 2 calls / 17 KB, but the new `detail=brief` path was therefore not exercised by the agent — it was measured directly (1,131 B). |
| 3 | correct | All seven hold rows in the page summary match the body; the top-10 list matches the payload's order and slugs exactly (no invented entries, 69 total reported). |
| 4 | correct | Thanksgiving recess (TRAD) 25–29 Nov, finals 14–17 Dec, spring semester begins 11 Jan 2027 — all matched, including the MLK note. |

No fabricated values, no stale reads, no wrong dates. The single error was
model-side (a JS `ReferenceError` in turn 1 from shadowing the `tools` binding),
which cost one step and no data.

## 5. Remaining gaps, ranked

1. **Discovery tax is unchanged.** Three of four turns opened with a `search`
   catalog call (40 B, 6,080 B, 51 B) before any data call; turn 2 was the only
   one that went straight to an answer. 6.2 KB and ~2 steps of the run were
   spent rediscovering tools the model had already used.
2. **`pages.search` still ships ~4.4 KB.** Ten full excerpts for 69 hits, when
   the useful data is the ranked title/slug. Truncating excerpts or defaulting
   to five items would halve turn 3's payload.
3. **Calendar over-read.** `academic` returns up to `limit` rows when the
   question names three dates; there is no `until`/`topics`/`summary` scoping,
   and the model also pulled `deadlines` "just in case", doubling round 1's
   bytes for an identical answer.
4. **`day.events` does not de-duplicate.** Two feed rows share title, time and
   location (distinct ids) and both appear in the payload; the model dropped
   one silently this time, but a different model could report the event twice.
5. **Degree audit is still a percentage wall.** `degree_audit` returns
   `requirements: []` / `requirements_total: 0` for four of five programs, so
   "what's left for my major?" remains unanswerable from the tool.
6. **`day` stops before money and notices.** It has classes, events, tasks and
   the next meal, but not the unacknowledged registration-window notice or the
   account balance — the two things a student planning a day often acts on.
   `overview` carries the notice but not the meal.
7. **Cold start is unproven.** This round's first authenticated call took 6.3 s
   because the profile was already warm; round 1's 87.6 s cold-boot cost has
   not been re-measured and cannot be attributed to the rebuild.

## 6. Safety and final state

- 7 `unw` invocations, all read-only: `dashboard.day`, `pages.search`,
  `pages.get`, `calendar.breaks`, `calendar.academic`, `calendar.deadlines`.
- No `unw_session reauth`, no registration/advance/contact/payment call, no
  form submission, no portal navigation. The only non-`unw` touch was
  `opencode.list_mcp_resources` (empty result).
- No portal state change: the run only read, and the post-run independent probe
  reproduced the same values the agent had reported.
- Credentials came from the copied profile under `/tmp/unw-eval/home`; nothing
  was written back to the real `~/.config/unw-mcp` profile.

## 7. Verdict

**Improved, and still usable daily as a read-only student-info secretary.**
`dashboard.day` answers the highest-value compound question in one call and
roughly a sixth of the payload; dining scoping cuts the lunch payload by an
order of magnitude; both answers were exactly right. Ranking is neutral for
this query, and the calendar question regressed in bytes because the model
chose an extra op — an argument for tighter calendar scoping, not for the
rebuild. The remaining friction is discovery (a catalog call before almost
every first answer), excerpt-heavy page search, and a degree audit that still
cannot say what is left. None of it produces wrong information.

## 8. Reproduce

```bash
cd <repo> && npm run build

# four-turn cold session (prompt file = one prompt per line)
EVAL_PROMPTS_FILE=/tmp/unw-eval/prompts/round2.txt \
  <eval-harness>/scripts/dev/eval-unw-cold-agent.sh round2

python3 <eval-harness>/scripts/dev/eval-unw-summarize.py /tmp/unw-eval/raw/round2

# independent checks (shapes/counts only)
python3 <eval-harness>/scripts/dev/eval-unw-verify.py \
  unw_dashboard:day unw_pages:search unw_calendar:breaks
```
