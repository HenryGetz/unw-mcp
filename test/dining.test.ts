import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import {
  loadDiningDataset,
  loadDiningDay,
  loadDiningLocations,
  loadDiningWeek,
  projectDiningDataset,
  projectDiningDay,
  projectDiningLocations,
  projectDiningWeek,
  type DiningDeps,
} from "../src/portal/dining.js";

const NOW = new Date("2026-11-17T15:00:00Z"); // 09:00 America/Chicago

function daypart(label: string, start: string, end: string, items: string[], station = "station") {
  return {
    label,
    starttime: start,
    endtime: end,
    stations: [{ label: station, items }],
  };
}

function dayBlock(
  cafeId: string,
  date: string,
  dayparts: unknown[][],
  items: Record<string, { label: string }>,
) {
  return {
    days: [{ date, cafes: { [cafeId]: { dayparts } } }],
    items,
  };
}

const items = {
  "1": { label: "cage-free egg" },
  "2": { label: "pork sausage" },
  "3": { label: "burger" },
  "4": { label: "veggie burger" },
};

const payload = {
  lastUpdated: 1794921268614,
  campuses: {
    "76": {
      cafes: {
        "189": {
          name: "The Dining Center &amp; Grill",
          address: "3003 Snelling Ave",
          city: "Roseville",
          state: "MN",
          zip: "55113",
          weekly_schedule: "<p>Mon–Fri 7:00–21:00</p>",
          message: "<p>Closed Sunday</p>",
          timezone: "America/Chicago",
        },
        "190": {
          name: "Eagles&#039; Nest",
          address: "1 Campus Dr",
          city: "Roseville",
          state: "MN",
          zip: "55113",
          weekly_schedule: "<p>11:00–23:00</p>",
          message: "",
        },
        "191": {
          name: "The Heritage Café",
          address: "2 Campus Dr",
          city: "Roseville",
          state: "MN",
          zip: "55113",
          weekly_schedule: "",
          message: "",
        },
      },
    },
  },
  data: {
    "189": {
      "2026-11-17": dayBlock(
        "189",
        "2026-11-17",
        [
          [
            {
              label: "Breakfast",
              starttime: "07:20",
              endtime: "09:30",
              stations: [
                { label: "breakfast", items: ["1", "2", "999"] },
                { label: "empty", items: [] },
              ],
            },
            daypart("Lunch", "11:00", "14:00", ["3", "4"], "grill"),
          ],
          [daypart("Dinner", "16:30", "19:30", ["3"], "dinner")],
        ],
        items,
      ),
      "2026-11-18": dayBlock("189", "2026-11-18", [[daypart("Lunch", "11:00", "14:00", ["3"])]], items),
    },
    "190": {
      "2026-11-17": dayBlock("190", "2026-11-17", [[daypart("Lunch", "11:00", "23:00", ["3"])]], items),
    },
  },
};

function deps(fetchImpl?: DiningDeps["fetch"], cache = new TtlCache()): DiningDeps {
  return {
    cfg: config(),
    cache,
    now: () => NOW,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("dining projection", () => {
  it("projects the payload into a date-indexed dataset without raw recipes", () => {
    const dataset = projectDiningDataset(payload);
    expect(dataset.cafes.map((cafe) => cafe.name)).toEqual([
      "The Dining Center & Grill",
      "Eagles' Nest",
      "The Heritage Café",
    ]);
    expect(dataset.dates).toEqual(["2026-11-17", "2026-11-18"]);
    expect(dataset.last_updated).toBe(new Date(1794921268614).toISOString());
    expect(JSON.stringify(dataset)).not.toContain("recipes");
  });

  it("projects one day with dayparts, stations and item labels", () => {
    const dataset = projectDiningDataset(payload);
    const day = projectDiningDay(dataset, "2026-11-17");
    expect(day.status).toBe("ok");
    expect(day.cafes).toHaveLength(3);
    const dining = day.cafes[0]!;
    expect(dining.status).toBe("ok");
    expect(dining.dayparts?.map((part) => part.label)).toEqual(["Breakfast", "Lunch", "Dinner"]);
    expect(dining.dayparts?.[0]?.stations).toEqual([
      { label: "breakfast", items: ["cage-free egg", "pork sausage"] },
    ]);
    expect(day.cafes[2]?.status).toBe("no_menu");
  });

  it("filters by cafe name and reports an unavailable date", () => {
    const dataset = projectDiningDataset(payload);
    const filtered = projectDiningDay(dataset, "2026-11-17", { cafe: "eagles" });
    expect(filtered.cafes).toHaveLength(1);
    expect(filtered.cafes[0]?.name).toBe("Eagles' Nest");

    const missing = projectDiningDay(dataset, "2026-11-20");
    expect(missing.status).toBe("not_available");
    expect(missing.available_dates).toEqual(["2026-11-17", "2026-11-18"]);
  });

  it("filters by meal and reports no_meal when the daypart is absent", () => {
    const dataset = projectDiningDataset(payload);
    const lunch = projectDiningDay(dataset, "2026-11-17", { cafe: "Dining Center", meal: "lunch" });
    expect(lunch.status).toBe("ok");
    expect(lunch.meal_filter).toBe("lunch");
    expect(lunch.cafes[0]?.dayparts?.map((part) => part.label)).toEqual(["Lunch"]);

    const absent = projectDiningDay(dataset, "2026-11-17", { cafe: "Dining Center", meal: "snack" });
    expect(absent.status).toBe("no_meal");
    expect(absent.cafes[0]?.status).toBe("no_meal");
  });

  it("defaults to brief detail and keeps full available", () => {
    const items: Record<string, { label: string }> = {};
    for (let index = 0; index < 80; index += 1) items[String(index)] = { label: `item ${index}` };
    const stations = Array.from({ length: 8 }, (_, station) => ({
      label: `Station ${station}`,
      items: Array.from({ length: 10 }, (_, item) => String(station * 10 + item)),
    }));
    const many = {
      campuses: { "76": { cafes: { "1": { name: "Big Cafe" } } } },
      data: {
        "1": {
          "2026-11-17": {
            days: [
              {
                date: "2026-11-17",
                cafes: {
                  "1": {
                    dayparts: [[{ label: "Lunch", starttime: "11:00", endtime: "14:00", stations }]],
                  },
                },
              },
            ],
            items,
          },
        },
      },
    };
    const dataset = projectDiningDataset(many, { maxStations: 12, maxItems: 25 });
    const brief = projectDiningDay(dataset, "2026-11-17");
    expect(brief.detail).toBe("brief");
    expect(brief.cafes[0]?.dayparts?.[0]?.stations).toHaveLength(6);
    expect(brief.cafes[0]?.dayparts?.[0]?.stations[0]?.items).toHaveLength(8);

    const full = projectDiningDay(dataset, "2026-11-17", { detail: "full" });
    expect(full.cafes[0]?.dayparts?.[0]?.stations).toHaveLength(8);
    expect(full.cafes[0]?.dayparts?.[0]?.stations[0]?.items).toHaveLength(10);
  });

  it("caps stations and items per station", () => {
    const dataset = projectDiningDataset(payload, { maxStations: 1, maxItems: 1 });
    const breakfast = dataset.days["2026-11-17"]?.["189"]?.[0];
    expect(breakfast?.stations).toHaveLength(1);
    expect(breakfast?.stations[0]?.items).toEqual(["cage-free egg"]);
    expect(breakfast?.stations[0]?.items_total).toBe(2);
  });

  it("projects a compact week with item counts and samples", () => {
    const dataset = projectDiningDataset(payload);
    const week = projectDiningWeek(dataset, "2026-11-17");
    expect(week.from).toBe("2026-11-17");
    expect(week.to).toBe("2026-11-18");
    expect(week.count).toBe(2);
    expect(week.days[0]?.cafes[0]?.dayparts?.[0]).toMatchObject({
      label: "Breakfast",
      stations: 1,
      items: 2,
    });
    expect(week.days[0]?.cafes[0]?.dayparts?.[0]?.sample).toEqual([
      "cage-free egg",
      "pork sausage",
    ]);
    expect(JSON.stringify(week)).not.toContain("recipes");
  });

  it("projects locations with plain-text hours and messages", () => {
    const locations = projectDiningLocations(projectDiningDataset(payload));
    expect(locations.count).toBe(3);
    expect(locations.cafes[0]?.hours).toBe("Mon–Fri 7:00–21:00");
    expect(locations.cafes[0]?.message).toBe("Closed Sunday");
    expect(JSON.stringify(locations)).not.toContain("<p>");
  });
});

describe("dining loaders", () => {
  it("fetches once and reuses the cached dataset", async () => {
    let calls = 0;
    const fakeFetch: DiningDeps["fetch"] = async () => {
      calls += 1;
      return response(payload);
    };
    const d = deps(fakeFetch);
    const first = await loadDiningDay(d);
    const second = await loadDiningDay(d, "2026-11-18");
    expect(first.date).toBe("2026-11-17");
    expect(second.date).toBe("2026-11-18");
    expect(calls).toBe(1);
  });

  it("loads week and locations from the same cache", async () => {
    let calls = 0;
    const fakeFetch: DiningDeps["fetch"] = async () => {
      calls += 1;
      return response(payload);
    };
    const d = deps(fakeFetch);
    expect((await loadDiningWeek(d)).count).toBe(2);
    expect((await loadDiningLocations(d)).count).toBe(3);
    expect(calls).toBe(1);
  });

  it("reports an HTTP failure as unavailable", async () => {
    const d = deps(async () => new Response("down", { status: 503 }));
    await expect(loadDiningDataset(d)).rejects.toMatchObject({ code: "unavailable" });
  });
});
