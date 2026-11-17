#!/usr/bin/env node
/**
 * Public dining menu proof — no login, no cookies.
 *
 *   node scripts/recon/dining.mjs                 # today, all cafes
 *   node scripts/recon/dining.mjs --date=2026-11-19
 *   node scripts/recon/dining.mjs --json
 *
 * Source: https://flow.my.unw.edu/upstream/v2/bonappetit (1.8 MB, 7 rolling days).
 * The Flow host serves this endpoint unauthenticated, so the MCP can cache it
 * without touching the student session.
 */
const URL = 'https://flow.my.unw.edu/upstream/v2/bonappetit';
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const AS_JSON = args.has('json');
const date = args.get('date') ?? new Date().toISOString().slice(0, 10);

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const started = Date.now();
  const res = await fetch(URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`dining fetch failed: ${res.status}`);
  const data = await res.json();
  const campus = Object.values(data.campuses ?? {})[0] ?? { cafes: {} };
  const day = data.data;

  const cafes = Object.entries(campus.cafes ?? {}).map(([id, cafe]) => {
    const days = day?.[id] ?? {};
    const dates = Object.keys(days);
    const chosen = days[date] ?? days[dates[0]];
    const itemDict = chosen?.items ?? {};
    const dayparts = (chosen?.days?.[0]?.cafes?.[id]?.dayparts?.[0] ?? []).map((part) => ({
      label: part.label,
      start: part.starttime,
      end: part.endtime,
      stations: (part.stations ?? []).map((st) => ({
        label: st.label,
        items: (st.items ?? []).map((itemId) => itemDict[itemId]?.label).filter(Boolean),
      })),
    }));
    return {
      id,
      name: stripHtml(cafe.name),
      hoursHtml: stripHtml(cafe.weekly_schedule).slice(0, 400),
      address: `${cafe.address}, ${cafe.city}, ${cafe.state} ${cafe.zip}`,
      dates,
      dayparts,
    };
  });

  const summary = {
    source: URL,
    fetchedAt: new Date().toISOString(),
    lastUpdated: new Date(data.lastUpdated).toISOString(),
    latencyMs: Date.now() - started,
    date,
    cafeCount: cafes.length,
    cafes,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`dining: ${cafes.length} cafes, ${summary.lastUpdated}, ${summary.latencyMs}ms, date=${date}`);
  for (const cafe of cafes) {
    console.log(`\n${cafe.name} — ${cafe.address}`);
    console.log(`  menus for: ${cafe.dates.join(', ') || '(none)'}`);
    console.log(`  hours: ${cafe.hoursHtml.slice(0, 180)}`);
    if (!cafe.dayparts.length) { console.log('  (no menu published for this date)'); continue; }
    for (const part of cafe.dayparts) {
      const items = part.stations.flatMap((s) => s.items).slice(0, 10);
      console.log(`  ${part.label} ${part.start}-${part.end}: ${items.join(', ')}`);
    }
  }
}

main().catch((e) => { console.error(`[dining] FAILED: ${e.message}`); process.exit(1); });
