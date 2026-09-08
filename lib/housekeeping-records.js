// The record of a villa: every visit, whatever came of it.
//
// Until 8 Sep 2026 the Records page showed only the visits that ended in a
// photo ritual — a handover check or an inspection round — so a villa with
// two cleans a week had two records a month, and a visit that was skipped,
// never confirmed or never even sent left no trace at all. Ikiel's ask: a
// paper trail that answers "what state was this unit in on that date",
// which means every visit is a record, including the ones that did not
// happen.
//
//   buildRecords(db, { from, to, slugs?, limit?, audience })
//
// One record per housekeeping_tasks row in the window (future-dated ones
// excluded), with the handover check or inspection round it produced
// folded in. The record's `type` and `id` keep the older addressing so the
// photo, export and PDF actions and the signed record links still work:
//
//   type 'handover'   id = housekeeping_readiness.id   (a pre-guest check)
//   type 'inspection' id = housekeeping_inspections.id (a fortnightly round)
//   type 'visit'      id = housekeeping_tasks.id       (everything else)
//
// Every record also carries task_id. Checks and rounds with no task behind
// them (older rows) appear on their own, as before.
//
// `status` is one vocabulary for the pill:
//   done | skipped | unconfirmed | not_sent | uncovered | open      (visits)
//   pass | flagged | unchecked | unverified | awaiting               (checks)
//   clear | raised                                                   (rounds)
//
// audience 'owner' strips staff names and the housekeeper's thread, and
// drops visits that a rule skipped (they were never visits).

import { catalogNames } from './housekeeping.js';

const sbGet = async (db, path) => {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
};
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const witaDay = (iso) => iso ? new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const RULE_SKIP = /cleaning days|hari biasa|Off the villa/i;

// Pure: the status of a visit from its row and the day it is viewed on.
export function visitStatus(task, on = today()) {
  if (task.status === 'done') return 'done';
  if (task.status === 'skipped') return 'skipped';
  if (task.task_date > on) return 'upcoming';
  if (task.task_date === on) return task.notified_at ? 'open' : (RULE_SKIP.test(task.notes || '') ? 'skipped' : /uncovered/i.test(task.notes || '') ? 'uncovered' : 'open');
  if (['notified', 'confirmed'].includes(task.status)) return 'unconfirmed';
  if (/uncovered/i.test(task.notes || '')) return 'uncovered';
  return 'not_sent';
}

export const STATUS_LABEL = {
  done: 'Done', skipped: 'Skipped', unconfirmed: 'Not confirmed', not_sent: 'Never sent', uncovered: 'Uncovered', open: 'Today, open', upcoming: 'Upcoming',
  pass: 'Checked, nothing to fix', flagged: 'Checked, issues flagged', unchecked: 'Not photographed', unverified: 'Photos received, not checked', awaiting: 'Photos pending',
  clear: 'Nothing found', raised: 'Repairs raised',
};
// The owner's words for the same facts.
export const OWNER_STATUS_LABEL = {
  ...STATUS_LABEL,
  done: 'Cleaned', unconfirmed: 'Visit not confirmed', not_sent: 'Visit not covered', uncovered: 'Visit not covered', open: 'In progress today',
  flagged: 'Checked, issues fixed before arrival',
};

export async function buildRecords(db, { from, to, slugs = null, limit = 1500, audience = 'era' } = {}) {
  const t = today();
  from = isDay(from) ? from : plus(t, -180);
  to = isDay(to) ? to : t;
  const owner = audience === 'owner';
  const list = Array.isArray(slugs) ? slugs.filter(Boolean) : null;
  if (list && !list.length) return { from, to, names: {}, records: [] };
  const inList = list ? `&slug=in.(${list.map(encodeURIComponent).join(',')})` : '';
  const staffSel = owner ? '' : ',staff:assigned_staff_id(name)';
  const bySel = owner ? '' : ',staff:by_staff_id(name)';
  const [tasks, checks, rounds, names] = await Promise.all([
    sbGet(db, `housekeeping_tasks?task_date=gte.${from}&task_date=lte.${to}${inList}`
      + `&select=id,slug,kind,task_date,status,notified_at,confirmed_at,done_at,guest_in_date,guest_out_date,same_day,photos,notes,moved_by,moved_at,thread${staffSel}&order=task_date.desc&limit=${limit}`),
    sbGet(db, `housekeeping_readiness?asked_at=gte.${plus(from, -1)}T16:00:00Z&asked_at=lte.${to}T15:59:59Z${inList}`
      + `&select=id,slug,kind,status,guest_in_date,photos,checks,flags,restock,asked_at,closed_at,task_id${bySel}&order=asked_at.desc&limit=${limit}`),
    sbGet(db, `housekeeping_inspections?inspected_on=gte.${from}&inspected_on=lte.${to}${inList}`
      + `&select=id,slug,inspected_on,photos,findings,item_ids,reported_at,task_id${bySel}&order=inspected_on.desc&limit=${limit}`),
    catalogNames(db).catch(() => ({})),
  ]);
  const checkByTask = new Map(checks.filter(c => c.task_id).map(c => [c.task_id, c]));
  const roundByTask = new Map(rounds.filter(r => r.task_id).map(r => [r.task_id, r]));
  const seenChecks = new Set(), seenRounds = new Set();
  const records = [];

  for (const x of tasks) {
    if (x.task_date > t) continue;
    const vs = visitStatus(x, t);
    if (owner && vs === 'skipped' && RULE_SKIP.test(x.notes || '')) continue;
    const check = checkByTask.get(x.id) || null;
    const round = roundByTask.get(x.id) || null;
    if (check) seenChecks.add(check.id);
    if (round) seenRounds.add(round.id);
    const type = round ? 'inspection' : check ? 'handover' : 'visit';
    const id = round ? round.id : check ? check.id : x.id;
    const status = round ? ((round.item_ids || []).length ? 'raised' : 'clear') : check ? check.status : vs;
    const photos = round ? (round.photos || []) : check ? [...new Set([...(check.photos || []), ...(x.photos || [])])] : (x.photos || []);
    const rec = {
      type, id, task_id: x.id, slug: x.slug, kind: x.kind, status, visit_status: vs,
      date: x.task_date, at: x.done_at || round?.reported_at || check?.asked_at || `${x.task_date}T04:00:00Z`,
      done_at: x.done_at || null, photo_count: photos.length,
      guest_in_date: x.guest_in_date || null, guest_out_date: x.guest_out_date || null, same_day: !!x.same_day,
      moved: !!x.moved_by,
    };
    if (!owner) {
      rec.staff = x.staff?.name || check?.staff?.name || round?.staff?.name || null;
      rec.notes = x.notes || null;
      rec.moved_by = x.moved_by || null;
      rec.thread_count = (x.thread || []).length;
    }
    if (check) {
      rec.closed_at = check.closed_at;
      rec.checks = check.checks || [];
      rec.flags = check.flags || [];
      rec.restock = check.restock || null;
      rec.flagged = (check.checks || []).filter(c => c.ok === false).map(c => ({ spot: c.spot, note: c.note || '' }));
      rec.other_flags = (check.flags || []).filter(f => !(check.checks || []).some(c => c.ok === false && f.startsWith(c.spot + ':')));
    }
    if (round) {
      rec.findings = round.findings || null;
      rec.item_ids = round.item_ids || [];
      rec.repairs = (round.item_ids || []).length;
    }
    records.push(rec);
  }
  // Checks and rounds with no visit behind them.
  for (const c of checks) {
    if (seenChecks.has(c.id)) continue;
    records.push({
      type: 'handover', id: c.id, task_id: c.task_id || null, slug: c.slug, kind: c.kind, status: c.status, visit_status: null,
      date: witaDay(c.asked_at), at: c.asked_at, closed_at: c.closed_at, photo_count: (c.photos || []).length,
      guest_in_date: c.guest_in_date || null, checks: c.checks || [], flags: c.flags || [], restock: c.restock || null,
      flagged: (c.checks || []).filter(x => x.ok === false).map(x => ({ spot: x.spot, note: x.note || '' })),
      other_flags: (c.flags || []).filter(f => !(c.checks || []).some(x => x.ok === false && f.startsWith(x.spot + ':'))),
      ...(owner ? {} : { staff: c.staff?.name || null }),
    });
  }
  for (const r of rounds) {
    if (seenRounds.has(r.id)) continue;
    records.push({
      type: 'inspection', id: r.id, task_id: r.task_id || null, slug: r.slug, kind: 'inspection', status: (r.item_ids || []).length ? 'raised' : 'clear', visit_status: null,
      date: r.inspected_on, at: r.reported_at, photo_count: (r.photos || []).length, findings: r.findings || null, item_ids: r.item_ids || [], repairs: (r.item_ids || []).length,
      ...(owner ? {} : { staff: r.staff?.name || null }),
    });
  }
  records.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at).localeCompare(String(a.at)));
  const mine = list ? Object.fromEntries(list.map(s => [s, names[s] || s])) : names;
  return { from, to, names: mine, records };
}

// One record in full: photos, the housekeeper's thread, the events, the
// repairs it raised. The same for all three types; `type`+`id` address it
// the old way, task_id is resolved from it.
export async function recordDetail(db, { type, id, slugs = null, audience = 'era' } = {}) {
  const owner = audience === 'owner';
  const mine = Array.isArray(slugs) ? new Set(slugs) : null;
  let task = null, check = null, round = null;
  if (type === 'handover') check = (await sbGet(db, `housekeeping_readiness?id=eq.${Number(id)}&select=*${owner ? '' : ',staff:by_staff_id(name)'}&limit=1`))?.[0] || null;
  else if (type === 'inspection') round = (await sbGet(db, `housekeeping_inspections?id=eq.${Number(id)}&select=*${owner ? '' : ',staff:by_staff_id(name)'}&limit=1`))?.[0] || null;
  const taskId = type === 'visit' ? Number(id) : (check?.task_id || round?.task_id || null);
  if (taskId) task = (await sbGet(db, `housekeeping_tasks?id=eq.${taskId}&select=*${owner ? '' : ',staff:assigned_staff_id(name)'}&limit=1`))?.[0] || null;
  const slug = task?.slug || check?.slug || round?.slug;
  if (!slug || (mine && !mine.has(slug))) return null;
  const photos = round ? (round.photos || []) : check ? [...new Set([...(check.photos || []), ...(task?.photos || [])])] : (task?.photos || []);
  const { signPhotoUrl } = await import('./maintenance.js');
  const photo_urls = [];
  for (const p of photos.slice(0, 40)) { const u = await signPhotoUrl(db, p, 3600).catch(() => null); if (u) photo_urls.push(u); }
  let events = [];
  if (taskId && !owner) { try { const { eventsFor } = await import('./events.js'); events = await eventsFor(db, 'housekeeping', taskId); } catch { /* optional */ } }
  let repairs = [];
  if ((round?.item_ids || []).length) repairs = ((await sbGet(db, `maintenance_items?id=in.(${round.item_ids.join(',')})&select=id,title,status`)) || []).map(i => ({ id: i.id, title: i.title, status: i.status }));
  const names = await catalogNames(db).catch(() => ({}));
  const vs = task ? visitStatus(task) : null;
  const record = {
    type, id: Number(id), task_id: taskId, slug, villa: names[slug] || slug, kind: task?.kind || check?.kind || 'inspection',
    status: round ? ((round.item_ids || []).length ? 'raised' : 'clear') : check ? check.status : vs, visit_status: vs,
    date: task?.task_date || round?.inspected_on || witaDay(check?.asked_at), at: task?.done_at || round?.reported_at || check?.asked_at || null,
    guest_in_date: task?.guest_in_date || check?.guest_in_date || null, guest_out_date: task?.guest_out_date || null,
    checks: check?.checks || [], flags: check?.flags || [], restock: check?.restock || null, findings: round?.findings || null,
    ...(owner ? {} : { staff: task?.staff?.name || check?.staff?.name || round?.staff?.name || null, notes: task?.notes || null, moved_by: task?.moved_by || null, thread: task?.thread || [] }),
  };
  return { record, photo_urls, events, repairs };
}
