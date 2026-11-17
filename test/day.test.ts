import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import type { BannerApi, BannerReader } from "../src/banner/client.js";
import type { PortalReader } from "../src/portal/client.js";
import type { DiningDayResult } from "../src/portal/dining.js";
import { loadDay, pickNextMeal, type DayDeps } from "../src/portal/day.js";

const NOW = new Date("2026-11-17T15:00:00Z"); // 09:00 America/Chicago, Tuesday

function stations(count: number, items: number) {
  return Array.from({ length: count }, (_, station) => ({
    label: `Station ${station}`,
    items: Array.from({ length: items }, (_, item) => `item ${station}-${item}`),
  }));
}

function diningDay(parts: Array<{ label: string; start: string; end: string }>): DiningDayResult {
  return {
    date: "2026-11-17",
    detail: "full",
    status: "ok",
    cafes: [
      {
        name: "The Dining Center",
        status: "ok",
        dayparts: parts.map((part) => ({
          label: part.label,
          start: part.start,
          end: part.end,
          stations: stations(8, 10),
        })),
      },
    ],
  };
}

class FakePortal implements PortalReader {
  constructor(private readonly handler: (kind: "portal" | "flow", url: string) => unknown) {}
  getPortalJson<T>(url: string): Promise<T> {
    return Promise.resolve(this.handler("portal", url) as T);
  }
  getFlowJson<T>(url: string): Promise<T> {
    return Promise.resolve(this.handler("flow", url) as T);
  }
}

class FakeBanner implements BannerReader {
  private api(): BannerApi {
    return {
      getTerms: async () => [{ code: "202610", description: "Fall 2026" }],
      registrationHistory: async () => ({
        data: {
          totalCredit: 4,
          registrations: [
            {
              subject: "TST",
              courseNumber: "1010",
              courseTitle: "Example Course",
              courseReferenceNumber: "10001",
              creditHour: 4,
              instructorNames: ["Doe, Jane"],
              meetingTimes: [
                {
                  beginTime: "1000",
                  endTime: "1050",
                  tuesday: true,
                  monday: false,
                  wednesday: false,
                  thursday: false,
                  friday: false,
                  saturday: false,
                  sunday: false,
                  building: "TEST",
                  room: "T101",
                  startDate: "08/25/2026",
                  endDate: "12/11/2026",
                },
              ],
            },
          ],
        },
      }),
      viewGpaHours: async () => ({}),
      showHolds: async () => ({}),
      registrationNotices: async () => ({}),
      aidYears: async () => ({}),
      awardInfo: async () => ({}),
      costOfAttendance: async () => ({}),
    };
  }
  registration<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }
  student<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return task(this.api());
  }
}

const diningPayload = {
  campuses: {
    "76": {
      cafes: {
        "189": { name: "The Dining Center", address: "1 Campus" },
        "190": { name: "Eagles Nest", address: "2 Campus" },
      },
    },
  },
  data: {
    "189": {
      "2026-11-17": {
        days: [
          {
            date: "2026-11-17",
            cafes: {
              "189": {
                dayparts: [
                  [
                    {
                      label: "Breakfast",
                      starttime: "07:20",
                      endtime: "09:30",
                      stations: [{ label: "breakfast", items: ["1", "2"] }],
                    },
                    {
                      label: "Lunch",
                      starttime: "11:00",
                      endtime: "14:00",
                      stations: [{ label: "grill", items: ["3"] }],
                    },
                  ],
                ],
              },
            },
          },
        ],
        items: {
          "1": { label: "eggs" },
          "2": { label: "sausage" },
          "3": { label: "burger" },
        },
      },
    },
  },
};

describe("pickNextMeal", () => {
  it("selects the current daypart", () => {
    const meal = pickNextMeal(
      diningDay([
        { label: "Breakfast", start: "07:20", end: "09:30" },
        { label: "Lunch", start: "11:00", end: "14:00" },
      ]),
      "09:00",
    );
    expect(meal?.meal).toBe("Breakfast");
    expect(meal?.cafe).toBe("The Dining Center");
  });

  it("selects the next daypart between meals", () => {
    const meal = pickNextMeal(
      diningDay([
        { label: "Breakfast", start: "07:20", end: "09:30" },
        { label: "Lunch", start: "11:00", end: "14:00" },
      ]),
      "10:00",
    );
    expect(meal?.meal).toBe("Lunch");
  });

  it("returns undefined after the last meal", () => {
    const meal = pickNextMeal(
      diningDay([
        { label: "Breakfast", start: "07:20", end: "09:30" },
        { label: "Lunch", start: "11:00", end: "14:00" },
      ]),
      "15:00",
    );
    expect(meal).toBeUndefined();
  });

  it("caps stations and items", () => {
    const meal = pickNextMeal(
      diningDay([{ label: "Lunch", start: "11:00", end: "14:00" }]),
      "12:00",
    );
    expect(meal?.stations).toHaveLength(6);
    expect(meal?.stations[0]?.items).toHaveLength(8);
  });
});

describe("loadDay", () => {
  it("combines classes, 24h events, pending tasks and the next meal", async () => {
    const portal = new FakePortal((_kind, url) => {
      if (url.includes("/api/v1/notices/")) {
        return {
          count: 3,
          results: [
            { id: 1, notice_type: "Alert", title: "Notice one", text: "<p>One</p>" },
            { id: 2, notice_type: "Alert", title: "Notice two", text: "<p>Two</p>" },
            { id: 3, notice_type: "Alert", title: "Notice three", text: "<p>Three</p>" },
          ],
        };
      }
      if (url.includes("/tasks/")) {
        return [
          { id: "t1", title: "Task one", due: "2026-11-18T00:00:00Z", is_complete: false },
          { id: "t2", title: "Task two", due: "2026-11-19T00:00:00Z", is_complete: false },
          { id: "t3", title: "Done", due: "2026-11-01T00:00:00Z", is_complete: true },
        ];
      }
      if (url.includes("/api/v2/events/")) {
        return {
          count: 3,
          results: [
            {
              id: 1,
              title: "Chapel",
              start_date: "2026-11-17T15:55:00Z",
              end_date: "2026-11-17T16:35:00Z",
              all_day: false,
              location: "Example Hall",
              calendar: { name: "SDC" },
            },
            {
              id: 2,
              title: "Tomorrow",
              start_date: "2026-11-18T14:00:00Z",
              all_day: false,
            },
            {
              id: 4,
              title: "Chapel",
              start_date: "2026-11-17T15:55:00Z",
              end_date: "2026-11-17T16:35:00Z",
              all_day: false,
              location: "Example Hall",
              calendar: { name: "SDC" },
            },
            {
              id: 3,
              title: "Later",
              start_date: "2026-11-20T15:55:00Z",
              all_day: false,
            },
          ],
        };
      }
      return {};
    });
    const cache = new TtlCache();
    const cfg = config();
    const deps: DayDeps = {
      academic: {
        portal,
        banner: new FakeBanner(),
        cfg,
        cache,
        now: () => NOW,
      },
      dashboard: { portal, cfg, cache, now: () => NOW },
      dining: {
        cfg,
        cache,
        now: () => NOW,
        fetch: async () =>
          new Response(JSON.stringify(diningPayload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
      cfg,
      now: () => NOW,
    };
    const day = await loadDay(deps);
    expect(day.date).toBe("2026-11-17");
    expect(day.day).toBe("Tue");
    expect(day.classes_total).toBe(1);
    expect(day.classes[0]?.course).toBe("TST 1010");
    expect(day.events.map((event) => event.title)).toEqual(["Chapel", "Tomorrow"]);
    expect(day.events[0]?.duplicate_count).toBe(1);
    expect(day.announcements?.map((notice) => notice.title)).toEqual([
      "Notice one",
      "Notice two",
    ]);
    expect(day.tasks_pending).toBe(2);
    expect(day.tasks).toHaveLength(2);
    expect(day.next_meal?.meal).toBe("Breakfast");
    expect(day.next_meal?.stations[0]?.items).toEqual(["eggs", "sausage"]);
  });
});
