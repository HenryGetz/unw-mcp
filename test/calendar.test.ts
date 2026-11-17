import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import type { PortalReader } from "../src/portal/client.js";
import {
  buildAcademicDataset,
  discoverFeedIds,
  feedUrl,
  loadAcademicRows,
  loadCampusEvents,
  matchesCalendarKind,
  parseIcs,
  type CalendarDeps,
} from "../src/portal/calendar.js";

const NOW = new Date("2026-11-17T15:00:00Z");

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:thanksgiving
DTSTART;VALUE=DATE:20261125
DTEND;VALUE=DATE:20261126
SUMMARY:TRAD: No Classes - Thanksgiving Recess
LOCATION:UNW Campus
END:VEVENT
BEGIN:VEVENT
UID:courses-end
DTSTART;TZID=America/Chicago:20261211T120000
DTEND;TZID=America/Chicago:20261211T130000
SUMMARY:TRAD: Courses End - Fall Semester & Quad 2
END:VEVENT
BEGIN:VEVENT
UID:semester-end
DTSTART;VALUE=DATE:20261217
SUMMARY:TRAD: Semester Ends - Fall 2026
END:VEVENT
BEGIN:VEVENT
UID:spring-start
DTSTART;VALUE=DATE:20270111
SUMMARY:TRAD: Semester Begins - Spring 2027
END:VEVENT
BEGIN:VEVENT
UID:easter
DTSTART;VALUE=DATE:20270326
SUMMARY:TRAD: No Classes - Easter 
 Recess
END:VEVENT
BEGIN:VEVENT
UID:withdraw
DTSTART;VALUE=DATE:20261120
SUMMARY:TRAD: Last Day to Withdraw - Fall 2026
END:VEVENT
END:VCALENDAR`;

const PAGE = `<html><body>
<iframe src="https://www.google.com/calendar/embed?src=abc123%40group.calendar.google.com&ctz=America%2FChicago"></iframe>
<a href="https://calendar.google.com/calendar/ical/def456%40group.calendar.google.com/public/basic.ics">feed</a>
</body></html>`;

class FakePortal implements PortalReader {
  constructor(private readonly handler: (url: string) => unknown) {}
  getPortalJson<T>(url: string): Promise<T> {
    return Promise.resolve(this.handler(url) as T);
  }
  getFlowJson<T>(): Promise<T> {
    return Promise.resolve([] as T);
  }
}

function deps(fetchImpl?: CalendarDeps["fetch"], cache = new TtlCache()): CalendarDeps {
  return {
    portal: new FakePortal(() => ({ count: 0, results: [] })),
    cfg: config(),
    cache,
    now: () => NOW,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

function response(body: string, contentType = "text/plain"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const fakeFetch: CalendarDeps["fetch"] = async (url) => {
  if (url.includes("/academics/academic-calendar/")) return response(PAGE, "text/html");
  if (url.includes("/calendar/ical/")) return response(ICS, "text/calendar");
  return response("", "text/plain");
};

describe("ICS parsing", () => {
  it("parses all-day, timed, folded and location fields", () => {
    const events = parseIcs(ICS);
    expect(events).toHaveLength(6);
    const thanksgiving = events.find((event) => event.uid === "thanksgiving");
    expect(thanksgiving).toEqual({
      uid: "thanksgiving",
      date: "2026-11-25",
      summary: "TRAD: No Classes - Thanksgiving Recess",
      location: "UNW Campus",
      all_day: true,
    });
    const timed = events.find((event) => event.uid === "courses-end");
    expect(timed?.all_day).toBe(false);
    expect(timed?.date).toBe("2026-12-11");
    expect(events.find((event) => event.uid === "easter")?.summary).toBe(
      "TRAD: No Classes - Easter Recess",
    );
  });

  it("deduplicates events across feeds", () => {
    const events = parseIcs(ICS);
    const dataset = buildAcademicDataset(
      [
        { id: "a", events },
        { id: "b", events: events.filter((event) => event.uid === "thanksgiving") },
      ],
      NOW,
    );
    expect(dataset.feed_count).toBe(2);
    expect(dataset.event_count).toBe(6);
  });

  it("merges cohort prefixes across feeds", () => {
    const dataset = buildAcademicDataset(
      [
        {
          id: "a",
          events: [
            { date: "2026-11-25", summary: "TRAD: No Classes - Thanksgiving Recess", all_day: true },
            { date: "2026-11-25", summary: "DE: No Classes - Thanksgiving Recess", all_day: true },
            { date: "2026-11-26", summary: "AGS: Thanksgiving holiday - UNW Closed", all_day: true },
          ],
        },
      ],
      NOW,
    );
    expect(dataset.event_count).toBe(2);
    expect(dataset.events[0]?.summary).toBe("No Classes - Thanksgiving Recess");
    expect(dataset.events[0]?.audiences).toEqual(["TRAD", "DE"]);
    expect(dataset.events[1]?.summary).toBe("Thanksgiving holiday - UNW Closed");
  });
});

describe("feed discovery", () => {
  it("finds embed, ICS-link and cid IDs", () => {
    const ids = discoverFeedIds(PAGE);
    expect(new Set(ids)).toEqual(
      new Set(["abc123@group.calendar.google.com", "def456@group.calendar.google.com"]),
    );
    expect(feedUrl("abc123@group.calendar.google.com")).toBe(
      "https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/public/basic.ics",
    );
  });

  it("returns no ids for an unrelated page", () => {
    expect(discoverFeedIds("<html>nothing</html>")).toEqual([]);
  });
});

describe("calendar classification", () => {
  it("separates breaks, deadlines and academic dates", () => {
    expect(matchesCalendarKind("TRAD: No Classes - Thanksgiving Recess", "breaks")).toBe(true);
    expect(matchesCalendarKind("TRAD: No Classes - Thanksgiving Recess", "deadlines")).toBe(false);
    expect(matchesCalendarKind("TRAD: Last Day to Withdraw - Fall 2026", "deadlines")).toBe(true);
    expect(matchesCalendarKind("TRAD: Courses End - Fall Semester", "academic")).toBe(true);
    expect(matchesCalendarKind("Art Club", "academic")).toBe(false);
  });
});

describe("academic loaders", () => {
  it("returns upcoming academic rows and caches the feeds", async () => {
    let pageCalls = 0;
    let feedCalls = 0;
    const countingFetch: CalendarDeps["fetch"] = async (url, init) => {
      if (url.includes("/academics/academic-calendar/")) {
        pageCalls += 1;
        return fakeFetch(url, init);
      }
      feedCalls += 1;
      return fakeFetch(url, init);
    };
    const d = deps(countingFetch);
    const result = await loadAcademicRows(d, "academic", { days: 90, limit: 20 });
    expect(result.window.from).toBe("2026-11-17");
    expect(result.items.map((row) => row.date)).toEqual([
      "2026-11-25",
      "2026-12-11",
      "2026-12-17",
      "2027-01-11",
    ]);
    expect(result.items[0]?.summary).toContain("Thanksgiving");
    await loadAcademicRows(d, "academic", { days: 90, limit: 20 });
    expect(pageCalls).toBe(1);
    expect(feedCalls).toBe(2);
  });

  it("filters rows by a case-insensitive title query", async () => {
    const result = await loadAcademicRows(deps(fakeFetch), "breaks", {
      days: 365,
      limit: 10,
      query: "THANKSGIVING",
    });
    expect(result.count).toBe(1);
    expect(result.items[0]?.summary).toContain("Thanksgiving");
  });

  it("filters breaks and deadlines", async () => {
    const d = deps(fakeFetch);
    const breaks = await loadAcademicRows(d, "breaks", { days: 200, limit: 10 });
    expect(breaks.items.map((row) => row.date)).toEqual(["2026-11-25", "2027-03-26"]);

    const deadlines = await loadAcademicRows(d, "deadlines", { days: 90, limit: 10 });
    expect(deadlines.items.map((row) => row.date)).toEqual(["2026-11-20"]);
  });

  it("fails closed when no feeds are discovered", async () => {
    const d = deps(async () => response("<html>no feeds</html>", "text/html"));
    await expect(loadAcademicRows(d, "academic")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("campus events", () => {
  it("filters portal events to the local-date window", async () => {
    const portal = new FakePortal(() => ({
      count: 3,
      results: [
        {
          id: 1,
          title: "Today Event",
          start_date: "2026-11-17T15:55:00Z",
          end_date: "2026-11-17T16:35:00Z",
          all_day: false,
          location: "Chapel",
          calendar: { name: "SDC" },
        },
        {
          id: 2,
          title: "Tomorrow Event",
          start_date: "2026-11-18T15:55:00Z",
          all_day: false,
        },
        {
          id: 3,
          title: "Next Week",
          start_date: "2026-11-24T15:55:00Z",
          all_day: false,
        },
      ],
    }));
    const d: CalendarDeps = { portal, cfg: config(), cache: new TtlCache(), now: () => NOW };
    const result = await loadCampusEvents(d, { days: 1, limit: 10 });
    expect(result.window.from).toBe("2026-11-17");
    expect(result.window.to).toBe("2026-11-18");
    expect(result.items.map((row) => row.title)).toEqual(["Today Event", "Tomorrow Event"]);
  });
});
