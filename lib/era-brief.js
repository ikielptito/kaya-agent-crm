// Era's day, every morning, and the changes to it as they happen.
//
// At 07:05 WITA Maya sends Era four lines and one button: guest movements,
// the cleaning by housekeeper, what is waiting on her, yesterday's loose
// ends. The button opens a signed, phone-first page on the portal with the
// whole day laid out (guests by villa, cleans by person, rounds, tukang
// visits, the backlog with tappable tickets) and the week ahead below it.
// The 09:00 backlog nudge folds into this; 12:00, 15:00 and 18:00 stay.
//
// After that, the hourly beat compares today's and tomorrow's tasks and
// stays with the snapshot taken at brief time and sends one line per
// change — a new same-day turnover, a cancelled arrival, a visit that
// moved — never the whole brief again.
//
// Data comes from the same functions the Schedule page uses, so the page
// and the message can never disagree with the cockpit.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { catalogNames, fetchStays } from './housekeeping.js';
import { readinessForWindow } from './housekeeping-readiness.js';
import { eraBacklog } from './maintenance-backlog.js';
import { openRelaysForContact } from './relay.js';
import { listGroups } from './statements.js';
import { sendText, sendCtaUrl } from './wa-interactive.js';
import { todaySig } from './tokens.js';

const STATE_KEY = 'era_brief';
const PORTAL = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';
const ERA = () => String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
const witaNow = (now = new Date()) => new Date(now.getTime() + 8 * 3600e3);
const dayOf = (now) => witaNow(now).toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const dl = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('Sept', 'Sep');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || null;
const KIND = { turnover: 'turnover clean', regular: 'routine clean', pre_arrival: 'arrival prep', deep_clean: 'deep clean', inspection: 'inspection' };
const PHOTO_KINDS = new Set(['pre_arrival', 'deep_clean']);

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}

// ── The day, as data ────────────────────────────────────────────────
export async function buildBrief(db, { date = null, now = new Date() } = {}) {
  const today = date || dayOf(now);
  const yesterday = plus(today, -1), tomorrow = plus(today, 1), weekEnd = plus(today, 7);
  const names = await catalogNames(db).catch(() => ({}));
  const villa = (slug) => names[slug] || slug;

  const [feed, tasks, backlog, relays, viewings, readiness, tukang] = await Promise.all([
    fetchStays({ from: yesterday, to: weekEnd }).catch(() => null),
    sbGet(db, `housekeeping_tasks?task_date=gte.${yesterday}&task_date=lte.${weekEnd}&status=neq.skipped&select=id,slug,kind,task_date,status,same_day,guest_in_date,done_at,notes,moved_by,staff:assigned_staff_id(id,name)&order=task_date.asc,slug.asc&limit=400`),
    eraBacklog(db, {}).catch(() => []),
    openRelaysForContact(db, ERA()).catch(() => []),
    sbGet(db, `viewings?status=in.(requested,confirmed)&scheduled_at=gte.${today}T00:00:00&scheduled_at=lte.${today}T23:59:59&select=id,property_name,agent_name,scheduled_at,status&limit=20`),
    readinessForWindow(db, { from: yesterday, to: yesterday }).catch(() => []),
    sbGet(db, `maintenance_items?status=in.(approved,scheduled)&visit_at=gte.${today}T00:00:00&visit_at=lte.${today}T23:59:59&select=id,title,slug,group_key,visit_at,visit_status,staff:assigned_staff_id(name),statement_groups(name)&limit=20`),
  ]);

  const units = feed?.units || [];
  const stayLine = (u, s) => ({ villa: u.name || villa(u.slug), slug: u.slug, guest: s.guest || null, channel: s.channel || null, nights: s.nights, check_in: s.check_in, check_out: s.check_out, same_day: !!s.same_day_turnover });
  const guests = { departures: [], arrivals: [], tomorrow_arrivals: [], in_house: [], unavailable: !feed?.units };
  for (const u of units) for (const s of (u.stays || [])) {
    if (s.check_out === today) guests.departures.push(stayLine(u, s));
    if (s.check_in === today) guests.arrivals.push(stayLine(u, s));
    if (s.check_in === tomorrow) guests.tomorrow_arrivals.push(stayLine(u, s));
    if (s.check_in < today && s.check_out > today) guests.in_house.push(stayLine(u, s));
  }

  const todays = tasks.filter(t => t.task_date === today);
  const byPerson = new Map();
  for (const t of todays) {
    const who = t.staff?.name || 'Unassigned';
    if (!byPerson.has(who)) byPerson.set(who, []);
    byPerson.get(who).push({ task_id: t.id, villa: villa(t.slug), slug: t.slug, kind: t.kind, label: KIND[t.kind] || t.kind, status: t.status, same_day: !!t.same_day, photo_check: PHOTO_KINDS.has(t.kind) || (t.kind === 'turnover' && !!t.guest_in_date), guest_in: t.guest_in_date || null, notes: t.notes || null });
  }
  const cleaning = [...byPerson.entries()].map(([who, visits]) => ({ who, visits })).sort((a, b) => (a.who === 'Unassigned') - (b.who === 'Unassigned') || a.who.localeCompare(b.who));
  const rounds = todays.filter(t => t.kind === 'inspection' || t.kind === 'deep_clean').map(t => ({ villa: villa(t.slug), kind: KIND[t.kind], who: t.staff?.name || null }));

  const loose = {
    not_done: tasks.filter(t => t.task_date === yesterday && ['notified', 'confirmed', 'planned'].includes(t.status)).map(t => ({ villa: villa(t.slug), kind: KIND[t.kind] || t.kind, who: t.staff?.name || null, task_id: t.id })),
    readiness: (readiness || []).filter(r => ['flagged', 'unchecked', 'unverified'].includes(r.status)).map(r => ({ villa: villa(r.slug), status: r.status, flags: r.flags || [] })),
  };

  // The week ahead: movements per day, rounds, and the money items.
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = plus(today, i);
    const arrivals = [], departures = [];
    for (const u of units) for (const s of (u.stays || [])) { if (s.check_in === d) arrivals.push(stayLine(u, s)); if (s.check_out === d) departures.push(stayLine(u, s)); }
    const r = tasks.filter(t => t.task_date === d && (t.kind === 'inspection' || t.kind === 'deep_clean')).map(t => ({ villa: villa(t.slug), kind: KIND[t.kind], who: t.staff?.name || null }));
    const cleans = tasks.filter(t => t.task_date === d && !(t.kind === 'inspection' || t.kind === 'deep_clean')).length;
    days.push({ date: d, label: dl(d), arrivals, departures, rounds: r, cleans });
  }
  const prevPeriod = plus(today.slice(0, 7) + '-01', -1).slice(0, 7);
  const groups = (await listGroups(db, { activeOnly: true }).catch(() => [])) || [];
  const prevStatements = await sbGet(db, `statements?period=eq.${prevPeriod}&select=group_key,status`);
  const statements_unpublished = groups.filter(g => g.expenses_only !== true).map(g => ({ group: g.name, key: g.key, period: prevPeriod, status: prevStatements.find(s => s.group_key === g.key)?.status || 'not yet imported' })).filter(x => !['published', 'partial', 'paid'].includes(x.status));

  return {
    date: today, label: dl(today), monday: new Date(today + 'T00:00:00Z').getUTCDay() === 1,
    guests, cleaning, rounds,
    tukang: (tukang || []).map(t => ({ ticket: t.id, villa: t.statement_groups?.name || villa(t.slug || t.group_key), title: t.title, who: t.staff?.name || null, at: t.visit_at, confirmed: t.visit_status === 'confirmed' })),
    backlog: backlog || [],
    relays: (relays || []).map(r => ({ id: r.id, villa: r.property_name || r.slug, question: r.question })),
    viewings: (viewings || []).map(v => ({ villa: v.property_name, agent: v.agent_name, at: v.scheduled_at, status: v.status })),
    loose,
    week: { days, statements_unpublished, prev_period: prevPeriod },
    generated_at: nowIso(),
  };
}

// ── The four lines ──────────────────────────────────────────────────
export function briefHeadline(b) {
  const lines = [];
  const g = b.guests;
  const mv = [];
  if (g.unavailable) mv.push('booking calendar unavailable');
  else {
    const sameDay = g.arrivals.filter(a => a.same_day);
    for (const a of sameDay) mv.push(`${a.villa}: ${first(g.departures.find(d => d.slug === a.slug)?.guest) || 'guest'} leaves, ${first(a.guest) || 'guest'} arrives (same-day)`);
    const otherArr = g.arrivals.filter(a => !a.same_day), otherDep = g.departures.filter(d => !sameDay.some(a => a.slug === d.slug));
    if (otherArr.length) mv.push(`arriving: ${otherArr.map(a => `${a.villa} (${first(a.guest) || a.channel || 'guest'})`).join(', ')}`);
    if (otherDep.length) mv.push(`leaving: ${otherDep.map(d => `${d.villa} (${first(d.guest) || 'guest'})`).join(', ')}`);
    if (!mv.length) mv.push('no guest movements');
    if (g.tomorrow_arrivals.length) mv.push(`tomorrow: ${g.tomorrow_arrivals.map(a => a.villa).join(', ')} arriving`);
  }
  lines.push(`${b.label} — ${mv.join('. ')}.`);
  const visits = b.cleaning.reduce((n, p) => n + p.visits.filter(v => v.kind !== 'inspection' && v.kind !== 'deep_clean').length, 0);
  const cleansOf = (p) => p.visits.filter(v => v.kind !== 'inspection' && v.kind !== 'deep_clean').length;
  const per = b.cleaning.filter(p => p.who !== 'Unassigned' && cleansOf(p)).map(p => `${first(p.who)} ${cleansOf(p)}`).join(', ');
  const un = b.cleaning.find(p => p.who === 'Unassigned');
  lines.push(visits || b.rounds.length
    ? `${visits} clean${visits === 1 ? '' : 's'}${per ? ` (${per})` : ''}${b.rounds.length ? `, ${b.rounds.length} ${b.rounds.length === 1 ? 'round' : 'rounds'}` : ''}${un ? ` — ${un.visits.length} unassigned` : ''}${b.tukang.length ? `; ${b.tukang.length} tukang visit${b.tukang.length > 1 ? 's' : ''}` : ''}.`
    : `No cleans today${b.tukang.length ? `; ${b.tukang.length} tukang visit${b.tukang.length > 1 ? 's' : ''}` : ''}.`);
  const wait = [];
  if (b.backlog.length) { const oldest = Math.max(...b.backlog.map(x => x.age_days || 0)); wait.push(`${b.backlog.length} ticket${b.backlog.length > 1 ? 's' : ''} waiting on you${oldest ? `, oldest ${oldest} day${oldest > 1 ? 's' : ''}` : ''}`); }
  if (b.relays.length) wait.push(`${b.relays.length} agent question${b.relays.length > 1 ? 's' : ''} open`);
  if (b.viewings.length) wait.push(`${b.viewings.length} viewing${b.viewings.length > 1 ? 's' : ''} today`);
  if (b.monday && b.week.statements_unpublished.length) wait.push(`${b.week.statements_unpublished.length} statement${b.week.statements_unpublished.length > 1 ? 's' : ''} for ${b.week.prev_period} not yet published`);
  lines.push(wait.length ? `${wait.join('; ')}.` : 'Nothing waiting on you.');
  const le = [];
  if (b.loose.not_done.length) { const nd = b.loose.not_done; le.push(`${nd.slice(0, 3).map(x => `${x.villa} ${x.kind}${x.who ? ` (${first(x.who)})` : ''}`).join(', ')}${nd.length > 3 ? ` +${nd.length - 3} more` : ''} not marked done`); }
  if (b.loose.readiness.length) le.push(`${b.loose.readiness.map(x => `${x.villa} photo check ${x.status === 'unchecked' ? 'missing' : x.status === 'unverified' ? 'not checked (look at the photos)' : 'flagged'}`).join(', ')}`);
  if (le.length) lines.push(`Yesterday: ${le.join('; ')}.`);
  return lines.join('\n');
}

// ── Snapshot and diff, pure ─────────────────────────────────────────
export function snapshotOf(b, tasks) {
  const snap = { tasks: {}, arrivals: [], departures: [] };
  for (const t of tasks) {
    if (!(t.task_date === b.date || t.task_date === plus(b.date, 1))) continue;
    // A visit skipped by a rule (off the villa's cleaning days) was never a
    // visit; it is left out so it is not reported as "gone".
    if (t.status === 'skipped' && /cleaning days|hari biasa|Off the villa|Duplicate of|said today is/i.test(String(t.notes || ''))) continue;
    if (t.status === 'skipped') { snap.tasks[t.id] = { date: t.task_date, slug: t.slug, kind: t.kind, who: t.staff?.name || null, skipped: true }; continue; }
    snap.tasks[t.id] = { date: t.task_date, slug: t.slug, kind: t.kind, who: t.staff?.name || null };
  }
  for (const a of [...b.guests.arrivals, ...b.guests.tomorrow_arrivals]) snap.arrivals.push(`${a.slug}|${a.check_in}|${a.guest || ''}`);
  for (const d of b.guests.departures) snap.departures.push(`${d.slug}|${d.check_out}|${d.guest || ''}`);
  return snap;
}
export function diffSnapshot(prev, cur, villa = (s) => s) {
  const lines = [];
  for (const [id, t] of Object.entries(cur.tasks)) {
    const p = prev.tasks[id];
    if (t.skipped) { if (p && !p.skipped) lines.push(`Skipped: ${KIND[t.kind] || t.kind} at ${villa(t.slug)} ${dl(t.date)}.`); continue; }
    if (p?.skipped) { lines.push(`Back on: ${KIND[t.kind] || t.kind} at ${villa(t.slug)} ${dl(t.date)}.`); continue; }
    if (!p) lines.push(`New: ${KIND[t.kind] || t.kind} at ${villa(t.slug)} ${t.date === cur.today ? 'today' : 'tomorrow'}${t.who ? ` (${first(t.who)})` : ''}.`);
    else if (p.date !== t.date || p.who !== t.who) lines.push(`Moved: ${KIND[t.kind] || t.kind} at ${villa(t.slug)} → ${dl(t.date)}${t.who && t.who !== p.who ? `, now ${first(t.who)}` : ''}.`);
  }
  for (const [id, p] of Object.entries(prev.tasks)) if (!cur.tasks[id]) lines.push(`Gone: ${KIND[p.kind] || p.kind} at ${villa(p.slug)} ${dl(p.date)} was removed from the schedule.`);
  for (const a of cur.arrivals) if (!prev.arrivals.includes(a)) { const [slug, d, g] = a.split('|'); lines.push(`New arrival ${d === cur.today ? 'today' : 'tomorrow'}: ${villa(slug)}${g ? ` (${first(g)})` : ''}.`); }
  for (const a of prev.arrivals) if (!cur.arrivals.includes(a)) { const [slug, d, g] = a.split('|'); lines.push(`Cancelled arrival ${dl(d)}: ${villa(slug)}${g ? ` (${first(g)})` : ''}.`); }
  return lines;
}

// ── The link ────────────────────────────────────────────────────────
// The page is signed with the shared secret; both repos derive the same
// signature, so no round trip to the portal is needed.
function todayUrl(date) {
  return `${PORTAL}/today/${todaySig()}?d=${date}`;
}

// ── The runner, hourly ──────────────────────────────────────────────
export async function runEraBrief({ db, wa, now = new Date(), preview = false, force = false } = {}) {
  const cfg = (await getSettingValue(db, STATE_KEY).catch(() => null)) || {};
  const enabled = process.env.ERA_BRIEF === 'on' || !!cfg.enabled;
  if (!enabled && !preview && !force) return { skipped: 'era_brief not enabled' };
  const today = dayOf(now);
  const hour = witaNow(now).getUTCHours();
  const briefHour = Number.isFinite(+cfg.hour) ? +cfg.hour : 7;
  const era = ERA();

  // The morning brief, once a day from briefHour.
  if (preview || force || (hour >= briefHour && cfg.day !== today)) {
    const b = await buildBrief(db, { date: today, now });
    const text = briefHeadline(b);
    const url = todayUrl(today);
    const tasks = await sbGet(db, `housekeeping_tasks?task_date=gte.${today}&task_date=lte.${plus(today, 1)}&status=neq.skipped&select=id,slug,kind,task_date,staff:assigned_staff_id(name)&limit=200`);
    const snapshot = { ...snapshotOf(b, tasks), today };
    if (preview) return { preview: true, date: today, text, url, brief: b };
    const mid = await sendCtaUrl(wa, era, text, { text: 'Open today', url });
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ wa_num: era, direction: 'outbound', content: `${text}\n[button: Open today → ${url}]`, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'cron', category: 'era_brief', status: mid ? 'sent' : 'failed' }) }).catch(() => {});
    await saveSettingValue(db, STATE_KEY, { ...cfg, enabled: cfg.enabled ?? enabled, day: today, sent_at: nowIso(), snapshot, changes: [] });
    return { sent: !!mid, date: today, text, url };
  }

  // After the brief: changes to today and tomorrow, batched at a few hours
  // of the day rather than every hour. Six one-line messages between 09:00
  // and 16:00 on 7 Sep 2026 were mostly the schedule reshuffling itself
  // around a housekeeper's day off; one digest at 12 and one at 17 says
  // the same with less noise. A same-day arrival still goes at once.
  const changeHours = Array.isArray(cfg.change_hours) ? cfg.change_hours.map(Number) : [12, 17];
  if (cfg.day === today && cfg.snapshot) {
    const names = await catalogNames(db).catch(() => ({}));
    const b = await buildBrief(db, { date: today, now });
    const tasks = await sbGet(db, `housekeeping_tasks?task_date=gte.${today}&task_date=lte.${plus(today, 1)}&select=id,slug,kind,task_date,status,notes,staff:assigned_staff_id(name)&limit=200`);
    const cur = { ...snapshotOf(b, tasks), today };
    if (b.guests.unavailable) cur.arrivals = cfg.snapshot.arrivals; // a feed outage is not a cancellation
    const lines = diffSnapshot(cfg.snapshot, cur, (s) => names[s] || s).filter(l => !(cfg.changes || []).includes(l));
    if (!lines.length) return { changes: 0 };
    const urgent = lines.some(l => /^(New arrival today|Cancelled arrival)/.test(l));
    if (!urgent && !changeHours.includes(hour) && !force) return { changes: 0, held: lines.length, until: changeHours.find(h => h > hour) ?? 'tomorrow' };
    const text = `Schedule change${lines.length > 1 ? 's' : ''}:\n${lines.map(l => `• ${l}`).join('\n')}`;
    const mid = await sendText(wa, era, text);
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ wa_num: era, direction: 'outbound', content: text, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'cron', category: 'era_brief', status: mid ? 'sent' : 'failed' }) }).catch(() => {});
    await saveSettingValue(db, STATE_KEY, { ...cfg, snapshot: cur, changes: [...(cfg.changes || []), ...lines].slice(-60) });
    return { changes: lines.length, lines };
  }
  return { skipped: `before ${briefHour}:00` };
}
