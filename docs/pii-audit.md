# PII and secret audit (pre-publication)

Date: 2026-11-17. Scope: the complete `unw-mcp` repository — working tree, every tracked
file, every commit and reachable blob, unreachable/dangling objects, reflog, packed refs and
the ignored/untracked listing — audited before any GitHub push.

## Method

1. Enumerated tracked files (`git ls-files`), the untracked/ignored listing
   (`git status --ignored`) and every object in the database
   (`git rev-list --all --objects`, `git cat-file --batch-all-objects`).
2. Scanned all blobs for: personal names and e-mails, 8-digit Banner ids, UUIDs, local
   absolute paths with a username, JWT/bearer/SAML/session material, cookie values,
   passwords and TOTP secrets, account balances, aid amounts, grades and GPA, holds, and
   account-specific course schedules (CRN, room, meeting times).
3. Ran `git fsck --full --unreachable --lost-found`, read the reflog for every ref, checked
   `packed-refs`, stashes and `ORIG_HEAD`, and inspected the two unreachable pre-amend
   commits and four unreachable blobs by hand.
4. Inspected commit metadata (`%an <%ae> | %cn <%ce>`) for every commit, not just file
   contents.
5. Fixed the working tree, then rebuilt history as a single fresh orphan commit of the
   sanitized tree, removed the old branch, expired all reflogs and pruned the object
   database. Re-ran the scans against the rewritten repository, including dangling objects.

## Findings (redacted)

| # | Severity | Category | Location | Fingerprint | Resolution |
|---|---|---|---|---|---|
| 1 | High (public) / Medium (private) | Personal e-mail in commit metadata | all 6 pre-rewrite commits (author and committer) | `[redacted local-part]@[redacted domain]` | History rewritten; author/committer set to the GitHub noreply address `HenryGetz@users.noreply.github.com` |
| 2 | Medium | Local absolute path naming the workstation user | `docs/usecase-eval.md`, `docs/usecase-eval-2.md` | `/<home>/ai/...` | Replaced with `<repo>` / `<eval-harness>` |
| 3 | Medium | Account-specific course schedule (course code, CRN, building/room, meeting times) | `test/academics.test.ts`, `test/day.test.ts`, `docs/usage.md` | `*** 2***`, CRN `2****`, room `R** R****` | Replaced with synthetic `TST 1010`, CRN `10001`, `TEST T101`, generic times |
| 4 | Medium | Account-specific academic values (GPA, degree progress, credits remaining) | `test/academics.test.ts`, `docs/usage.md`, `docs/usecase-eval.md` | GPA `3.*0`, progress `1**`/`*` remaining | Replaced with synthetic `3.25` and rounded, clearly illustrative progress values |
| 5 | Medium | Account-specific financial values (balances, award amounts, cost of attendance, hold text) | `test/finances.test.ts`, `test/tools.test.ts`, `test/dashboard.test.ts`, `test/academics.test.ts` | amounts `*.*4`, `*988`, `1*388`; hold description | Replaced with round synthetic amounts and `Example Hold` |
| 6 | Low | Institution tenant identifier (not personal, but unnecessary) | `docs/portal-recon.md`, `README.md` | `713d3c**-****-…` | Replaced with `<tenant-id>` |
| 7 | Low | Real notice titles/text copied into a fixture | `test/dashboard.test.ts` | one alert and one emergency notice | Replaced with generic example text |
| 8 | Info | Old `npm pack` tarball in the working tree containing pre-sanitization docs | `unw-mcp-0.1.0.tgz` (ignored, never tracked) | — | Deleted; `*.tgz` remains git-ignored |

No passwords, TOTP secrets, cookie values, JWTs, SAML assertions, bearer tokens, session
files, browser profiles, raw JSON captures or screenshots were found in the tree or in git
objects. Tests use placeholder cookie values (`secret-value-not-read`), a synthetic id
(`00000000`), `Test Student`, `test@example.edu` and `Advisor One`. Public data (institution
domains, public ICS feeds, dining/campus names, academic-calendar dates) was left as-is
because it is not personal and carries no account local-part.

The two unreachable pre-amend commits and four unreachable blobs contained only earlier
versions of already-audited source, tests and README text — no additional PII.

## History rewrite

- All pre-rewrite commits (`7d9b78c`, `faeedce`, `1ef4ccf`, `852338d`, `9c4f27c`, `4943d99`)
  and the two unreachable amended commits were discarded.
- The sanitized working tree (including `.github/workflows/ci.yml`) was committed as a
  single root commit, authored and committed as
  `Henry Getz <HenryGetz@users.noreply.github.com>`.
- The old `master` ref was deleted, the new root commit renamed to `master`, all reflogs
  expired and `git gc --prune=now` run.
- Verification after the rewrite: `git fsck --full --unreachable` reports no unreachable
  objects, `git rev-list --all --objects` contains only the root commit and its tree/blobs,
  and the full-tree scan (including `git grep` across all reachable blobs and every dangling
  object) finds no occurrence of the categories above.

## Result

The current tree and the entire published history are clean of real student PII, personal
contact details, local usernames, credentials, session material and account-specific
academic or financial values. The repository is safe to push to a private GitHub repository;
the history is also clean enough for public release.
