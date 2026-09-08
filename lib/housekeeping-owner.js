// Housekeeping as the OWNER sees it. The same records the Records page
// shows Era, scoped to the villas one owner holds and stripped of staff
// identity: the owner is buying the outcome, not supervising the cleaner.
//
//   ownerRecords(db, { slugs })      the log (cleans, handover checks,
//                                    inspections) plus what is planned next
//   ownerHousekeepingContext(db, …)  the same, as text for Maya's owner mode
//
// A "clean" entry is a cleaning visit the housekeeper marked done that has
// no photo record of its own (a regular clean). A "handover" entry is a
// pre-guest check with photos; an "inspection" is the fortnightly round.

import { catalogNames, fetchStays, projectRounds, roundAnchors } from './housekeeping.js';
import { JOB, OWNER_OUTCOME, OWNER_CHECK, ROUND, OWNER_EVIDENCE } from './glossary.js';
import { getSettingValue } from './campaigns.js';

const sbGet = async (db, path) => {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
};
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const witaDay = (iso) => iso ? new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export const KIND_LABEL = Object.fromEntries(Object.entries(JOB).map(([k, v]) => [k, v.owner]));
const OWNER_VISIT = { done: 'done', skipped: 'removed from the schedule', not_done: 'not done', unconfirmed: 'scheduled, not confirmed by the housekeeper', not_sent: 'not covered', uncovered: 'not covered (no housekeeper reachable)', open: 'today, in progress' };
export const STATUS_LABEL = { ...OWNER_OUTCOME, ...OWNER_CHECK, ...ROUND };

// The managed villas behind one owner: the active statement groups on their
// WhatsApp number or on any slug their portal account holds, plus those
// slugs themselves. Same matching rule as ownerStatementsContext.
export async function ownerManagedSlugs(db, { waNum, slugs = [] } = {}) {
  const wa = String(waNum || '').replace(/\D/g, '');
  const mine = new Set(cleanSlugs(slugs));
  const groups = (await sbGet(db, 'statement_groups?select=key,listing_slugs,owner_wa_nums&active=is.true')) || [];
  for (const g of groups) {
    const hit = (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa))
      || (g.listing_slugs || []).some(x => mine.has(x));
    if (hit) for (const x of (g.listing_slugs || [])) mine.add(x);
  }
  return [...mine];
}

export function cleanSlugs(slugs) {
  return [...new Set((Array.isArray(slugs) ? slugs : []).map(s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean))];
}

export async function ownerRecords(db, { slugs = [], from, to, limit = 1500 } = {}) {
  const list = cleanSlugs(slugs);
  const t = today();
  from = isDay(from) ? from : plus(t, -90);
  to = isDay(to) ? to : t;
  if (!list.length) return { from, to, names: {}, records: [], upcoming: [] };
  const { buildRecords } = await import('./housekeeping-records.js');
  const [built, upcoming, feed] = await Promise.all([
    buildRecords(db, { from, to, slugs: list, limit, audience: 'owner' }),
    upcomingRounds(db, list).catch(() => []),
    fetchStays({ from: plus(from, -60), to: plus(to, 30) }).catch(() => null),
  ]);
  // The stays, so the log can be read by guest: the visits between one
  // departure and the next arrival are the ones a damage claim turns on.
  const stays = {};
  for (const u of (feed?.units || [])) if (list.includes(u.slug)) stays[u.slug] = (u.stays || []).filter(s => s.status !== 'cancelled').map(s => ({ check_in: s.check_in, check_out: s.check_out, nights: s.nights, guest: s.guest ? String(s.guest).split(' ')[0] : null, channel: s.channel || null }));
  return { from, to, names: built.names, records: built.records, upcoming, stays };
}

// What is planned next for each villa: the next cleaning visit on the
// schedule, and the next inspection round and deep clean (a real task when
// one is already on the calendar, otherwise the projected date).
async function upcomingRounds(db, list) {
  const t = today();
  const months = 4;
  const end = plus(t, Math.round(months * 30.4));
  const [feed, anchors, cfg, tasks] = await Promise.all([
    fetchStays({ from: plus(t, -7), to: end }),
    roundAnchors(db),
    getSettingValue(db, 'housekeeping'),
    sbGet(db, `housekeeping_tasks?slug=in.(${list.map(encodeURIComponent).join(',')})&task_date=gte.${t}&task_date=lte.${end}&status=not.in.(skipped,done)`
      + `&select=id,slug,task_date,kind&order=task_date.asc&limit=500`),
  ]);
  const units = (feed?.units || []).filter(u => list.includes(u.slug));
  const rounds = projectRounds({ units, today: t, cfg: cfg || {}, months, ...anchors });
  const horizonMax = tasks.reduce((m, x) => x.task_date > m ? x.task_date : m, t);
  const out = [];
  for (const slug of list) {
    const mine = tasks.filter(x => x.slug === slug);
    const proj = rounds.filter(r => r.slug === slug && r.date > horizonMax);
    const first = (kind) => mine.find(x => x.kind === kind)?.task_date || proj.find(r => r.kind === kind)?.date || null;
    out.push({
      slug,
      next_clean: mine.find(x => ['regular', 'turnover', 'pre_arrival', 'deep_clean'].includes(x.kind))?.task_date || null,
      next_inspection: first('inspection'),
      next_deep_clean: first('deep_clean'),
    });
  }
  return out;
}

// ── For Maya ────────────────────────────────────────────────────────
// Compact and factual; she restates it, she does not embellish it.
export async function ownerHousekeepingContext(db, { slugs = [] } = {}) {
  const data = await ownerRecords(db, { slugs, from: plus(today(), -60) });
  if (!Object.keys(data.names).length) return { text: '(no managed villas on file for this owner)', data };
  const lines = [`Housekeeping for this owner's villas, last 60 days, today ${today()} (Bali). Every scheduled visit is listed, done or not; "not confirmed" means the housekeeper never answered, "not covered" means nobody could be sent. The owner can see all of this, with the photos and the guest before and after each visit, under the Care log tab of their portal at https://sambarentals.com/portal and download any visit as a PDF there.`];
  for (const [slug, name] of Object.entries(data.names)) {
    const recs = data.records.filter(r => r.slug === slug);
    const up = data.upcoming.find(u => u.slug === slug) || {};
    lines.push(`\n${name} (${slug})`);
    lines.push(`  Planned next: clean ${up.next_clean || '—'}, inspection ${up.next_inspection || '—'}, deep clean ${up.next_deep_clean || '—'}`);
    if (!recs.length) { lines.push('  No records in the window.'); continue; }
    for (const r of recs.slice(0, 12)) {
      let s = `  ${r.date} ${KIND_LABEL[r.kind] || r.kind}`;
      if (r.type === 'handover') {
        s += ` — photo check: ${STATUS_LABEL[r.status] || r.status}${r.photo_count ? ` (${r.photo_count} photos)` : ''}`;
        if (r.flagged?.length) s += `; flagged then fixed: ${r.flagged.map(f => `${f.spot}${f.note ? ` (${f.note})` : ''}`).join(', ')}`;
        if (r.restock) s += `; running low: ${r.restock}`;
        if (r.guest_in_date) s += `; guest arrived ${r.guest_in_date}`;
      } else if (r.type === 'inspection') {
        s += ` — ${r.status === 'raised' ? `${r.repairs} repair${r.repairs > 1 ? 's' : ''} raised` : 'nothing found'}${r.findings ? `: ${String(r.findings).slice(0, 120)}` : ''}`;
      } else {
        s += ` — ${OWNER_VISIT[r.status] || r.status}${r.status === 'done' && r.evidence ? `, ${OWNER_EVIDENCE[r.evidence]}` : ''}${r.photo_count ? ` (${r.photo_count} photos)` : ''}`;
        if ((r.jobs || []).length > 1) s += `; jobs: ${r.jobs.map(j => `${KIND_LABEL[j.kind] || j.kind} ${OWNER_VISIT[j.status] || j.status}`).join(', ')}`;
      }
      lines.push(s);
    }
    if (recs.length > 12) lines.push(`  …and ${recs.length - 12} more in the portal.`);
  }
  return { text: lines.join('\n').slice(0, 6000), data };
}
