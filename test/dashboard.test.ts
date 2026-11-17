import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import {
  loadAnnouncements,
  loadEvents,
  loadOverview,
  loadQuickLinks,
  loadTasks,
  projectEvent,
  projectNotice,
  projectProfile,
  type DashboardDeps,
} from "../src/portal/dashboard.js";
import type { PortalReader } from "../src/portal/client.js";

const NOW = new Date("2026-11-17T15:00:00Z"); // 09:00 America/Chicago

class FakePortal implements PortalReader {
  readonly calls: string[] = [];
  constructor(private readonly handler: (url: string) => unknown) {}

  getPortalJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler(url) as T);
  }

  getFlowJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler(url) as T);
  }
}

function deps(portal: PortalReader, cache = new TtlCache()): DashboardDeps {
  return { portal, cfg: config(), cache, now: () => NOW };
}

const profile = {
  name: "Test Student",
  email: "test@example.edu",
  alternate_id: "00000000",
  roles: ["Everyone", "Student - Traditional Undergraduate"],
  extra_data: {
    degree: [{ name: "Bachelor of Science", progress: "80.000" }],
    student_hold: "Example Hold",
  },
  advisors: [{ id: 1, name: "Advisor One", email: "advisor@example.edu", campus_user: { id: 2 } }],
  majors: [],
};

const notices = {
  count: 2,
  results: [
    {
      id: 11,
      notice_type: "Alert",
      title: "Example registration notice",
      text: "<p>Example notice text.</p>",
      start_date: "2026-11-16T14:30:00Z",
      end_date: "2026-12-31T15:30:00Z",
      require_acknowledgment: true,
      sent_to_count: 500,
      audience: ["x"],
    },
    {
      id: 12,
      notice_type: "Emergency",
      title: "Example chapel notice",
      text_html: "<p>Example text.</p>",
      require_acknowledgment: false,
    },
  ],
};

const tasks = [
  { id: "t2", title: "Later task", text: "do this eventually", due: "2026-12-01T00:00:00Z", is_complete: false },
  { id: "t1", title: "Earlier task", text: "do this first", due: "2026-11-18T00:00:00Z", is_required: true },
  { id: "t3", title: "Done task", is_complete: true, due: "2026-11-01T00:00:00Z" },
];

function event(id: number, start: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Event ${id}`,
    start_date: start,
    end_date: start,
    all_day: false,
    location: "Room 1",
    calendar: { id: 11, name: "Trad Academic Calendar" },
    ...extra,
  };
}

const events = {
  count: 609,
  results: [
    event(1, "2026-11-17T15:55:00Z"), // today
    event(2, "2026-11-16T15:55:00Z"), // yesterday
    event(3, "2026-11-20T15:55:00Z"), // +3 days
    event(4, "2026-11-27T15:55:00Z"), // +10 days
    event(5, "2026-11-18T00:00:00Z", { all_day: true, title: "All day event" }),
    event(1, "2026-11-17T15:55:00Z"), // duplicate
  ],
};

function router(url: string): unknown {
  if (url.includes("/api/v1/users/me/")) return profile;
  if (url.includes("/api/v1/notices/")) return notices;
  if (url.includes("/tasks/")) return tasks;
  if (url.includes("/api/v2/events/")) return events;
  if (url.includes("/quick-link-cards/")) {
    return [
      { id: 1, title: "Spring Registration", links: [{ label: "Register Here", url: "https://example.edu/register" }] },
      { id: 2, title: "Empty card", links: [] },
    ];
  }
  throw new Error(`unexpected url ${url}`);
}

describe("profile projection", () => {
  it("projects identity, programs, advisors and hold without the Banner id", () => {
    const row = projectProfile(profile);
    expect(row.name).toBe("Test Student");
    expect(row.role).toBe("Traditional Undergraduate");
    expect(row.programs).toEqual([{ name: "Bachelor of Science", progress: 80 }]);
    expect(row.advisors?.[0]?.name).toBe("Advisor One");
    expect(row.hold).toBe("Example Hold");
    expect(JSON.stringify(row)).not.toContain("00000000");
    expect(JSON.stringify(row)).not.toContain("campus_user");
  });

  it("tolerates malformed profile payloads", () => {
    const row = projectProfile({ extra_data: null, roles: "nope", advisors: {} });
    expect(row).toEqual({});
  });
});

describe("notice projection", () => {
  it("strips HTML and keeps the preview compact", () => {
    const row = projectNotice(notices.results[0], 300);
    expect(row?.title).toBe("Example registration notice");
    expect(row?.preview).toBe("Example notice text.");
    expect(row?.requires_ack).toBe(true);
    expect(JSON.stringify(row)).not.toContain("<");
  });

  it("falls back to text_html and truncates", () => {
    const row = projectNotice({ title: "T", text_html: "<p>" + "x".repeat(80) + "</p>" }, 40);
    expect(row?.preview?.length).toBeLessThanOrEqual(40);
    expect(row?.preview?.endsWith("…")).toBe(true);
  });

  it("skips rows without a title", () => {
    expect(projectNotice({ text: "no title" }, 100)).toBeUndefined();
  });
});

describe("dashboard loaders", () => {
  it("loads announcements with the right filter and caches them", async () => {
    const portal = new FakePortal(router);
    const d = deps(portal);
    const first = await loadAnnouncements(d);
    expect(first.count).toBe(2);
    expect(first.items).toHaveLength(2);
    expect(portal.calls[0]).toContain("notice_type=Alert");
    expect(portal.calls[0]).toContain("status=APPROVED");
    expect(portal.calls[0]).toContain("limit=5");
    await loadAnnouncements(d);
    expect(portal.calls).toHaveLength(1);
  });

  it("sorts tasks by due date and previews the text", async () => {
    const result = await loadTasks(deps(new FakePortal(router)));
    expect(result.count).toBe(3);
    expect(result.items.map((task) => task.id)).toEqual(["t3", "t1", "t2"]);
    expect(result.items[1]?.detail).toBe("do this first");
    expect(result.items[1]?.required).toBe(true);
  });

  it("filters events to the local-date window and de-duplicates", async () => {
    const result = await loadEvents(deps(new FakePortal(router)), { days: 2 });
    expect(result.window).toEqual({ from: "2026-11-17", to: "2026-11-19", days: 2 });
    expect(result.items.map((row) => row.id)).toEqual([1, 5]);
    expect(result.items[1]?.local).toBe("2026-11-18 (all day)");
    expect(result.count).toBe(2);
  });

  it("caps event rows", async () => {
    const result = await loadEvents(deps(new FakePortal(router)), { days: 7, limit: 1 });
    expect(result.count).toBe(3);
    expect(result.items).toHaveLength(1);
  });

  it("projects quick links and skips empty cards", async () => {
    const result = await loadQuickLinks(deps(new FakePortal(router)));
    expect(result.count).toBe(1);
    expect(result.items[0]?.card).toBe("Spring Registration");
    expect(result.items[0]?.links[0]?.label).toBe("Register Here");
  });

  it("combines the overview", async () => {
    const result = await loadOverview(deps(new FakePortal(router)));
    expect(result.student.name).toBe("Test Student");
    expect(result.announcements.count).toBe(2);
    expect(result.tasks.pending).toBe(2);
    expect(result.today.window.days).toBe(0);
    expect(result.today.items.map((row) => row.id)).toEqual([1]);
  });
});

describe("event projection", () => {
  it("renders local times for timed events", () => {
    const row = projectEvent(event(9, "2026-11-17T15:55:00Z", { end_date: "2026-11-17T16:35:00Z" }), "America/Chicago");
    expect(row?.local).toBe("2026-11-17 09:55 → 2026-11-17 10:35");
  });

  it("drops events without a title or start", () => {
    expect(projectEvent({ id: 1, start_date: "2026-11-17T00:00:00Z" }, "America/Chicago")).toBeUndefined();
  });
});
