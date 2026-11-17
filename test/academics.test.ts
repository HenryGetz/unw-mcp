import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import { PortalUnavailableError } from "../src/auth/session.js";
import type { BannerApi, BannerReader } from "../src/banner/client.js";
import type { PortalReader } from "../src/portal/client.js";
import {
  currentTermCode,
  formatClock,
  loadAcademicProfile,
  loadDegreeAudit,
  loadGpa,
  loadGrades,
  loadHolds,
  loadToday,
  projectCourse,
  projectDegreeAudit,
  projectGpa,
  projectGradesTerm,
  projectHistory,
  projectHolds,
  projectRegistration,
  projectSchedule,
  projectTerms,
  projectToday,
  resolveTerm,
  usDateToIso,
  type AcademicDeps,
} from "../src/portal/academics.js";

const NOW = new Date("2026-11-17T15:00:00Z"); // 09:00 America/Chicago, Tuesday
const TODAY = "2026-11-17";

const termsRaw = [
  { code: "202630", description: "Summer 2027" },
  { code: "202620", description: "Spring 2027" },
  { code: "202610", description: "Fall 2026" },
  { code: "202520", description: "Spring 2026" },
];

function meeting(overrides: Record<string, unknown>) {
  return {
    beginTime: "0900",
    endTime: "0950",
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false,
    sunday: false,
    building: "TEST",
    room: "T101",
    startDate: "08/25/2026",
    endDate: "12/11/2026",
    ...overrides,
  };
}

const historyFall = {
  data: {
    totalCredit: 15,
    registrations: [
      {
        subject: "TST",
        courseNumber: "1010",
        courseTitle: "Example Course",
        courseReferenceNumber: "10001",
        creditHour: 4,
        grade: "",
        instructorNames: ["Doe, Jane"],
        meetingTimes: [meeting({ tuesday: true, beginTime: "1000", endTime: "1050" })],
      },
      {
        subject: "MAT",
        courseNumber: "1234",
        courseTitle: "Discrete Mathematics",
        courseReferenceNumber: "10002",
        creditHour: 4,
        grade: "",
        instructorNames: ["Roe, Richard"],
        meetingTimes: [meeting({ monday: true, beginTime: "0800", endTime: "0850" })],
      },
      {
        subject: "BIB",
        courseNumber: "1010",
        courseTitle: "Old Testament Survey",
        courseReferenceNumber: "10003",
        creditHour: 3,
        instructorNames: ["Smith, A"],
        meetingTimes: [],
      },
      {
        subject: "OLD",
        courseNumber: "0999",
        courseTitle: "Ended Class",
        courseReferenceNumber: "10004",
        creditHour: 4,
        instructorNames: ["Ended, Instructor"],
        meetingTimes: [
          meeting({
            tuesday: true,
            beginTime: "0700",
            endTime: "0750",
            startDate: "08/25/2026",
            endDate: "10/01/2026",
          }),
        ],
      },
    ],
  },
};

const historySpring2026 = {
  data: {
    totalCredit: 8,
    registrations: [
      {
        subject: "TST",
        courseNumber: "1200",
        courseTitle: "Example Course Two",
        courseReferenceNumber: "20001",
        creditHour: 4,
        grade: "A-",
        instructorNames: ["Doe, Jane"],
        meetingTimes: [],
      },
      {
        subject: "ENG",
        courseNumber: "1100",
        courseTitle: "Example Writing",
        courseReferenceNumber: "20002",
        creditHour: 4,
        grade: "B+",
        instructorNames: ["Writer, Pat"],
        meetingTimes: [],
      },
    ],
  },
};

class FakePortal implements PortalReader {
  readonly calls: string[] = [];
  readonly flowCalls: string[] = [];
  constructor(private readonly handler: (kind: "portal" | "flow", url: string) => unknown) {}
  getPortalJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler("portal", url) as T);
  }
  getFlowJson<T>(url: string): Promise<T> {
    this.flowCalls.push(url);
    return Promise.resolve(this.handler("flow", url) as T);
  }
}

interface BannerFixtures {
  terms?: unknown;
  histories?: Record<string, unknown>;
  gpa?: unknown;
  holds?: unknown;
  notices?: unknown;
  years?: unknown;
  award?: unknown;
  cost?: unknown;
}

class FakeBanner implements BannerReader {
  readonly calls: string[] = [];
  constructor(private readonly fixtures: BannerFixtures = {}) {}

  private api(): BannerApi {
    return {
      getTerms: async () => {
        this.calls.push("terms");
        return this.fixtures.terms ?? termsRaw;
      },
      registrationHistory: async (term: string) => {
        this.calls.push(`history:${term}`);
        return this.fixtures.histories?.[term] ?? { data: { registrations: [] } };
      },
      viewGpaHours: async (studentId: string) => {
        this.calls.push(`gpa:${studentId}`);
        return this.fixtures.gpa ?? {};
      },
      showHolds: async (studentId: string) => {
        this.calls.push(`holds:${studentId}`);
        return this.fixtures.holds ?? {};
      },
      registrationNotices: async (studentId: string) => {
        this.calls.push(`notices:${studentId}`);
        return this.fixtures.notices ?? {};
      },
      aidYears: async () => {
        this.calls.push("aid_years");
        return this.fixtures.years ?? {};
      },
      awardInfo: async (aidy: string) => {
        this.calls.push(`award:${aidy}`);
        return this.fixtures.award ?? {};
      },
      costOfAttendance: async (aidy: string) => {
        this.calls.push(`cost:${aidy}`);
        return this.fixtures.cost ?? {};
      },
    };
  }

  registration<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }

  student<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }
}

const profile = {
  name: "Test Student",
  email: "test@example.edu",
  alternate_id: "00000000",
  roles: ["Everyone", "Student - Traditional Undergraduate"],
};
const flowProfile = {
  gpa: "3.25",
  extra_data: { degree: [{ name: "Bachelor of Science", progress: "80.000" }], student_hold: "" },
  advisors: [{ name: "Advisor One", email: "advisor@example.edu" }],
  major: "Computer Science",
  schools: [{ name: "School of Arts and Sciences" }],
};

function deps(portal: PortalReader, banner: BannerReader, cache = new TtlCache()): AcademicDeps {
  return { portal, banner, cfg: config(), cache, now: () => NOW };
}

function simplePortal(): FakePortal {
  return new FakePortal((kind) => (kind === "portal" ? profile : flowProfile));
}

describe("term helpers", () => {
  it("derives Fall, Spring and Summer term codes in the configured zone", () => {
    expect(currentTermCode(new Date("2026-11-17T12:00:00Z"), "America/Chicago")).toBe("202610");
    expect(currentTermCode(new Date("2026-02-01T12:00:00Z"), "America/Chicago")).toBe("202620");
    expect(currentTermCode(new Date("2026-06-15T12:00:00Z"), "America/Chicago")).toBe("202630");
  });

  it("projects and sorts term rows", () => {
    const terms = projectTerms(termsRaw).sort((a, b) => b.code.localeCompare(a.code));
    expect(terms[0]?.code).toBe("202630");
    expect(projectTerms({ results: termsRaw })).toHaveLength(0);
  });

  it("resolves a code, an exact name, a partial name, or the fallback", () => {
    const terms = projectTerms(termsRaw);
    expect(resolveTerm("202610", terms, "202620").description).toBe("Fall 2026");
    expect(resolveTerm("Fall 2026", terms, "202620").code).toBe("202610");
    expect(resolveTerm("spring 2026", terms, "202620").code).toBe("202520");
    expect(resolveTerm(undefined, terms, "202620").code).toBe("202620");
    expect(resolveTerm("209999", terms, "202620")).toEqual({ code: "209999", description: "209999" });
  });

  it("normalizes Banner clocks and dates", () => {
    expect(formatClock("1800")).toBe("18:00");
    expect(formatClock("930")).toBe("09:30");
    expect(formatClock("10:50")).toBe("10:50");
    expect(formatClock("TBA")).toBeUndefined();
    expect(usDateToIso("08/25/2026")).toBe("2026-08-25");
    expect(usDateToIso("junk")).toBe("junk");
    expect(usDateToIso("13/40/2026")).toBe("13/40/2026");
  });
});

describe("Banner history projections", () => {
  it("projects courses, meetings and credits", () => {
    const course = projectCourse((historyFall.data.registrations[0] as unknown));
    expect(course?.course).toBe("TST 1010");
    expect(course?.crn).toBe("10001");
    expect(course?.credits).toBe(4);
    expect(course?.instructors).toEqual(["Doe, Jane"]);
    expect(course?.meetings[0]).toEqual({
      days: ["Tue"],
      start: "10:00",
      end: "10:50",
      location: "TEST T101",
      from: "2026-08-25",
      to: "2026-12-11",
    });
  });

  it("projects a full schedule", () => {
    const history = projectHistory(historyFall, { code: "202610", description: "Fall 2026" });
    const schedule = projectSchedule(history);
    expect(schedule.count).toBe(4);
    expect(schedule.total_credits).toBe(15);
  });

  it("filters today's classes by weekday and meeting date range, sorted by time", () => {
    const today = projectToday(
      projectHistory(historyFall, { code: "202610", description: "Fall 2026" }),
      TODAY,
    );
    expect(today.day).toBe("Tue");
    expect(today.count).toBe(1);
    expect(today.classes[0]?.course).toBe("TST 1010");
    expect(today.classes[0]?.start).toBe("10:00");
    expect(today.classes[0]?.location).toBe("TEST T101");
  });

  it("projects grades only for courses with a grade", () => {
    const grades = projectGradesTerm(projectHistory(historySpring2026, {
      code: "202520",
      description: "Spring 2026",
    }));
    expect(grades.count).toBe(2);
    expect(grades.credits).toBe(8);
    expect(grades.courses.map((course) => course.grade)).toEqual(["A-", "B+"]);
    expect(grades.courses[0]?.course).toBe("TST 1200");
  });
});

describe("student-information projections", () => {
  it("projects GPA rows including zero values", () => {
    const gpa = projectGpa({
      overallGpa: "3.250",
      overallHours: 86,
      gpas: [
        { gpa: "0.000", hours: 16, hoursAttempted: 16, levelDesc: "Undergraduate", typeDesc: "Transfer" },
        { gpa: "3.250", hours: 70, hoursAttempted: 70, levelDesc: "Undergraduate", typeDesc: "Institution" },
      ],
    });
    expect(gpa.overall_gpa).toBe(3.25);
    expect(gpa.overall_hours).toBe(86);
    expect(gpa.rows[0]?.gpa).toBe(0);
    expect(gpa.rows[1]?.type).toBe("Institution");
  });

  it("projects holds with ISO dates and a count", () => {
    const holds = projectHolds({
      holdCount: 1,
      hasHidden: false,
      holds: [
        {
          description: "Example Hold",
          typeCode: "RH",
          fromDate: "11/03/2026",
          toDate: "01/25/2027",
          releasableFlag: false,
          amountOwed: null,
        },
      ],
    });
    expect(holds.count).toBe(1);
    expect(holds.rows[0]).toEqual({
      description: "Example Hold",
      type: "RH",
      from: "2026-11-03",
      to: "2027-01-25",
      releasable: false,
    });
  });

  it("projects registration standing and degrades a missing time ticket honestly", () => {
    const registration = projectRegistration({
      standingAsOf: { termDescription: "Spring 2026", standingDescription: "Good Standing 21 or more cr" },
      academicStanding: { termDescription: "Spring 2026", description: "Good Standing 21 or more cr", preventsRegistration: null },
      timeTickets: [],
      enrollmentStatus: {},
      regStudentStatus: { allowsRegistration: true, description: "Active" },
      timeTicketRequired: false,
      count: 4,
    });
    expect(registration.allows_registration).toBe(true);
    expect(registration.status).toBe("Active");
    expect(registration.standing).toBe("Good Standing 21 or more cr");
    expect(registration.standing_as_of).toBe("Spring 2026");
    expect(registration.time_ticket_source).toBe("not_exposed");
    expect(registration.time_tickets).toBeUndefined();
  });

  it("projects a time ticket when the JSON exposes one", () => {
    const registration = projectRegistration({
      timeTickets: [{ startDate: "11/16/2026 08:30 AM", endDate: "03/22/2027 11:59 PM" }],
    });
    expect(registration.time_ticket_source).toBe("json");
    expect(registration.time_tickets?.[0]?.start).toContain("11/16/2026");
  });
});

describe("degree audit projection", () => {
  it("rounds percentages and caps requirement rows", () => {
    const requirements = Array.from({ length: 60 }, (_, index) => ({
      name: `Requirement ${index + 1}`,
      target: "4",
      progress: "2",
      needed: "2",
      percent: "50",
    }));
    const audit = projectDegreeAudit({
      degrees: [
        {
          name: "Degree: Bachelor of Science",
          percentComplete: "72.933334",
          credits: "34",
          enrollmentCreditsCompleted: "30",
          enrollmentCumulativeGPA: "3.250",
          requirements,
        },
      ],
    });
    expect(audit.count).toBe(1);
    expect(audit.degrees[0]?.percent).toBe(72.9);
    expect(audit.degrees[0]?.gpa).toBe(3.25);
    expect(audit.degrees[0]?.requirements_total).toBe(60);
    expect(audit.degrees[0]?.requirements_available).toBe(true);
    expect(audit.degrees[0]?.requirements).toHaveLength(50);
    expect(audit.degrees[0]?.requirements?.[0]).toEqual({
      name: "Requirement 1",
      target: 4,
      progress: 2,
      needed: 2,
      percent: 50,
    });
  });

  it("marks programs with no upstream requirements as unavailable", () => {
    const audit = projectDegreeAudit({
      degrees: [{ name: "Major: Example", percentComplete: "50", requirements: [] }],
    });
    expect(audit.degrees[0]?.requirements_available).toBe(false);
    expect(audit.degrees[0]?.requirements_total).toBe(0);
    expect(audit.degrees[0] && "requirements" in audit.degrees[0]).toBe(false);
  });
});

describe("academic loaders", () => {
  it("combines portal identity with the Flow academic profile and hides the Banner id", async () => {
    const profileResult = await loadAcademicProfile(deps(simplePortal(), new FakeBanner()));
    expect(profileResult.name).toBe("Test Student");
    expect(profileResult.gpa).toBe(3.25);
    expect(profileResult.major).toBe("Computer Science");
    expect(JSON.stringify(profileResult)).not.toContain("00000000");
  });

  it("degrades the profile when Flow is unavailable", async () => {
    const portal = new FakePortal((kind) => {
      if (kind === "flow") throw new PortalUnavailableError("flow down");
      return profile;
    });
    const result = await loadAcademicProfile(deps(portal, new FakeBanner()));
    expect(result.name).toBe("Test Student");
    expect(result.academic_profile).toBe("unavailable");
  });

  it("loads today's classes and caches terms plus history", async () => {
    const banner = new FakeBanner({
      terms: termsRaw,
      histories: { "202610": historyFall },
    });
    const d = deps(simplePortal(), banner);
    const first = await loadToday(d);
    expect(first.date).toBe(TODAY);
    expect(first.term.code).toBe("202610");
    expect(first.count).toBe(1);
    await loadToday(d);
    expect(banner.calls.filter((call) => call === "terms")).toHaveLength(1);
    expect(banner.calls.filter((call) => call === "history:202610")).toHaveLength(1);
  });

  it("selects recent graded terms by default", async () => {
    const banner = new FakeBanner({
      terms: termsRaw,
      histories: {
        "202610": historyFall,
        "202520": historySpring2026,
      },
    });
    const result = await loadGrades(deps(simplePortal(), banner));
    expect(result.count).toBe(2);
    expect(result.latest_term?.code).toBe("202520");
    expect(result.terms.map((term) => term.term.code)).toEqual(["202520"]);
    expect(banner.calls).toEqual(["terms", "history:202610", "history:202520"]);
  });

  it("loads a requested term by name", async () => {
    const banner = new FakeBanner({
      terms: termsRaw,
      histories: { "202520": historySpring2026 },
    });
    const result = await loadGrades(deps(simplePortal(), banner), "Spring 2026");
    expect(result.count).toBe(2);
    expect(banner.calls).toEqual(["terms", "history:202520"]);
  });

  it("passes the student id to Banner but not into the GPA result", async () => {
    const banner = new FakeBanner({
      gpa: {
        overallGpa: "3.500",
        overallHours: 30,
        gpas: [{ gpa: "3.500", hours: 30, hoursAttempted: 30, levelDesc: "Undergraduate", typeDesc: "Overall" }],
      },
    });
    const result = await loadGpa(deps(simplePortal(), banner));
    expect(result.overall_gpa).toBe(3.5);
    expect(banner.calls).toContain("gpa:00000000");
    expect(JSON.stringify(result)).not.toContain("00000000");
  });

  it("loads holds", async () => {
    const banner = new FakeBanner({
      holds: {
        holdCount: 1,
        hasHidden: false,
        holds: [{ description: "Test Hold", typeCode: "TH", fromDate: "11/03/2026", toDate: "01/25/2027" }],
      },
    });
    const result = await loadHolds(deps(simplePortal(), banner));
    expect(result.count).toBe(1);
    expect(result.rows[0]?.description).toBe("Test Hold");
    expect(banner.calls).toContain("holds:00000000");
  });

  it("re-fetches the degree-audit claims token on every call", async () => {
    let claims = 0;
    const portal = new FakePortal((kind, url) => {
      if (kind === "portal" && url.includes("/widgets/")) {
        claims += 1;
        return [{ name: "Degree Audit", claims: `claim-${claims}` }];
      }
      if (kind === "flow" && url.includes("/degree-audit/")) {
        expect(url).toContain(`claims=claim-${claims}`);
        return { degrees: [{ name: "Degree: BS", percentComplete: "80", requirements: [] }] };
      }
      return profile;
    });
    const auditDeps = deps(portal, new FakeBanner());
    await loadDegreeAudit(auditDeps);
    await loadDegreeAudit(auditDeps);
    expect(claims).toBe(2);
    expect(portal.flowCalls).toHaveLength(2);
  });

  it("retries the audit once with fresh claims", async () => {
    let claims = 0;
    let flowCalls = 0;
    const portal = new FakePortal((kind, url) => {
      if (kind === "portal" && url.includes("/widgets/")) {
        claims += 1;
        return [{ name: "Degree Audit", claims: `claim-${claims}` }];
      }
      if (kind === "flow") {
        flowCalls += 1;
        if (flowCalls === 1) throw new PortalUnavailableError("transient");
        return { degrees: [{ name: "Degree: BS", percentComplete: "80", requirements: [] }] };
      }
      return profile;
    });
    const result = await loadDegreeAudit(deps(portal, new FakeBanner()));
    expect(result.count).toBe(1);
    expect(claims).toBe(2);
  });
});
