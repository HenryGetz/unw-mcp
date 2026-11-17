# Security

`unw-mcp` reads a student's portal. It runs locally over stdio, uses a dedicated browser
profile, and never writes to the portal. This document states what is guaranteed, what is
trusted, and how to operate it safely.

## Guarantee: read-only

- The server issues `GET` only to `my.unw.edu`, `flow.my.unw.edu`,
  `registration-ss.oci.unw.edu`, `student-ss.oci.unw.edu`, and the public feeds
  `flow.my.unw.edu/upstream/v2/bonappetit`, `www.unwsp.edu/academics/academic-calendar/`
  and the Google Calendar ICS URLs embedded there. Public fetches send no cookies.
- The only form submissions are on Microsoft's Entra sign-in page during authentication
  (identifier, password, TOTP, "stay signed in"). They authenticate the student; they do not
  change portal data.
- No portal, Flow or Banner `POST`, `PATCH`, `PUT` or `DELETE` exists in the code. No
  mark-as-read, task completion, term selection, registration, payment or profile edit is
  implemented. The Banner pre-registration time ticket is therefore left as
  `not_exposed` rather than forcing a term selection with a POST.
- `unw_session op=reauth` navigates and may clear `.my.unw.edu` cookies to force SAML. That
  is a session operation, not a data write.

If a future phase adds a write, it must be a separate, explicitly enabled capability; it is
not part of this server's design.

## Secrets

| Secret | Location | Protection |
|---|---|---|
| Portal password + TOTP secret | `~/.config/unw-mcp/credentials.json` or `~/.config/teams-mcp/credentials.json` | server rejects files with group/other permission bits; never copied into the repo |
| Browser profile (cookies, Entra SSO) | `~/.config/unw-mcp/browser-profile` | created `0700`; contains live session cookies |
| Profile lock | `<profileDir>.lock` | `0600`, advisory, stale after 5 min |
| Degree-audit JWT (phase 2) | in memory only | 300 s TTL, re-fetched per call, never logged or cached on disk |

`credentials.json` is read only when the warm profile and silent SAML both fail. A missing
file is reported as `credentials_missing` with both candidate paths; the server does not fall
back to guessing.

## Redaction

Diagnostics go to **stderr**; stdout carries MCP frames only. Before any error or log line
leaves the process:

- URL query values for `claims`, `token`, `SAMLRequest/Response`, `RelayState`, `studentId`,
  `bannerId`, `code`, `state`, `session` are replaced with `<redacted:length>`.
- E-mail addresses, JWTs, `Bearer` tokens and 8-digit Banner ids become placeholders.
- Cookie diagnostics report name, expiry, days left, `HttpOnly`/`Secure` — never values.
- Tool outputs intentionally contain the student's name/e-mail, course and event data
  because the assistant needs them. They never contain `alternate_id`, tokens, cookie
  values or raw upstream envelopes.

Unit tests assert that secrets placed in cookie values and URLs do not appear in status or
error text.

## Trust boundaries

- **MCP client / model**: untrusted input for arguments, but the server exposes no URL,
  path, header or selector argument. Portal origins are fixed; the client cannot redirect a
  request. This removes SSRF and cross-origin risk.
- **Portal, Banner, page and menu content**: untrusted data. HTML is converted to text,
  tags/scripts are dropped, and content is returned as JSON — never executed. A page or
  notice that says "run this command" is data, not an instruction. Agents must treat tool
  output as data. Banner responses are classified before parsing: a login page or off-origin
  redirect is an authentication failure, never data. The dining and ICS payloads are public
  but equally untrusted; the raw 1.8 MB menu is never returned.
- **Same-user local process**: the threat model is a single-user workstation. Anyone who can
  read the profile or credentials can act as the student; file modes are the control.
- **Upstream drift**: Pathify/Banner APIs are not contractual. Shape changes produce
  `unavailable`/malformed-payload errors with a hint, not raw HTML.

## Data handling

- Personalized responses are cached **in process memory** for 5–60 minutes (schedule 10,
  grades/GPA 30, financial aid 60); public dining is cached 60 minutes, the academic ICS
  dataset 6 hours, page search 10 minutes and page bodies 24 hours. Nothing is written to
  disk. There is no telemetry, analytics or remote logging. The degree-audit result is not
  cached at all because its claims token lives 300 seconds.
- The Chromium profile is the only persistent personalized artifact; it must stay outside
  the repository and backups you do not control.
- Live proof and smoke scripts print counts and field names only. Tests and docs use
  synthetic fixtures (`Test Student`, `test@example.edu`, `00000000`) so no real student id,
  name, balance, grade or advisor appears in the repository.

## Availability and failure semantics

- `auth_required` — session could not be restored; the hint says to run `unw_session op=reauth`.
- `unavailable` — portal 5xx, timeout or malformed JSON; retry later, do not re-authenticate.
- `profile_locked` — another process owns the Chromium profile. Close it; do not delete a
  live profile.
- Banner app session expired twice — mapped to `auth_required`; run `unw_session op=reauth`
  and retry. The server never returns Banner HTML as data.
- `credentials_missing` / `config_invalid` — operator action, with the exact path or env var.
- A rejected password is attempted once per process run; the server refuses a second
  attempt to avoid account lockout.

## Operational checklist

1. `chmod 700 ~/.config/unw-mcp` and `chmod 600` any credentials file.
2. Keep `~/.config/unw-mcp` out of git, cloud-sync folders you do not control, and shell
   history. Never pass credentials as CLI arguments.
3. Run one MCP instance per profile. The lock exists because Chromium profiles are not
   multi-process safe.
4. To revoke access: stop the server, remove the profile directory, and sign out of the
   portal/Entra in a normal browser if the device is shared. Rotate the password/TOTP secret
   if the credentials file may have leaked.
5. Review `config.yaml` before enabling `headless: false`; a visible browser shows portal
   content on screen. Academic, financial, balance and page payloads are personal data: use
   them in the conversation only and do not paste them into logs or tickets. Dining menus
   and academic-calendar dates are public.
6. Chromium starts lazily on the first authenticated tool call, not at server startup. A
   cold isolated profile can take ~90 s to bootstrap the portal and Banner sessions; a warm
   profile is ~1 s. Budget for that on the first question, not every question.
6. When adding phases, preserve the rules above: GET-only reads, fixed origins, in-memory
   personalized cache, redaction on every diagnostic path, and no token persistence.
