// The cleaning schedule, derived from the booking calendar.
//
// Samba lets long term. That single fact makes almost all published
// housekeeping advice inapplicable: the short-let industry optimises the
// same-day turnover, and here a tenant may stay four months. The visits that
// matter are the ones DURING a tenancy, and the weeks a villa stands empty —
// which is when mould, a slow leak and a dead battery go unnoticed.
//
// Five kinds of visit, in rough order of how often they fire:
//
//   during_stay   a long tenancy gets a clean every so often
//   inspection    every two weeks, photograph the place and flag what is
//                 wrong; this feeds the owner's weekly report and is the
//                 reason the whole schedule pays for itself
//   vacant_upkeep an empty villa still has to show well for viewings
//   pre_arrival   someone is coming after the villa stood empty
//   turnover      a tenant left today
//
// planTasks is deliberately pure: given a calendar and today's date it
// returns the tasks that should exist. Everything about it is then testable
// against a real month of bookings, which matters because a scheduling bug
// is invisible until someone is standing outside the wrong villa.

import { getSettingValue } from './campaigns.js';
import { staffForSlug } from './staff.js';

const MS_DAY = 86400000;
const PORTAL_BASE = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';

const day = (d) => new Date(d).toISOString().slice(0, 10);
const plus = (d, n) => day(Date.parse(d) + n * MS_DAY);
const diff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / MS_DAY);

export const DEFAULTS = {
  during_stay_min_nights: 14,
  during_stay_every_days: 7,
  pre_arrival_vacant_days: 5,
  vacant_upkeep_days: 14,
  inspection_every_days: 14,
  horizon_days: 21,
};

// ── The calendar the portal hands us ─────────────────────────────────
// Only the portal holds the Hostex token and the catalog, so the stays come
// from there. Fail CLOSED, like the onboarding gate: no calendar means no
// tasks, which loses a day of schedule rather than inventing visits.
export async function fetchStays({ from, to } = {}) {
  const secret = process.env.LISTING_SYNC_SECRET;
  if (!secret) return null;
  try {
    const qs = new URLSearchParams({ action: 'turnovers', ...(from ? { from } : {}), ...(to ? { to } : {}) });
    const r = await fetch(`${PORTAL_BASE}/api/statements?${qs}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Vacancy ─────────────────────────────────────────────────────────
// Merged occupied intervals, then the gaps between them. check_out is
// exclusive, so a stay ending on the 5th leaves the villa free ON the 5th
// and a gap of zero days means back-to-back tenants.
export function vacancyRuns(stays, until) {
  const occupied = [...stays]
    .map(s => [s.check_in, s.check_out])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const merged = [];
  for (const [a, b] of occupied) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) { if (b > last[1]) last[1] = b; }
    else merged.push([a, b]);
  }
  const runs = [];
  for (let i = 0; i < merged.length; i++) {
    const start = merged[i][1];                       // free from the checkout day
    const end = merged[i + 1] ? merged[i + 1][0] : until;   // until the next arrival
    if (end > start) runs.push({ start, end, days: diff(start, end) });
  }
  return runs;
}

// ── The rules ───────────────────────────────────────────────────────
export function planTasks({ units, today, cfg = {}, lastInspection = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const horizon = plus(today, c.horizon_days);
  const out = [];
  const add = (t) => {
    // Never schedule into the past: a task dated yesterday would notify
    // someone this morning about a visit they cannot make.
    if (t.task_date < today || t.task_date > horizon) return;
    out.push(t);
  };

  for (const u of units || []) {
    const stays = [...(u.stays || [])].sort((a, b) => a.check_in.localeCompare(b.check_in));

    for (let i = 0; i < stays.length; i++) {
      const s = stays[i];
      const next = stays[i + 1];

      // 1. Turnover, on the checkout day itself.
      add({
        slug: u.slug, task_date: s.check_out, kind: 'turnover',
        guest_out_date: s.check_out, guest_in_date: next ? next.check_in : null,
        same_day: !!(next && next.check_in === s.check_out),
      });

      // 2. Cleans during a long tenancy, every N days from the check-in.
      //    The last one is dropped when it lands close to the checkout: the
      //    turnover clean already covers that, and sending a housekeeper in
      //    on the 5th to clean a villa being emptied on the 6th is the kind
      //    of waste that makes people stop trusting the schedule.
      if (s.nights >= c.during_stay_min_nights) {
        const tooCloseToEnd = Math.ceil(c.during_stay_every_days / 2);
        for (let d = c.during_stay_every_days; d < s.nights; d += c.during_stay_every_days) {
          const date = plus(s.check_in, d);
          if (diff(date, s.check_out) < tooCloseToEnd) continue;
          add({ slug: u.slug, task_date: date, kind: 'during_stay', guest_in_date: s.check_in });
        }
      }

      // 3. Freshen up the day before an arrival, when the villa has been
      //    empty long enough to smell like it. A null vacancy means we found
      //    no earlier stay at all in a year of feed, so it counts as empty.
      const vacant = s.vacant_days_before;
      if (vacant == null || vacant >= c.pre_arrival_vacant_days) {
        add({
          slug: u.slug, task_date: plus(s.check_in, -1), kind: 'pre_arrival',
          guest_in_date: s.check_in,
        });
      }
    }

    // 4. An empty villa still has to show well. Visits every N days from the
    //    day it emptied, for as long as it stays empty.
    for (const run of vacancyRuns(stays, plus(horizon, 1))) {
      for (let d = c.vacant_upkeep_days; d <= run.days; d += c.vacant_upkeep_days) {
        add({ slug: u.slug, task_date: plus(run.start, d), kind: 'vacant_upkeep' });
      }
    }

    // 5. The inspection round, on its own clock regardless of bookings —
    //    anchored to the last one done or already asked for, so a missed
    //    fortnight does not silently shift the cadence forward for ever.
    //
    //    It is also the only visit with no anchor in the outside world: a
    //    turnover is pinned to the day a tenant leaves, a pre-arrival to the
    //    day one comes. "Every fourteen days" is approximate, so when the due
    //    date already has real work on that villa the inspection slides to
    //    the next free day. One trip, one message — otherwise a housekeeper
    //    gets two WhatsApps one morning for a single visit.
    //    A villa with no history starts on a staggered day rather than today.
    //    On the first run every unit is due at once: fourteen inspections on
    //    one morning, four of them Putu's, which is not a day's work and
    //    would teach everyone to ignore the schedule. The offset is a stable
    //    hash of the slug, so it spreads the portfolio across the fortnight
    //    and does not move between runs.
    const last = lastInspection[u.slug] || null;
    const spread = c.inspection_every_days > 0
      ? [...u.slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7) % c.inspection_every_days
      : 0;
    const dueRaw = last ? plus(last, c.inspection_every_days) : plus(today, spread);
    let due = dueRaw < today ? today : dueRaw;
    const taken = new Set(out.filter(t => t.slug === u.slug).map(t => t.task_date));
    // Bounded: give up after a week of collisions rather than looping, and
    // let the horizon check in add() drop it if it has run past the window.
    for (let i = 0; i < 7 && taken.has(due); i++) due = plus(due, 1);
    add({ slug: u.slug, task_date: due, kind: 'inspection' });
  }
  return out;
}

// ── Writing them down ───────────────────────────────────────────────
// unique(slug, task_date, kind) plus ignore-duplicates is what makes this
// safe to run every hour: re-deriving a task that already exists changes
// nothing, so a booking made at 14:05 produces its clean by 15:05 without
// any risk of a second notification.
export async function generateTasks(db, { now = new Date() } = {}) {
  const today = day(now.getTime() + 8 * 3600e3);           // WITA
  const cfg = (await getSettingValue(db, 'housekeeping')) || {};
  const horizonDays = parseInt(cfg.horizon_days, 10) || DEFAULTS.horizon_days;

  const feed = await fetchStays({ from: plus(today, -30), to: plus(today, horizonDays + 1) });
  if (!feed?.units?.length) return { skipped: 'no calendar from the portal' };

  // Anchor the inspection cadence to the last round DONE *or* ALREADY ASKED
  // FOR, whichever is later.
  //
  // Anchoring on completed rounds alone looked right and was badly wrong: a
  // housekeeper who ignored an inspection left lastInspection empty, so the
  // rule stayed permanently due, and the generator minted a fresh task dated
  // today — every single day, for every villa, each one a new WhatsApp
  // message. Counting the existing task closes that loop, so an ignored round
  // is chased by the follow-up rather than reissued forever.
  // Newest first, capped: only the most recent round per villa matters, and
  // these tables grow by ~26 rows per villa per year.
  const done = (await sbGet(db, 'housekeeping_inspections?select=slug,inspected_on&order=inspected_on.desc&limit=500')) || [];
  const asked = (await sbGet(db, 'housekeeping_tasks?kind=eq.inspection&select=slug,task_date&order=task_date.desc&limit=500')) || [];
  const lastInspection = {};
  for (const r of done) if (!lastInspection[r.slug]) lastInspection[r.slug] = r.inspected_on;
  for (const r of asked) {
    if (!lastInspection[r.slug] || r.task_date > lastInspection[r.slug]) lastInspection[r.slug] = r.task_date;
  }

  const planned = planTasks({ units: feed.units, today, cfg, lastInspection });
  if (!planned.length) return { planned: 0, created: 0 };

  // Assign each task to whoever covers that villa. An unassigned task still
  // gets written: a visible gap in the schedule is the point, and silently
  // dropping it would hide that nobody cleans that unit.
  const coverCache = new Map();
  const rowsToInsert = [];
  for (const t of planned) {
    if (!coverCache.has(t.slug)) {
      const candidates = await staffForSlug(db, t.slug, { role: 'housekeeper' });
      // staffForSlug also returns people with NO villas listed, who count as
      // island-wide. That is right for a tukang and wrong here: a cleaner
      // quick-added without ticking any villas would otherwise be a candidate
      // for every unit, and being first alphabetically could take Saturno off
      // Naomi. Whoever explicitly covers the villa always wins.
      const explicit = candidates.filter(p => (p.slugs || []).includes(t.slug));
      coverCache.set(t.slug, explicit[0] || candidates[0] || null);
    }
    const who = coverCache.get(t.slug);
    rowsToInsert.push({
      slug: t.slug, task_date: t.task_date, kind: t.kind, status: 'planned',
      assigned_staff_id: who?.id ?? null,
      same_day: !!t.same_day,
      guest_out_date: t.guest_out_date ?? null,
      guest_in_date: t.guest_in_date ?? null,
    });
  }

  // One insert. PostgREST rejects a bulk insert whose objects have differing
  // key sets, so every row above carries the same keys.
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_tasks?on_conflict=slug,task_date,kind`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(rowsToInsert),
  });
  if (!r.ok) return { error: `housekeeping insert → ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const created = (await r.json().catch(() => [])) || [];
  return { planned: planned.length, created: created.length, today };
}

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

// Human names for the slugs. The CRM keeps no catalog of its own, but the
// portal's listing sync mirrors every villa into `rentals` — with the slug
// underscored, which is the only reason this is not a one-liner. A missing
// name falls back to the slug rather than to nothing: "tropicana-b4" is
// still legible, an empty villa name in a work order is not.
export async function catalogNames(db) {
  const rows = (await sbGet(db, 'rentals?select=slug,name')) || [];
  const out = {};
  for (const r of rows) {
    if (!r.slug) continue;
    out[String(r.slug).replace(/_/g, '-')] = String(r.name || '').replace(/\s*[–—]\s*/g, ' · ') || r.slug;
  }
  return out;
}
