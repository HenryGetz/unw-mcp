#!/usr/bin/env node
/**
 * Public academic-calendar proof — no login.
 *
 *   node scripts/recon/calendar.mjs                 # next 20 key dates
 *   node scripts/recon/calendar.mjs --next=40
 *   node scripts/recon/calendar.mjs --json
 *   node scripts/recon/calendar.mjs --all           # include every event
 *
 * The university's academic-calendar page embeds three public Google
 * Calendars. Their public ICS feeds carry semester dates, breaks, finals and
 * registration deadlines, so the MCP does not need a portal session for this.
 */
const PAGE = 'https://www.unwsp.edu/academics/academic-calendar/';
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const AS_JSON = args.has('json');
const SHOW_ALL = args.has('all');
const NEXT = Number(args.get('next') ?? 25);

const KEY = /(break|recess|final|deadline|registration|semester|commencement|classes|exam|holiday|no classes|advising|withdraw)/i;

function parseIcs(text) {
  const events = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const get = (name) => {
      const m = body.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    const dt = get('DTSTART');
    if (!dt) continue;
    const date = dt.length >= 8 ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : dt;
    events.push({ date, summary: get('SUMMARY') ?? '', description: get('DESCRIPTION') ?? '', location: get('LOCATION') ?? '' });
  }
  return events;
}

async function main() {
  const started = Date.now();
  const pageRes = await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (unw-mcp recon)' } });
  if (!pageRes.ok) throw new Error(`calendar page ${pageRes.status}`);
  const html = (await pageRes.text()).replace(/&#0?38;/g, '&').replace(/&amp;/g, '&');
  const embed = html.match(/https:\/\/www\.google\.com\/calendar\/embed\?[^"']+/)?.[0];
  if (!embed) throw new Error('no Google Calendar embed found');

  const ids = [...new Set([...embed.matchAll(/src=([^&"']+%40group\.calendar\.google\.com)/g)].map((m) => decodeURIComponent(m[1])))];
  const feeds = [];
  const events = [];
  for (const id of ids) {
    const url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (unw-mcp recon)' } });
    if (!res.ok) { feeds.push({ id, status: res.status, events: 0 }); continue; }
    const parsed = parseIcs(await res.text());
    feeds.push({ id, url, status: res.status, events: parsed.length });
    for (const e of parsed) events.push({ ...e, feed: id });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => e.date >= today);
  const selected = (SHOW_ALL ? upcoming : upcoming.filter((e) => KEY.test(e.summary))).slice(0, NEXT);

  const summary = {
    source: PAGE,
    feeds: feeds.map((f) => ({ id: f.id.slice(0, 10) + '…', status: f.status, events: f.events })),
    eventCount: events.length,
    fetchedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    next: selected.map((e) => ({ date: e.date, summary: e.summary, location: e.location || undefined })),
  };

  if (AS_JSON) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`academic calendar: ${feeds.length} public Google feeds, ${events.length} events, ${summary.latencyMs}ms`);
  for (const e of selected) console.log(`  ${e.date}  ${e.summary}`);
}

main().catch((e) => { console.error(`[calendar] FAILED: ${e.message}`); process.exit(1); });
