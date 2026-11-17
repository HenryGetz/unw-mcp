#!/usr/bin/env node
/**
 * Live proof for phase 1. Spawns the built server, checks the session, restores
 * it if needed, then calls every dashboard op. Prints counts and field names
 * only — names, e-mail addresses, IDs, balances and tokens never reach stdout.
 *
 *   npm run build && npm run live-proof
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "unw-mcp-live-proof", version: "0.1.0" });

function parse(result) {
  const text = result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function call(name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const data = parse(result);
  return {
    ms: Date.now() - started,
    isError: result.isError ?? false,
    data,
    bytes: Buffer.byteLength(JSON.stringify(data)),
  };
}

function keys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`initialized: ${info?.name} ${info?.version}`);
  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((tool) => tool.name).join(", ")}`);

  let status = await call("unw_session", { op: "status" });
  console.log(
    `session.status: ok=${!status.isError} authenticated=${status.data.authenticated} ` +
      `portal_cookie=${Boolean(status.data.cookies?.portal_session)} ` +
      `entra_sso=${status.data.cookies?.entra_sso} (${status.ms}ms)`,
  );
  if (!status.data.authenticated) {
    const reauth = await call("unw_session", { op: "reauth" });
    console.log(
      `session.reauth: ok=${!reauth.isError} authenticated=${reauth.data.authenticated} ` +
        `method=${reauth.data.auth_method ?? "n/a"} (${reauth.ms}ms)`,
    );
    status = await call("unw_session", { op: "status" });
  }
  if (!status.data.authenticated) {
    console.error("NOT AUTHENTICATED — live proof cannot continue");
    process.exitCode = 1;
  } else {
    const overview = await call("unw_dashboard", { op: "overview" });
    const o = overview.data;
    console.log(
      `dashboard.overview: ok=${!overview.isError} student_fields=[${keys(o.student).join(",")}] ` +
        `programs=${o.student?.programs?.length ?? 0} advisors=${o.student?.advisors?.length ?? 0} ` +
        `announcements=${o.announcements?.count ?? 0}/${o.announcements?.items?.length ?? 0} ` +
        `tasks_pending=${o.tasks?.pending ?? 0} today_events=${o.today?.items?.length ?? 0} ` +
        `(${overview.ms}ms, ${overview.bytes}B)`,
    );

    const announcements = await call("unw_dashboard", { op: "announcements", limit: 5 });
    console.log(
      `dashboard.announcements: ok=${!announcements.isError} count=${announcements.data.count ?? 0} ` +
        `rows=${announcements.data.items?.length ?? 0} ` +
        `fields=[${keys(announcements.data.items?.[0]).join(",")}] (${announcements.ms}ms, ${announcements.bytes}B)`,
    );

    const tasks = await call("unw_dashboard", { op: "tasks", limit: 10 });
    console.log(
      `dashboard.tasks: ok=${!tasks.isError} count=${tasks.data.count ?? 0} ` +
        `pending=${tasks.data.pending ?? 0} rows=${tasks.data.items?.length ?? 0} (${tasks.ms}ms, ${tasks.bytes}B)`,
    );

    const events = await call("unw_dashboard", { op: "events", days: 7, limit: 10 });
    console.log(
      `dashboard.events: ok=${!events.isError} window=${events.data.window?.from}..${events.data.window?.to} ` +
        `count=${events.data.count ?? 0} rows=${events.data.items?.length ?? 0} ` +
        `fields=[${keys(events.data.items?.[0]).join(",")}] (${events.ms}ms, ${events.bytes}B)`,
    );

    const links = await call("unw_dashboard", { op: "quick_links" });
    console.log(
      `dashboard.quick_links: ok=${!links.isError} cards=${links.data.count ?? 0} ` +
        `links=${(links.data.items ?? []).reduce((sum, card) => sum + (card.links?.length ?? 0), 0)} ` +
        `(${links.ms}ms, ${links.bytes}B)`,
    );

    const day = await call("unw_dashboard", { op: "day" });
    console.log(
      `dashboard.day: ok=${!day.isError} date=${day.data.date} classes=${day.data.classes?.length ?? 0} ` +
        `events=${day.data.events?.length ?? 0} tasks=${day.data.tasks?.length ?? 0}/${day.data.tasks_pending ?? 0} ` +
        `notices=${day.data.announcements?.length ?? 0} ` +
        `dup_flagged=${(day.data.events ?? []).filter((event) => event.duplicate_count).length} ` +
        `next_meal=${day.data.next_meal ? `${day.data.next_meal.meal} ${day.data.next_meal.start}-${day.data.next_meal.end}` : "none"} ` +
        `(${day.ms}ms, ${day.bytes}B)`,
    );

    // ---- phase 2: academics ----
    const academicProfile = await call("unw_academics", { op: "profile" });
    console.log(
      `academics.profile: ok=${!academicProfile.isError} fields=[${keys(academicProfile.data).join(",")}] ` +
        `gpa=${academicProfile.data.gpa ?? "n/a"} programs=${academicProfile.data.programs?.length ?? 0} ` +
        `advisors=${academicProfile.data.advisors?.length ?? 0} (${academicProfile.ms}ms, ${academicProfile.bytes}B)`,
    );

    const today = await call("unw_academics", { op: "today" });
    console.log(
      `academics.today: ok=${!today.isError} date=${today.data.date} day=${today.data.day} ` +
        `term=${today.data.term?.code} classes=${today.data.count ?? 0} ` +
        `times=[${(today.data.classes ?? []).map((row) => `${row.start}-${row.end}`).join(",")}] ` +
        `(${today.ms}ms, ${today.bytes}B)`,
    );

    const schedule = await call("unw_academics", { op: "schedule" });
    console.log(
      `academics.schedule: ok=${!schedule.isError} term=${schedule.data.term?.code} ` +
        `courses=${schedule.data.count ?? 0} credits=${schedule.data.total_credits ?? "n/a"} ` +
        `meetings=${(schedule.data.courses ?? []).reduce((sum, course) => sum + (course.meetings?.length ?? 0), 0)} ` +
        `(${schedule.ms}ms, ${schedule.bytes}B)`,
    );

    const grades = await call("unw_academics", { op: "grades" });
    console.log(
      `academics.grades: ok=${!grades.isError} terms=${grades.data.terms?.length ?? 0} ` +
        `courses=${grades.data.count ?? 0} latest=${grades.data.latest_term?.code ?? "n/a"} ` +
        `(${grades.ms}ms, ${grades.bytes}B)`,
    );

    const gpa = await call("unw_academics", { op: "gpa" });
    console.log(
      `academics.gpa: ok=${!gpa.isError} overall_gpa=${gpa.data.overall_gpa ?? "n/a"} ` +
        `overall_hours=${gpa.data.overall_hours ?? "n/a"} rows=${gpa.data.rows?.length ?? 0} ` +
        `(${gpa.ms}ms, ${gpa.bytes}B)`,
    );

    const holds = await call("unw_academics", { op: "holds" });
    console.log(
      `academics.holds: ok=${!holds.isError} count=${holds.data.count ?? 0} ` +
        `rows=${holds.data.rows?.length ?? 0} hidden=${holds.data.has_hidden ?? false} ` +
        `(${holds.ms}ms, ${holds.bytes}B)`,
    );

    const registration = await call("unw_academics", { op: "registration" });
    console.log(
      `academics.registration: ok=${!registration.isError} allows=${registration.data.allows_registration ?? "n/a"} ` +
        `status=${registration.data.status ?? "n/a"} standing=${registration.data.standing ? "present" : "n/a"} ` +
        `time_ticket_source=${registration.data.time_ticket_source} (${registration.ms}ms, ${registration.bytes}B)`,
    );

    const audit = await call("unw_academics", { op: "degree_audit" });
    console.log(
      `academics.degree_audit: ok=${!audit.isError} degrees=${audit.data.count ?? 0} ` +
        `percents=[${(audit.data.degrees ?? []).map((degree) => degree.percent).join(",")}] ` +
        `requirements=${(audit.data.degrees ?? []).reduce((sum, degree) => sum + (degree.requirements_total ?? 0), 0)} ` +
        `requirements_available=${(audit.data.degrees ?? []).filter((degree) => degree.requirements_available).length}/${audit.data.count ?? 0} ` +
        `(${audit.ms}ms, ${audit.bytes}B)`,
    );

    // ---- phase 2: finances ----
    const balances = await call("unw_finances", { op: "balances" });
    console.log(
      `finances.balances: ok=${!balances.isError} accounts=${balances.data.count ?? 0} ` +
        `names=[${(balances.data.accounts ?? []).map((row) => row.name).join(",")}] ` +
        `amounts_present=${(balances.data.accounts ?? []).filter((row) => row.amount !== undefined).length} ` +
        `(${balances.ms}ms, ${balances.bytes}B)`,
    );

    const chapel = await call("unw_finances", { op: "chapel" });
    console.log(
      `finances.chapel: ok=${!chapel.isError} earned=${chapel.data.credits_earned ?? "n/a"} ` +
        `required=${chapel.data.credits_required ?? "n/a"} remaining=${chapel.data.remaining ?? "n/a"} ` +
        `percent=${chapel.data.percent ?? "n/a"} period=${chapel.data.period ?? "n/a"} ` +
        `(${chapel.ms}ms, ${chapel.bytes}B)`,
    );

    const aid = await call("unw_finances", { op: "financial_aid" });
    console.log(
      `finances.financial_aid: ok=${!aid.isError} status=${aid.data.status} ` +
        `year=${aid.data.aid_year?.code ?? "n/a"} awards=${aid.data.award_count ?? 0} ` +
        `award_rows=${aid.data.awards?.length ?? 0} cost_rows=${aid.data.cost?.length ?? 0} ` +
        `totals=[${Object.values(aid.data.totals_by_period ?? {}).join(",")}] ` +
        `cost_total=${aid.data.cost_total ?? "n/a"} (${aid.ms}ms, ${aid.bytes}B)`,
    );

    // ---- phase 3: dining ----
    const diningLocations = await call("unw_dining", { op: "locations" });
    console.log(
      `dining.locations: ok=${!diningLocations.isError} cafes=${diningLocations.data.count ?? 0} ` +
        `(${diningLocations.ms}ms, ${diningLocations.bytes}B)`,
    );

    const diningToday = await call("unw_dining", { op: "today" });
    const todayParts = (diningToday.data.cafes ?? []).flatMap((cafe) => cafe.dayparts ?? []);
    console.log(
      `dining.today(brief): ok=${!diningToday.isError} date=${diningToday.data.date} detail=${diningToday.data.detail} ` +
        `status=${diningToday.data.status} cafes=${diningToday.data.cafes?.length ?? 0} dayparts=${todayParts.length} ` +
        `stations=${todayParts.reduce((sum, part) => sum + (part.stations?.length ?? 0), 0)} ` +
        `items=${todayParts.reduce((sum, part) => sum + (part.stations ?? []).reduce((n, st) => n + (st.items?.length ?? 0), 0), 0)} ` +
        `(${diningToday.ms}ms, ${diningToday.bytes}B)`,
    );
    const diningFull = await call("unw_dining", { op: "today", detail: "full" });
    const fullParts = (diningFull.data.cafes ?? []).flatMap((cafe) => cafe.dayparts ?? []);
    console.log(
      `dining.today(full): ok=${!diningFull.isError} detail=${diningFull.data.detail} ` +
        `stations=${fullParts.reduce((sum, part) => sum + (part.stations?.length ?? 0), 0)} ` +
        `items=${fullParts.reduce((sum, part) => sum + (part.stations ?? []).reduce((n, st) => n + (st.items?.length ?? 0), 0), 0)} ` +
        `(${diningFull.ms}ms, ${diningFull.bytes}B)`,
    );
    const diningLunch = await call("unw_dining", { op: "today", cafe: "Dining Center", meal: "lunch" });
    console.log(
      `dining.today(lunch): ok=${!diningLunch.isError} status=${diningLunch.data.status} ` +
        `cafes=${diningLunch.data.cafes?.length ?? 0} (${diningLunch.ms}ms, ${diningLunch.bytes}B)`,
    );

    const diningWeek = await call("unw_dining", { op: "week" });
    console.log(
      `dining.week: ok=${!diningWeek.isError} ${diningWeek.data.from}..${diningWeek.data.to} ` +
        `days=${diningWeek.data.count ?? 0} (${diningWeek.ms}ms, ${diningWeek.bytes}B)`,
    );

    // ---- phase 3: calendar ----
    const academicDates = await call("unw_calendar", { op: "academic", days: 365, limit: 10 });
    console.log(
      `calendar.academic: ok=${!academicDates.isError} count=${academicDates.data.count ?? 0} ` +
        `dates=[${(academicDates.data.items ?? []).map((row) => row.date).join(",")}] ` +
        `(${academicDates.ms}ms, ${academicDates.bytes}B)`,
    );

    const breaks = await call("unw_calendar", { op: "breaks", days: 365, limit: 10 });
    console.log(
      `calendar.breaks: ok=${!breaks.isError} count=${breaks.data.count ?? 0} ` +
        `items=[${(breaks.data.items ?? []).map((row) => `${row.date} ${row.summary}`).join(" | ")}] ` +
        `(${breaks.ms}ms, ${breaks.bytes}B)`,
    );
    const thanksgiving = await call("unw_calendar", {
      op: "breaks",
      days: 365,
      limit: 10,
      query: "thanksgiving",
    });
    console.log(
      `calendar.breaks(query=thanksgiving): ok=${!thanksgiving.isError} count=${thanksgiving.data.count ?? 0} ` +
        `(${thanksgiving.ms}ms, ${thanksgiving.bytes}B)`,
    );

    const deadlines = await call("unw_calendar", { op: "deadlines", days: 365, limit: 10 });
    console.log(
      `calendar.deadlines: ok=${!deadlines.isError} count=${deadlines.data.count ?? 0} ` +
        `items=[${(deadlines.data.items ?? []).map((row) => `${row.date} ${row.summary}`).join(" | ")}] ` +
        `(${deadlines.ms}ms, ${deadlines.bytes}B)`,
    );

    const campusEvents = await call("unw_calendar", { op: "events", days: 7, limit: 10 });
    console.log(
      `calendar.events: ok=${!campusEvents.isError} window=${campusEvents.data.window?.from}..${campusEvents.data.window?.to} ` +
        `count=${campusEvents.data.count ?? 0} rows=${campusEvents.data.items?.length ?? 0} ` +
        `(${campusEvents.ms}ms, ${campusEvents.bytes}B)`,
    );

    // ---- phase 3: pages ----
    const search = await call("unw_pages", { op: "search", query: "registration", limit: 10 });
    console.log(
      `pages.search: ok=${!search.isError} count=${search.data.count ?? 0} rows=${search.data.items?.length ?? 0} ` +
        `truncated=${search.data.truncated ?? false} ` +
        `slugs=[${(search.data.items ?? []).map((row) => row.slug).filter(Boolean).join(",")}] ` +
        `(${search.ms}ms, ${search.bytes}B)`,
    );

    const page = await call("unw_pages", { op: "get", slug: "meal-plan-information" });
    console.log(
      `pages.get: ok=${!page.isError} status=${page.data.status} body_chars=${page.data.body_chars ?? 0} ` +
        `truncated=${page.data.body_truncated ?? false} (${page.ms}ms, ${page.bytes}B)`,
    );
  }
} finally {
  await client.close();
}
