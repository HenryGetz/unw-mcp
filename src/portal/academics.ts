/**
 * Academic projections and loaders.
 *
 * Sources:
 *   - Flow academic profile (`gpa`, degree progress, advisors);
 *   - Banner registration history (schedule, today, grades);
 *   - Banner GPA / holds / registration notices;
 *   - Portal widget claims -> Flow Degree Works audit.
 *
 * Today's classes are derived from Banner meeting-day flags, not from the
 * portal events endpoint (which returns an empty list for class schedules).
 */
import type { ResolvedConfig } from "../config.js";
import type { TtlCache } from "../cache.js";
import { AuthRequiredError, PortalUnavailableError } from "../auth/session.js";
import { localDate, localParts } from "../time.js";
import type { BannerReader } from "../banner/client.js";
import type { PortalReader } from "./client.js";
import { bool, dict, list, numeric, round1, text } from "./values.js";

export interface AcademicDeps {
  portal: PortalReader;
  banner: BannerReader;
  cfg: ResolvedConfig;
  cache: TtlCache;
  now?: () => Date;
}

function nowOf(deps: AcademicDeps): Date {
  return deps.now ? deps.now() : new Date();
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_FLAGS = [
  ["monday", "Mon"],
  ["tuesday", "Tue"],
  ["wednesday", "Wed"],
  ["thursday", "Thu"],
  ["friday", "Fri"],
  ["saturday", "Sat"],
  ["sunday", "Sun"],
] as const;

export interface TermRow {
  code: string;
  description: string;
}

export interface MeetingRow {
  days: string[];
  start?: string;
  end?: string;
  location?: string;
  from?: string;
  to?: string;
}

export interface CourseRow {
  course: string;
  crn?: string;
  title?: string;
  credits?: number;
  instructors: string[];
  meetings: MeetingRow[];
  grade?: string;
}

export interface HistoryProjection {
  term: TermRow;
  total_credits?: number;
  courses: CourseRow[];
}

/** Banner term code for the current season: Fall `YYYY10`, Spring `YYYY20`, Summer `YYYY30`. */
export function currentTermCode(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  if (parts.month >= 7) return `${parts.year}10`;
  if (parts.month <= 4) return `${parts.year}20`;
  return `${parts.year}30`;
}

export function projectTerms(raw: unknown): TermRow[] {
  return list(raw).flatMap((entry) => {
    const term = dict(entry);
    const code = text(term.code);
    if (!code) return [];
    return [{ code, description: text(term.description) ?? code }];
  });
}

/** Resolve a Banner term code or a description ("Fall 2026", "fall"). */
export function resolveTerm(
  input: string | undefined,
  terms: TermRow[],
  fallbackCode: string,
): TermRow {
  const clean = input?.trim();
  if (!clean) {
    return terms.find((term) => term.code === fallbackCode) ?? { code: fallbackCode, description: fallbackCode };
  }
  const lower = clean.toLowerCase();
  return (
    terms.find((term) => term.code === lower) ??
    terms.find((term) => term.description.toLowerCase() === lower) ??
    terms.find((term) => term.description.toLowerCase().includes(lower)) ?? {
      code: clean,
      description: clean,
    }
  );
}

/** `1050` -> `10:50`, `930` -> `09:30`; TBA and junk become undefined. */
export function formatClock(value: unknown): string | undefined {
  const clean = text(value);
  if (!clean || /tba/i.test(clean)) return undefined;
  if (/^\d{1,2}:\d{2}$/.test(clean)) {
    const [hour, minute] = clean.split(":");
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  if (/^\d{3,4}$/.test(clean)) {
    const padded = clean.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return clean;
}

/** `01/12/2026` -> `2026-01-12`; anything else is left as text. */
export function usDateToIso(value: unknown): string | undefined {
  const clean = text(value);
  if (!clean) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean);
  if (!match) return clean;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return clean;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function courseLocation(meeting: Record<string, unknown>): string | undefined {
  const building = text(meeting.building);
  const room = text(meeting.room);
  const joined = [building, room].filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}

function instructorNames(course: Record<string, unknown>): string[] {
  const direct = list(course.instructorNames)
    .map((name) => text(name))
    .filter((name): name is string => name !== undefined);
  if (direct.length > 0) return direct;
  return list(course.faculty)
    .map((entry) => text(dict(entry).displayName))
    .filter((name): name is string => name !== undefined);
}

export function projectCourse(raw: unknown): CourseRow | undefined {
  const course = dict(raw);
  const subject = text(course.subject);
  const number = text(course.courseNumber);
  const label = subject && number ? `${subject} ${number}` : undefined;
  const crn = text(course.courseReferenceNumber);
  if (!label && !crn) return undefined;
  const meetings = list(course.meetingTimes).flatMap((entry): MeetingRow[] => {
    const meeting = dict(entry);
    const days = DAY_FLAGS.filter(([flag]) => bool(meeting[flag]) === true).map(([, short]) => short);
    const start = formatClock(meeting.beginTime);
    const end = formatClock(meeting.endTime);
    const location = courseLocation(meeting);
    const from = usDateToIso(meeting.startDate);
    const to = usDateToIso(meeting.endDate);
    if (days.length === 0 && !start && !location) return [];
    return [
      {
        days,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(location ? { location } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
    ];
  });
  const credits = numeric(course.creditHour);
  const grade = text(course.grade);
  return {
    course: label ?? `CRN ${crn}`,
    ...(crn ? { crn } : {}),
    ...(text(course.courseTitle) ? { title: text(course.courseTitle) } : {}),
    ...(credits !== undefined ? { credits } : {}),
    instructors: instructorNames(course),
    meetings,
    ...(grade ? { grade } : {}),
  };
}

export function projectHistory(raw: unknown, term: TermRow): HistoryProjection {
  const data = dict(dict(raw).data);
  const courses = list(data.registrations)
    .map((entry) => projectCourse(entry))
    .filter((course): course is CourseRow => course !== undefined);
  const total = numeric(data.totalCredit) ?? courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  return { term, ...(Number.isFinite(total) ? { total_credits: total } : {}), courses };
}

export interface ScheduleResult {
  term: TermRow;
  total_credits?: number;
  count: number;
  courses: CourseRow[];
}

export function projectSchedule(history: HistoryProjection): ScheduleResult {
  return {
    term: history.term,
    ...(history.total_credits !== undefined ? { total_credits: history.total_credits } : {}),
    count: history.courses.length,
    courses: history.courses,
  };
}

export interface TodayClass {
  start?: string;
  end?: string;
  course: string;
  title?: string;
  crn?: string;
  location?: string;
  instructors?: string[];
}

export interface TodayResult {
  date: string;
  day: string;
  term: TermRow;
  count: number;
  classes: TodayClass[];
}

function inDateRange(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export function projectToday(history: HistoryProjection, date: string): TodayResult {
  const parsed = new Date(`${date}T12:00:00Z`);
  const day = Number.isNaN(parsed.getTime()) ? "" : (DAY_NAMES[parsed.getUTCDay()] ?? "");
  const classes: TodayClass[] = [];
  for (const course of history.courses) {
    for (const meeting of course.meetings) {
      if (!meeting.days.includes(day)) continue;
      if (!inDateRange(date, meeting.from, meeting.to)) continue;
      classes.push({
        ...(meeting.start ? { start: meeting.start } : {}),
        ...(meeting.end ? { end: meeting.end } : {}),
        course: course.course,
        ...(course.title ? { title: course.title } : {}),
        ...(course.crn ? { crn: course.crn } : {}),
        ...(meeting.location ? { location: meeting.location } : {}),
        ...(course.instructors.length > 0 ? { instructors: course.instructors } : {}),
      });
    }
  }
  classes.sort((a, b) => (a.start ?? "99:99").localeCompare(b.start ?? "99:99"));
  return { date, day, term: history.term, count: classes.length, classes };
}

export interface GradeRow {
  course: string;
  title?: string;
  credits?: number;
  grade: string;
  instructors?: string[];
}

export interface GradeTerm {
  term: TermRow;
  count: number;
  credits?: number;
  courses: GradeRow[];
}

export function projectGradesTerm(history: HistoryProjection): GradeTerm {
  const courses = history.courses
    .filter((course) => course.grade !== undefined)
    .map((course) => ({
      course: course.course,
      ...(course.title ? { title: course.title } : {}),
      ...(course.credits !== undefined ? { credits: course.credits } : {}),
      grade: course.grade as string,
      ...(course.instructors.length > 0 ? { instructors: course.instructors } : {}),
    }));
  const credits = courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  return {
    term: history.term,
    count: courses.length,
    ...(courses.length > 0 ? { credits } : {}),
    courses,
  };
}

export interface GpaRow {
  level?: string;
  type?: string;
  gpa?: number;
  hours?: number;
  hours_attempted?: number;
}

export interface GpaResult {
  overall_gpa?: number;
  overall_hours?: number;
  rows: GpaRow[];
}

export function projectGpa(raw: unknown): GpaResult {
  const gpa = dict(raw);
  const rows = list(gpa.gpas).flatMap((entry): GpaRow[] => {
    const row = dict(entry);
    const value: GpaRow = {
      ...(text(row.levelDesc) ? { level: text(row.levelDesc) } : {}),
      ...(text(row.typeDesc) ? { type: text(row.typeDesc) } : {}),
      ...(numeric(row.gpa) !== undefined ? { gpa: numeric(row.gpa) } : {}),
      ...(numeric(row.hours) !== undefined ? { hours: numeric(row.hours) } : {}),
      ...(numeric(row.hoursAttempted) !== undefined
        ? { hours_attempted: numeric(row.hoursAttempted) }
        : {}),
    };
    return Object.keys(value).length > 0 ? [value] : [];
  });
  return {
    ...(numeric(gpa.overallGpa) !== undefined ? { overall_gpa: numeric(gpa.overallGpa) } : {}),
    ...(numeric(gpa.overallHours) !== undefined ? { overall_hours: numeric(gpa.overallHours) } : {}),
    rows,
  };
}

export interface HoldRow {
  description: string;
  type?: string;
  from?: string;
  to?: string;
  releasable?: boolean;
  amount_owed?: number;
  reason?: string;
}

export interface HoldsResult {
  count: number;
  has_hidden?: boolean;
  rows: HoldRow[];
}

export function projectHolds(raw: unknown): HoldsResult {
  const holds = dict(raw);
  const rows = list(holds.holds).flatMap((entry): HoldRow[] => {
    const hold = dict(entry);
    const description = text(hold.description);
    if (!description) return [];
    const value: HoldRow = {
      description,
      ...(text(hold.typeCode) ? { type: text(hold.typeCode) } : {}),
      ...(usDateToIso(hold.fromDate) ? { from: usDateToIso(hold.fromDate) } : {}),
      ...(usDateToIso(hold.toDate) ? { to: usDateToIso(hold.toDate) } : {}),
      ...(bool(hold.releasableFlag) !== undefined ? { releasable: bool(hold.releasableFlag) } : {}),
      ...(numeric(hold.amountOwed) !== undefined ? { amount_owed: numeric(hold.amountOwed) } : {}),
      ...(text(hold.reason) ? { reason: text(hold.reason) } : {}),
    };
    return [value];
  });
  return {
    count: numeric(holds.holdCount) ?? rows.length,
    ...(bool(holds.hasHidden) !== undefined ? { has_hidden: bool(holds.hasHidden) } : {}),
    rows,
  };
}

export interface RegistrationResult {
  allows_registration?: boolean;
  status?: string;
  standing?: string;
  standing_as_of?: string;
  academic_standing?: string;
  prevents_registration?: string;
  enrollment_status?: string;
  time_ticket_required?: boolean;
  time_tickets?: Array<{ start?: string; end?: string; description?: string }>;
  time_ticket_source: "json" | "not_exposed";
}

export function projectRegistration(raw: unknown): RegistrationResult {
  const registration = dict(raw);
  const standing = dict(registration.standingAsOf);
  const academic = dict(registration.academicStanding);
  const student = dict(registration.regStudentStatus);
  const enrollment = dict(registration.enrollmentStatus);
  const tickets = list(registration.timeTickets).flatMap((entry) => {
    const ticket = dict(entry);
    const start = text(ticket.startDate) ?? text(ticket.start);
    const end = text(ticket.endDate) ?? text(ticket.end);
    const description = text(ticket.description) ?? text(ticket.timeTicketDescription);
    if (!start && !end && !description) return [];
    return [{ ...(start ? { start } : {}), ...(end ? { end } : {}), ...(description ? { description } : {}) }];
  });
  return {
    ...(bool(student.allowsRegistration) !== undefined
      ? { allows_registration: bool(student.allowsRegistration) }
      : {}),
    ...(text(student.description) ? { status: text(student.description) } : {}),
    ...(text(standing.standingDescription) ?? text(academic.description)
      ? { standing: text(standing.standingDescription) ?? text(academic.description) }
      : {}),
    ...(text(standing.termDescription) ? { standing_as_of: text(standing.termDescription) } : {}),
    ...(text(academic.description) ? { academic_standing: text(academic.description) } : {}),
    ...(text(academic.preventsRegistration)
      ? { prevents_registration: text(academic.preventsRegistration) }
      : {}),
    ...(text(enrollment.description) ? { enrollment_status: text(enrollment.description) } : {}),
    ...(bool(registration.timeTicketRequired) !== undefined
      ? { time_ticket_required: bool(registration.timeTicketRequired) }
      : {}),
    ...(tickets.length > 0 ? { time_tickets: tickets } : {}),
    time_ticket_source: tickets.length > 0 ? "json" : "not_exposed",
  };
}

export interface RequirementRow {
  name?: string;
  target?: number;
  progress?: number;
  needed?: number;
  percent?: number;
}

export interface DegreeRow {
  name: string;
  percent?: number;
  credits?: number;
  credits_completed?: number;
  gpa?: number;
  requirements_total?: number;
  /** False when the upstream audit has no requirement array for this program. */
  requirements_available: boolean;
  requirements?: RequirementRow[];
}

export interface DegreeAuditResult {
  degrees: DegreeRow[];
  count: number;
}

export function projectDegreeAudit(raw: unknown): DegreeAuditResult {
  const degrees = list(dict(raw).degrees).flatMap((entry): DegreeRow[] => {
    const degree = dict(entry);
    const name = text(degree.name);
    if (!name) return [];
    const rawRequirements = list(degree.requirements);
    const requirements = rawRequirements.slice(0, 50).flatMap((req): RequirementRow[] => {
      const requirement = dict(req);
      const value: RequirementRow = {
        ...(text(requirement.name) ? { name: text(requirement.name) } : {}),
        ...(numeric(requirement.target) !== undefined ? { target: numeric(requirement.target) } : {}),
        ...(numeric(requirement.progress) !== undefined ? { progress: numeric(requirement.progress) } : {}),
        ...(numeric(requirement.needed) !== undefined ? { needed: numeric(requirement.needed) } : {}),
        ...(round1(numeric(requirement.percent)) !== undefined
          ? { percent: round1(numeric(requirement.percent)) }
          : {}),
      };
      return Object.keys(value).length > 0 ? [value] : [];
    });
    return [
      {
        name,
        ...(round1(numeric(degree.percentComplete)) !== undefined
          ? { percent: round1(numeric(degree.percentComplete)) }
          : {}),
        ...(numeric(degree.credits) !== undefined ? { credits: numeric(degree.credits) } : {}),
        ...(numeric(degree.enrollmentCreditsCompleted) !== undefined
          ? { credits_completed: numeric(degree.enrollmentCreditsCompleted) }
          : {}),
        ...(numeric(degree.enrollmentCumulativeGPA) !== undefined
          ? { gpa: numeric(degree.enrollmentCumulativeGPA) }
          : {}),
        requirements_total: rawRequirements.length,
        requirements_available: rawRequirements.length > 0,
        ...(rawRequirements.length > 0 ? { requirements } : {}),
      },
    ];
  });
  return { degrees, count: degrees.length };
}

export interface FlowProfileRow {
  gpa?: number;
  programs?: Array<{ name: string; progress?: number }>;
  advisors?: Array<{ name: string; email?: string }>;
  major?: string;
  school?: string;
  hold?: string;
}

export function projectFlowProfile(raw: unknown): FlowProfileRow {
  const profile = dict(raw);
  const extra = dict(profile.extra_data);
  const programs = list(extra.degree).flatMap((entry) => {
    const degree = dict(entry);
    const name = text(degree.name);
    const progress = numeric(degree.progress);
    return name ? [{ name, ...(progress !== undefined ? { progress } : {}) }] : [];
  });
  const advisors = list(profile.advisors).flatMap((entry) => {
    const advisor = dict(entry);
    const name = text(advisor.name);
    const email = text(advisor.email);
    return name ? [{ name, ...(email ? { email } : {}) }] : [];
  });
  const schools = list(profile.schools)
    .map((entry) => text(dict(entry).name) ?? text(entry))
    .filter((school): school is string => school !== undefined);
  return {
    ...(numeric(profile.gpa) !== undefined ? { gpa: numeric(profile.gpa) } : {}),
    ...(programs.length > 0 ? { programs } : {}),
    ...(advisors.length > 0 ? { advisors } : {}),
    ...(text(profile.major) ? { major: text(profile.major) } : {}),
    ...(schools.length > 0 ? { school: schools.join(", ") } : {}),
    ...(text(extra.student_hold) ? { hold: text(extra.student_hold) } : {}),
  };
}

/* ------------------------------------------------------------------ loaders */

function profileOf(raw: unknown): { name?: string; email?: string; role?: string } {
  const profile = dict(raw);
  const roles = list(profile.roles)
    .map((role) => text(role))
    .filter((role): role is string => role !== undefined);
  const studentRole = roles.find((role) => /^Student - /.test(role)) ?? roles.find((role) => /Student/.test(role));
  return {
    ...(text(profile.name) ? { name: text(profile.name) } : {}),
    ...(text(profile.email) ? { email: text(profile.email) } : {}),
    ...(studentRole ? { role: studentRole.replace(/^Student - /, "") } : {}),
  };
}

export async function loadPortalProfileRaw(deps: AcademicDeps): Promise<unknown> {
  return deps.cache.get("acad:portal_profile", deps.cfg.cache.profileTtlSeconds, () =>
    deps.portal.getPortalJson<unknown>("/api/v1/users/me/"),
  );
}

export async function loadStudentId(deps: AcademicDeps): Promise<string> {
  const raw = dict(await loadPortalProfileRaw(deps));
  const id = text(raw.alternate_id);
  if (!id) throw new PortalUnavailableError("portal profile has no Banner student id");
  return id;
}

export async function loadAcademicProfile(deps: AcademicDeps): Promise<Record<string, unknown>> {
  const identity = profileOf(await loadPortalProfileRaw(deps));
  let flow: FlowProfileRow | undefined;
  try {
    flow = await deps.cache.get("acad:flow_profile", deps.cfg.cache.profileTtlSeconds, async () =>
      projectFlowProfile(
        await deps.portal.getFlowJson<unknown>(
          "/pathify-api/v1/users/me/?field=extra_data&field=gpa&field=advisors&field=major&field=schools",
        ),
      ),
    );
  } catch (error) {
    if (!(error instanceof PortalUnavailableError)) throw error;
  }
  return { ...identity, ...(flow ?? {}), ...(flow ? {} : { academic_profile: "unavailable" }) };
}

export async function loadTerms(deps: AcademicDeps): Promise<TermRow[]> {
  return deps.cache.get("acad:terms", deps.cfg.cache.termsTtlSeconds, async () => {
    const raw = await deps.banner.registration((api) => api.getTerms());
    return projectTerms(raw).sort((a, b) => b.code.localeCompare(a.code));
  });
}

export async function loadCurrentTerm(deps: AcademicDeps): Promise<TermRow> {
  const terms = await loadTerms(deps);
  return resolveTerm(undefined, terms, currentTermCode(nowOf(deps), deps.cfg.timezone));
}

export async function loadHistory(deps: AcademicDeps, term: TermRow): Promise<HistoryProjection> {
  return deps.cache.get(`acad:history:${term.code}`, deps.cfg.cache.scheduleTtlSeconds, async () => {
    const raw = await deps.banner.registration((api) => api.registrationHistory(term.code));
    return projectHistory(raw, term);
  });
}

export async function loadSchedule(deps: AcademicDeps, termInput?: string): Promise<ScheduleResult> {
  const terms = await loadTerms(deps);
  const fallback = currentTermCode(nowOf(deps), deps.cfg.timezone);
  const term = resolveTerm(termInput, terms, fallback);
  const history = await loadHistory(deps, term);
  return projectSchedule(history);
}

export async function loadToday(deps: AcademicDeps): Promise<TodayResult> {
  const term = await loadCurrentTerm(deps);
  const history = await loadHistory(deps, term);
  return projectToday(history, localDate(nowOf(deps), deps.cfg.timezone));
}

export interface GradesResult {
  terms: GradeTerm[];
  count: number;
  latest_term?: TermRow;
}

export async function loadGrades(deps: AcademicDeps, termInput?: string): Promise<GradesResult> {
  const terms = await loadTerms(deps);
  const fallback = currentTermCode(nowOf(deps), deps.cfg.timezone);
  if (termInput) {
    const term = resolveTerm(termInput, terms, fallback);
    const projection = await deps.cache.get(
      `acad:grades:${term.code}`,
      deps.cfg.cache.gradesTtlSeconds,
      async () => {
        const raw = await deps.banner.registration((api) => api.registrationHistory(term.code));
        return projectGradesTerm(projectHistory(raw, term));
      },
    );
    const listed = projection.count > 0 ? [projection] : [];
    return {
      terms: listed,
      count: projection.count,
      ...(listed[0] ? { latest_term: listed[0].term } : {}),
    };
  }

  const current = resolveTerm(undefined, terms, fallback);
  const candidates = terms
    .filter((term) => term.code <= current.code)
    .sort((a, b) => b.code.localeCompare(a.code))
    .slice(0, 3);
  const selected = candidates.length > 0 ? candidates : [current];
  return deps.cache.get("acad:grades:recent", deps.cfg.cache.gradesTtlSeconds, async () => {
    const projections = await deps.banner.registration(async (api) => {
      const output: GradeTerm[] = [];
      for (const term of selected) {
        const raw = await api.registrationHistory(term.code);
        const projection = projectGradesTerm(projectHistory(raw, term));
        if (projection.count > 0) output.push(projection);
      }
      return output;
    });
    const count = projections.reduce((sum, term) => sum + term.count, 0);
    return {
      terms: projections,
      count,
      ...(projections[0] ? { latest_term: projections[0].term } : {}),
    };
  });
}

export async function loadGpa(deps: AcademicDeps): Promise<GpaResult> {
  return deps.cache.get("acad:gpa", deps.cfg.cache.gpaTtlSeconds, async () => {
    const studentId = await loadStudentId(deps);
    const raw = await deps.banner.student((api) => api.viewGpaHours(studentId));
    return projectGpa(raw);
  });
}

export async function loadHolds(deps: AcademicDeps): Promise<HoldsResult> {
  return deps.cache.get("acad:holds", deps.cfg.cache.holdsTtlSeconds, async () => {
    const studentId = await loadStudentId(deps);
    const raw = await deps.banner.student((api) => api.showHolds(studentId));
    return projectHolds(raw);
  });
}

export async function loadRegistration(deps: AcademicDeps): Promise<RegistrationResult> {
  return deps.cache.get("acad:registration", deps.cfg.cache.registrationTtlSeconds, async () => {
    const studentId = await loadStudentId(deps);
    const raw = await deps.banner.student((api) => api.registrationNotices(studentId));
    return projectRegistration(raw);
  });
}

/**
 * Degree audit: the widget list carries a 300 s claims JWT; re-fetch it before
 * every audit call and retry once with fresh claims. The token is never logged
 * or cached.
 */
export async function loadDegreeAudit(deps: AcademicDeps): Promise<DegreeAuditResult> {
  const readClaims = async (): Promise<string> => {
    const widgets = await deps.portal.getPortalJson<unknown>("/api/v1/widgets/?shown=true");
    const widget = list(widgets).find((entry) => text(dict(entry).name) === "Degree Audit");
    const claims = text(dict(widget).claims);
    if (!claims) {
      throw new PortalUnavailableError(
        "Degree Audit widget is not configured for this account",
        "the audit is not exposed; use unw_dashboard for degree progress",
      );
    }
    return claims;
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claims = await readClaims();
    try {
      const audit = await deps.portal.getFlowJson<unknown>(
        `/upstream/v1/degree-audit/degreeworks?claims=${encodeURIComponent(claims)}`,
      );
      return projectDegreeAudit(audit);
    } catch (error) {
      lastError = error;
      if (error instanceof AuthRequiredError && attempt === 0) continue;
      if (!(error instanceof PortalUnavailableError) && attempt === 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("degree audit failed");
}
