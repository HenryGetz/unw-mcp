#!/usr/bin/env node
/**
 * Authenticated endpoint probe for the myUNW / Pathify portal and Banner SSB.
 *
 *   node scripts/recon/probe.mjs              # compact, redacted report
 *   node scripts/recon/probe.mjs --json       # same report as JSON
 *   node scripts/recon/probe.mjs --raw        # also write the raw capture path
 *
 * Nothing is written to the repo. Raw payloads go to
 * ~/.cache/unw-mcp-recon/raw/probe-<ts>.json (mode 0600).
 *
 * READ-ONLY: every request below is a GET except the Banner "select term"
 * POST, which only sets the term in the server-side session.
 */
import { DASHBOARD_URL, redactUrl } from './lib/paths.mjs';
import { launch, portalReady, saveRaw } from './lib/browser.mjs';

const AS_JSON = process.argv.includes('--json');

const PORTAL = 'https://my.unw.edu';
const FLOW = 'https://flow.my.unw.edu';
const REG = 'https://registration-ss.oci.unw.edu';
const SS = 'https://student-ss.oci.unw.edu';

const state = {
  studentId: null,
  degreeClaims: null,
  terms: [],
  currentTerm: null,
  aidYear: null,
};

function pct(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}ms` : '';
}

async function get(ctx, url, { expectJson = true } = {}) {
  const started = Date.now();
  const res = await ctx.request.get(url, { timeout: 90000, headers: { Accept: 'application/json, */*' } });
  const text = await res.text();
  let body = text;
  if (expectJson) {
    try { body = JSON.parse(text); } catch { /* leave as text */ }
  }
  return { status: res.status(), ms: Date.now() - started, bytes: text.length, body, contentType: res.headers()['content-type'] ?? '' };
}

/** Same-origin fetch through the page (Banner's SSO cookie does not reliably
 * propagate to the separate APIRequestContext). */
async function pageFetch(page, url, { method = 'GET', form } = {}) {
  const started = Date.now();
  const r = await page.evaluate(
    async ({ url, method, form }) => {
      const opts = { method, credentials: 'include', headers: { Accept: 'application/json, */*' } };
      if (form) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(form).toString();
      }
      const res = await fetch(url, opts);
      return { status: res.status, ct: res.headers.get('content-type') || '', text: await res.text() };
    },
    { url, method, form },
  );
  let body = r.text;
  if (/json/i.test(r.ct)) { try { body = JSON.parse(r.text); } catch { /* keep text */ } }
  return { status: r.status, ms: Date.now() - started, bytes: r.text.length, body, contentType: r.ct };
}

function shape(body) {
  if (Array.isArray(body)) return `array(${body.length})`;
  if (body && typeof body === 'object') return 'object';
  return typeof body;
}

function keys(body, n = 12) {
  if (!body || typeof body !== 'object') return [];
  return Object.keys(body).slice(0, n);
}

function count(body) {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body.count === 'number') return body.count;
  if (body && Array.isArray(body.results)) return body.results.length;
  return undefined;
}

/** Derive the Banner term code for "now" (fall/spring/summer + academic year). */
function currentTermCode(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 7) return `${y}10`; // Fall
  if (m <= 4) return `${y}20`; // Spring
  return `${y}30`; // Summer
}

async function selectBannerTerm(page, term, mode = 'registration') {
  return pageFetch(page, `${REG}/StudentRegistrationSsb/ssb/term/search?mode=${mode}`, { method: 'POST', form: { term, termDesc: '' } });
}

async function main() {
  const report = { at: new Date().toISOString(), probes: {} };
  const { ctx, page } = await launch({ headless: true });
  try {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);
    report.authenticated = await portalReady(page);
    if (!report.authenticated) {
      // Silent SAML re-auth normally restores the session from the Entra SSO cookie.
      await page.goto(`${PORTAL}/api/core/saml_sso/1/?next=/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(4000);
      report.authenticated = await portalReady(page);
    }
    if (!report.authenticated) throw new Error('not authenticated; run scripts/recon/login.mjs first');

    const add = (id, url, extra = {}) => ({ id, url: redactUrl(url), ...extra });
    const probes = [];

    // ---------- Portal (Pathify v1/v2) ----------
    probes.push(add('portal.profile', `${PORTAL}/api/v1/users/me/`));
    probes.push(add('portal.navigation', `${PORTAL}/api/v2/menu/navigations/active/`));
    probes.push(add('portal.dashboard', `${PORTAL}/api/v1/dashboard/dashboards/active/`));
    probes.push(add('portal.quick_links', `${PORTAL}/api/v1/dashboard/quick-link-cards/?active=true`));
    probes.push(add('portal.widgets', `${PORTAL}/api/v1/widgets/?shown=true`));
    probes.push(add('portal.notices', `${PORTAL}/api/v1/notices/?notice_type=Emergency&notice_type=Alert&status=NO_STATUS&status=APPROVED&scheduled=false&expired=false&dismissed=false&limit=10&offset=0`));
    probes.push(add('portal.tasks', `${PORTAL}/api/v1/tasks/reminders/me/?pending=true`));
    probes.push(add('portal.favorites', `${PORTAL}/api/v1/favorites/`));
    probes.push(add('portal.calendars', `${PORTAL}/api/v2/events/calendars/subscriptions/`));
    probes.push(add('portal.events_today', `${PORTAL}/api/v2/events/?offset=0&limit=10&current=true&field=id&field=title&field=start_date&field=end_date&field=all_day&field=location&field=calendar`));
    probes.push(add('portal.events_academic', `${PORTAL}/api/v2/events/?calendar=11&limit=10&current=true&field=id&field=title&field=start_date&field=end_date`));

    for (const p of probes) {
      const out = await get(ctx, p.url.replace(/studentId=[^&]*/, 'studentId=<id>'));
      report.probes[p.id] = {
        url: p.url,
        status: out.status,
        ms: out.ms,
        bytes: out.bytes,
        shape: shape(out.body),
        count: count(out.body),
        keys: keys(out.body),
        body: out.body,
      };
    }

    // Capture identity once (kept out of printed output).
    const profile = report.probes['portal.profile'].body;
    state.studentId = profile?.alternate_id ?? null;

    // ---------- Flow (Pathify widget backend) ----------
    const claimsWidget = (report.probes['portal.widgets'].body ?? []).find?.((w) => w.name === 'Degree Audit');
    state.degreeClaims = claimsWidget?.claims ?? null;
    let claimsTtl = null;
    if (state.degreeClaims) {
      try {
        const payload = JSON.parse(Buffer.from(state.degreeClaims.split('.')[1], 'base64url').toString('utf8'));
        claimsTtl = { ttlSeconds: payload.exp - payload.iat, expiresInSeconds: payload.exp - Math.floor(Date.now() / 1000) };
      } catch { /* not a JWT */ }
    }

    const flowProbes = [
      ['flow.profile', `${FLOW}/pathify-api/v1/users/me/?field=extra_data&field=gpa&field=advisors`],
      ['flow.tasks', `${FLOW}/pathify-api/v1/users/me/tasks/`],
      ['flow.balances', `${FLOW}/upstream/v1/balances`],
      ['flow.chapel', `${FLOW}/upstream/chapel_summary`],
      ['flow.dining', `${FLOW}/upstream/v2/bonappetit`],
      ['flow.academic_events', `${FLOW}/pathify-api/v2/events?calendar=17&paginate=true&limit=10&format=json`],
      ['flow.moodle_courses', `${FLOW}/upstream/v3/moodle/courses`],
    ];
    for (const [id, url] of flowProbes) {
      const out = await get(ctx, url);
      report.probes[id] = { url: redactUrl(url), status: out.status, ms: out.ms, bytes: out.bytes, shape: shape(out.body), count: count(out.body), keys: keys(out.body) };
      if (id === 'flow.dining') {
        const cafes = Object.entries(Object.values(out.body?.campuses ?? {})[0]?.cafes ?? {});
        report.probes[id].cafes = cafes.map(([cafeId, c]) => ({ id: cafeId, name: c.name, menuDates: Object.keys(out.body?.data?.[cafeId] ?? {}) }));
        report.probes[id].keys = ['lastUpdated', 'campuses', 'data'];
        report.probes[id].cafeCount = cafes.length;
      }
      if (id === 'flow.academic_events') report.probes[id].events = out.body?.results?.slice(0, 3).map((e) => ({ title: e.title, start: e.start_date }));
    }

    if (state.degreeClaims) {
      const out = await get(ctx, `${FLOW}/upstream/v1/degree-audit/degreeworks?claims=${encodeURIComponent(state.degreeClaims)}`);
      const degrees = out.body?.degrees ?? [];
      report.probes['flow.degree_audit'] = {
        url: `${FLOW}/upstream/v1/degree-audit/degreeworks?claims=<redacted>`,
        status: out.status,
        ms: out.ms,
        bytes: out.bytes,
        shape: shape(out.body),
        count: degrees.length,
        keys: keys(out.body),
        claims: claimsTtl,
        degrees: degrees.map((d) => ({ name: d.name, percentComplete: d.percentComplete, credits: d.credits, gpa: d.enrollmentCumulativeGPA ?? d.overallCumulativeGPA })),
      };
    }

    // ---------- Banner registration (SSO) ----------
    // Clear any guest Banner session first: a JSESSIONID created by an
    // unauthenticated request makes registerPostSignIn skip the SAML handshake.
    await ctx.clearCookies({ domain: 'registration-ss.oci.unw.edu' });
    const regNav = await page.goto(`${REG}/StudentRegistrationSsb/ssb/registration/registerPostSignIn?mode=registration`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => null);
    report.bannerNav = { url: redactUrl(page.url()), status: regNav?.status() };
    await page.waitForTimeout(1000);

    const terms = await pageFetch(page, `/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=20`);
    report.probes['banner.terms'] = { url: redactUrl(`${REG}/StudentRegistrationSsb/ssb/classSearch/getTerms`), status: terms.status, ms: terms.ms, bytes: terms.bytes, shape: shape(terms.body), count: count(terms.body), body: terms.body };
    state.terms = terms.body ?? [];
    state.currentTerm = currentTermCode();

    const history = {};
    for (const t of [...new Set([state.currentTerm, '202620', '202610', '202520'])]) {
      const out = await pageFetch(page, `/StudentRegistrationSsb/ssb/registrationHistory/reset?term=${t}`);
      const regs = out.body?.data?.registrations ?? [];
      history[t] = {
        status: out.status,
        bytes: out.bytes,
        shape: shape(out.body),
        bodyKeys: keys(out.body),
        preview: typeof out.body === 'string' ? out.body.slice(0, 120) : undefined,
        totalCredit: out.body?.data?.totalCredit,
        courses: regs.map((r) => ({
          subject: r.subject,
          number: r.courseNumber,
          crn: r.courseReferenceNumber,
          title: r.courseTitle ?? null,
          creditHours: r.creditHour,
          grade: r.grade,
          status: r.courseRegistrationStatusDescription,
          instructors: r.instructorNames,
          meetings: (r.meetingTimes ?? []).map((m) => ({
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].filter((d) => m[d]).map((d) => d.slice(0, 3)),
            begin: m.beginTime,
            end: m.endTime,
            building: m.building,
            room: m.room,
            startDate: m.startDate,
            endDate: m.endDate,
          })),
        })),
      };
    }
    report.probes['banner.registration_history'] = { status: 200, shape: 'object', terms: history };
    report.probes['banner.registration_history'].keys = Object.keys(history);

    // Today's classes are derived from the registration-history meeting days;
    // the separate getRegistrationEvents endpoint is unreliable (empty list
    // unless a term is active in that page's JS state).
    const today = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
    const current = history[state.currentTerm]?.courses ?? [];
    report.probes['banner.today_schedule'] = {
      status: 200,
      term: state.currentTerm,
      day: today,
      classes: current
        .flatMap((c) => c.meetings.filter((m) => m.days.includes(today.slice(0, 3))).map((m) => ({ title: c.title, subject: c.subject, number: c.number, crn: c.crn, begin: m.begin, end: m.end, building: m.building, room: m.room })))
        .sort((a, b) => a.begin.localeCompare(b.begin)),
    };
    report.probes['banner.registration_history'].bytes = 0;

    // Pre-registration status: requires selecting the term, then the HTML page
    // carries holds + time ticket text (no JSON endpoint for these).
    const targetTerm = state.terms.find((t) => t.description?.includes('Spring 2027'))?.code ?? state.currentTerm;
    const sel = await selectBannerTerm(page, targetTerm, 'preReg');
    await page.goto(`${REG}/StudentRegistrationSsb/ssb/prepareRegistration/prepareRegistration`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const preText = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
    report.probes['banner.pre_reg_status'] = {
      selectedTerm: targetTerm,
      selection: sel,
      status: 200,
      textSample: preText.slice(0, 700),
      parsed: {
        holds: /You have holds/i.test(preText),
        timeTicket: preText.match(/Please register within these times:\s*(.*?)\s*(?:Earned Hours|Primary Curriculum)/i)?.[1]?.slice(0, 120) ?? null,
        earnedHours: preText.match(/Institution Hours:\s*(\d+),\s*Transfer Hours:\s*(\d+)/i)?.slice(1) ?? null,
        standing: preText.match(/class standing for registration purposes is\s*([A-Za-z]+)/i)?.[1] ?? null,
      },
    };

    // ---------- Banner Student Self-Service (JSON) ----------
    // Its SAML session is separate from registration-ss: open the profile once
    // so the shared cookie jar holds a valid StudentSelfService JSESSIONID.
    await page.goto(`${SS}/StudentSelfService/ssb/studentProfile`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (state.studentId) {
      const sid = state.studentId;
      const ssProbes = [
        ['banner.gpa_hours', `${SS}/StudentSelfService/studentProfile/viewGPAHoursList?studentId=${sid}`],
        ['banner.holds', `${SS}/StudentSelfService/studentHolds/showHolds?studentId=${sid}`],
        ['banner.notices', `${SS}/StudentSelfService/studentProfile/viewRegistrationNotices?studentId=${sid}`],
        ['banner.aid_years', `${SS}/StudentSelfService/ssb/applicantActiveAidYears/getApplicantActiveAidYears`],
      ];
      for (const [id, url] of ssProbes) {
        const out = await pageFetch(page, url);
        report.probes[id] = {
          url: url.replace(sid, '<id>'),
          status: out.status,
          ms: out.ms,
          bytes: out.bytes,
          shape: shape(out.body),
          keys: keys(out.body),
          body: ['banner.gpa_hours', 'banner.holds', 'banner.notices', 'banner.aid_years'].includes(id) ? out.body : undefined,
        };
      }
      const aidYears = report.probes['banner.aid_years'].body?.ActiveAidyears ?? [];
      const aidyCode = aidYears[0]?.aidyCode;
      if (aidyCode) {
        state.aidYear = aidyCode;
        const award = await pageFetch(page, `/StudentSelfService/ssb/awardLetter/getAwardInfo?aidyCode=${aidyCode}`);
        const cost = await pageFetch(page, `/StudentSelfService/ssb/awardLetter/getCostOfAttendance?aidyCode=${aidyCode}`);
        report.probes['banner.financial_aid'] = {
          url: `${SS}/StudentSelfService/ssb/awardLetter/getAwardInfo?aidyCode=${aidyCode}`,
          status: award.status,
          ms: award.ms,
          shape: shape(award.body),
          keys: keys(award.body?.awardInfo ?? award.body),
          awardCount: (award.body?.awardInfo?.data ?? []).length,
          costCount: (cost.body?.data ?? []).length,
          aidyCode,
        };
      }
    }

    // Raw capture first (outside the repo, mode 0600), then strip personal
    // values from the report that is printed/saved in docs.
    const rawFile = saveRaw(`probe-${Date.now()}.json`, report);
    for (const p of Object.values(report.probes)) {
      if (p.body) {
        p.bodyKeys = keys(p.body);
        delete p.body;
      }
    }
    // Printed report is shape-only; course titles, instructors, IDs and the
    // pre-registration text stay in the raw capture.
    const hist = report.probes['banner.registration_history'];
    if (hist?.terms) {
      hist.terms = Object.fromEntries(
        Object.entries(hist.terms).map(([term, v]) => [
          term,
          { courses: v.courses.length, credits: v.totalCredit, graded: v.courses.filter((c) => c.grade).length },
        ]),
      );
    }
    const todayProbe = report.probes['banner.today_schedule'];
    if (todayProbe?.classes) {
      todayProbe.classCount = todayProbe.classes.length;
      todayProbe.classes = todayProbe.classes.map((c) => ({ begin: c.begin, end: c.end }));
    }
    if (report.probes['banner.pre_reg_status']) delete report.probes['banner.pre_reg_status'].textSample;
    report.redaction = 'student id, names, e-mail, amounts and tokens removed; raw capture stays outside the repo';
    report.rawFile = rawFile;

    if (AS_JSON) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`authenticated: ${report.authenticated}  (raw: ${rawFile})`);
      for (const [id, p] of Object.entries(report.probes)) {
        const head = `${p.status ?? '?'} ${pct(p.ms).padStart(6)} ${String(p.bytes ?? '').padStart(8)}B ${id}`;
        const detail = [p.shape, p.count !== undefined ? `count=${p.count}` : '', p.cafeCount ? `cafes=${p.cafeCount}` : '', p.awardCount !== undefined ? `awards=${p.awardCount}` : ''].filter(Boolean).join(' ');
        console.log(`${head}  ${detail}`);
        if (p.parsed) {
          const safe = { ...p.parsed, earnedHours: p.parsed.earnedHours ? 'present' : null };
          console.log(`    parsed: ${JSON.stringify(safe)}`);
        }
        if (p.degrees) console.log(`    degrees: ${p.degrees.map((d) => `${d.name} ${d.percentComplete}%`).join(' | ')}`);
        if (p.terms) console.log(`    terms: ${Object.entries(p.terms).map(([t, v]) => `${t}(${v.courses ?? v}c${v.credits ? '/' + v.credits + 'cr' : ''})`).join(' ')}`);
        if (p.events) console.log(`    events: ${p.events.map((e) => e.title).join(' | ')}`);
        if (p.cafes) console.log(`    cafes: ${p.cafes.map((c) => `${c.name} (${c.menuDates.length}d)`).join(' | ')}`);
        if (p.classes) console.log(`    ${p.day} classes: ${p.classCount ?? p.classes.length} (${p.classes.map((c) => `${c.begin}-${c.end}`).join(', ') || 'none'})`);
      }
    }
    return report;
  } finally {
    await ctx.close();
  }
}

main().catch((error) => {
  console.error(`[probe] FAILED: ${error.message}`);
  process.exit(1);
});
