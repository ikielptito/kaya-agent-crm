// The cleaning schedule, derived from the booking calendar.
//
// Samba lets long term. That single fact makes almost all published
// housekeeping advice inapplicable: the short-let industry optimises the
// same-day turnover, and here a tenant may stay four months. So the product
// is a rhythm rather than a turnover: a twice-weekly clean that runs whether
// or not anyone is staying, plus a fortnightly inspection for the mould, the
// slow leak and the dead battery that nobody is there to notice.
//
// Four kinds of visit, in rough order of how often they fire:
//
//   regular       the twice-weekly service Samba sells, on each villa's own
//                 weekdays, running whether or not anyone is staying
//   inspection    every two weeks, photograph the place and flag what is
//                 wrong; this feeds the owner's weekly report and is the
//                 reason the whole schedule pays for itself
//   pre_arrival   someone is coming after the villa stood empty
//   turnover      a tenant left today
//   deep_clean    quarterly, on a vacant day when there is one: walls,
//                 oven, exterior windows, grout, pool furniture, the
//                 dispenser — the things a regular clean never reaches
//                 and a guest notices on day one
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
  cleans_per_week: 2,
  // Used only for a villa with no row in property_care, so a newly added
  // property is cleaned rather than silently ignored.
  default_clean_days: [1, 4],      // Monday and Thursday, 0 = Sunday
  pre_arrival_vacant_days: 5,
  inspection_every_days: 14,
  deep_clean_every_days: 90,
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

// ── The rules ───────────────────────────────────────────────────────
export function planTasks({ units, today, cfg = {}, lastInspection = {}, lastDeepClean = {}, careDays = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const horizon = plus(today, c.horizon_days);
  const out = [];
  const add = (t) => {
    // Never schedule into the past: a task dated yesterday would notify
    // someone this morning about a visit they cannot make.
    if (t.task_date < today || t.task_date > horizon) return;
    // origin_date is what the rule produced and what uniqueness is keyed on.
    // task_date starts equal to it and is the one that may later be moved.
    out.push({ origin_date: t.task_date, ...t });
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

      // 2. Freshen up the day before an arrival, when the villa has stood
      //    empty a while. A null vacancy means no earlier stay was found in
      //    a year of feed, so it counts as empty.
      const vacant = s.vacant_days_before;
      if (vacant == null || vacant >= c.pre_arrival_vacant_days) {
        add({
          slug: u.slug, task_date: plus(s.check_in, -1), kind: 'pre_arrival',
          guest_in_date: s.check_in,
        });
      }
    }

    // 3. The regular clean: the twice-weekly service Samba sells, on this
    //    villa's own weekdays. It runs whether or not anyone is staying —
    //    the rhythm is the product, and an empty villa still has to show
    //    well for viewings.
    //
    //    Two days are skipped. A checkout day already has a turnover clean,
    //    and an arrival-eve already has a freshen-up; adding a routine clean
    //    on top would send the same person to the same villa twice for one
    //    visit's worth of work.
    const days = careDays[u.slug] || c.default_clean_days;
    if (days?.length) {
      const busy = new Set(out.filter(t => t.slug === u.slug).map(t => t.task_date));
      for (let d = today; d <= horizon; d = plus(d, 1)) {
        if (!days.includes(new Date(d + 'T00:00:00Z').getUTCDay())) continue;
        if (busy.has(d)) continue;
        add({ slug: u.slug, task_date: d, kind: 'regular' });
      }
    }

    // 4. The inspection round, on its own clock regardless of bookings —
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
    const spread = c.inspection_every_days > 0 ? slugHash(u.slug) % c.inspection_every_days : 0;
    const dueRaw = last ? plus(last, c.inspection_every_days) : plus(today, spread);
    let due = dueRaw < today ? today : dueRaw;
    const taken = new Set(out.filter(t => t.slug === u.slug).map(t => t.task_date));
    // Bounded: give up after a week of collisions rather than looping, and
    // let the horizon check in add() drop it if it has run past the window.
    for (let i = 0; i < 7 && taken.has(due); i++) due = plus(due, 1);
    add({ slug: u.slug, task_date: due, kind: 'inspection' });

    // 5. The deep clean, quarterly. Same clock as the inspection, but it
    //    wants an EMPTY villa: scrubbing the oven and washing the exterior
    //    windows around a guest is a worse experience than the dirt was.
    //    So when the due date falls inside a stay and the villa is free at
    //    some point in the window, it moves to the first free day; when the
    //    tenant is there for months it happens anyway, on the due date, and
    //    Era can move it. Anchored to the last one done or asked for, so a
    //    skipped quarter comes due now rather than sliding for ever.
    if (c.deep_clean_every_days > 0) {
      const lastDeep = lastDeepClean[u.slug] || null;
      // A villa with no history is spread across the quarter's first six
      // weeks rather than the whole quarter, so the first pass through the
      // portfolio finishes before the second is due.
      const dSpread = (slugHash(u.slug) * 17) % Math.min(42, c.deep_clean_every_days);
      const dRaw = lastDeep ? plus(lastDeep, c.deep_clean_every_days) : plus(today, dSpread);
      let dDue = dRaw < today ? today : dRaw;
      if (dDue <= horizon) {
        const occupied = (d) => stays.some(s => s.check_in <= d && s.check_out > d);
        if (occupied(dDue)) {
          for (let d = dDue; d <= horizon; d = plus(d, 1)) {
            if (!occupied(d)) { dDue = d; break; }
          }
        }
        const busy = new Set(out.filter(t => t.slug === u.slug).map(t => t.task_date));
        for (let i = 0; i < 7 && busy.has(dDue); i++) dDue = plus(dDue, 1);
        add({ slug: u.slug, task_date: dDue, kind: 'deep_clean', guest_in_date: nextArrival(stays, dDue) });
      }
    }
  }
  return out;
}

// A stable per-villa offset, so a first run spreads the portfolio across
// the cycle and the same villa lands on the same day between runs.
const slugHash = (slug) => [...slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
const nextArrival = (stays, d) => (stays.find(s => s.check_in >= d) || {}).check_in || null;

// ── The rounds ahead ────────────────────────────────────────────────
// What the inspection and deep-clean clocks will produce over the coming
// months, as a projection rather than as tasks. Tasks only exist inside the
// horizon (three weeks) so that the schedule never promises a housekeeper a
// day that a booking change will move; this is the longer view Era and the
// owners can plan around, and the calendar feed is built from it. It is
// pure for the same reason planTasks is.
export function projectRounds({ units, today, cfg = {}, lastInspection = {}, lastDeepClean = {}, months = 6 } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const end = plus(today, Math.round(months * 30.4));
  const out = [];
  for (const u of units || []) {
    const stays = [...(u.stays || [])].sort((a, b) => a.check_in.localeCompare(b.check_in));
    const occupied = (d) => stays.some(s => s.check_in <= d && s.check_out > d);
    const walk = (kind, last, every, spread) => {
      if (!(every > 0)) return;
      let d = last ? plus(last, every) : plus(today, spread);
      if (d < today) d = today;
      for (let n = 0; d <= end && n < 40; n++) {
        let on = d;
        if (kind === 'deep_clean' && occupied(on)) {
          for (let x = on; x <= plus(on, 21) && x <= end; x = plus(x, 1)) if (!occupied(x)) { on = x; break; }
        }
        out.push({ slug: u.slug, date: on, kind, projected: n > 0 || !last || on !== d });
        d = plus(d, every);
      }
    };
    walk('inspection', lastInspection[u.slug], c.inspection_every_days, slugHash(u.slug) % (c.inspection_every_days || 1));
    walk('deep_clean', lastDeepClean[u.slug], c.deep_clean_every_days, (slugHash(u.slug) * 17) % Math.min(42, c.deep_clean_every_days || 1));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));
}

// ── Writing them down ───────────────────────────────────────────────
// unique(slug, ORIGIN_DATE, kind) plus ignore-duplicates is what makes this
// safe to run every hour: re-deriving a task that already exists changes
// nothing, so a booking made at 14:05 produces its clean by 15:05 without
// any risk of a second notification.
//
// Keyed on origin_date, not task_date, so a task someone has MOVED still
// matches its rule and is left alone. Keyed on the date it now sits on, a
// clean shifted from Monday to Tuesday would free the Monday slot and be
// recreated on the next pass — the same clean, twice.
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
  const asked = (await sbGet(db, 'housekeeping_tasks?kind=eq.inspection&select=slug,origin_date&order=origin_date.desc&limit=500')) || [];
  const lastInspection = {};
  for (const r of done) if (!lastInspection[r.slug]) lastInspection[r.slug] = r.inspected_on;
  for (const r of asked) {
    if (!lastInspection[r.slug] || r.origin_date > lastInspection[r.slug]) lastInspection[r.slug] = r.origin_date;
  }
  const lastDeepClean = await lastDeepCleanBySlug(db);

  // Each villa's own cleaning weekdays. A villa with no row falls back to the
  // default rather than being silently skipped.
  const care = (await sbGet(db, 'property_care?select=slug,clean_days,active')) || [];
  const careDays = {};
  for (const r of care) if (r.active !== false) careDays[r.slug] = r.clean_days || [];

  const planned = planTasks({ units: feed.units, today, cfg, lastInspection, lastDeepClean, careDays });
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
      slug: t.slug, task_date: t.task_date, origin_date: t.origin_date, kind: t.kind, status: 'planned',
      assigned_staff_id: who?.id ?? null,
      same_day: !!t.same_day,
      guest_out_date: t.guest_out_date ?? null,
      guest_in_date: t.guest_in_date ?? null,
    });
  }

  // One insert. PostgREST rejects a bulk insert whose objects have differing
  // key sets, so every row above carries the same keys.
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_tasks?on_conflict=slug,origin_date,kind`, {
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

// The deep clean has no record of its own the way the inspection does: the
// task IS the record, done or merely asked for. Skipped ones do not count,
// so a villa whose deep clean was skipped comes due again straight away.
export async function lastDeepCleanBySlug(db) {
  const rows = (await sbGet(db, 'housekeeping_tasks?kind=eq.deep_clean&status=neq.skipped&select=slug,origin_date&order=origin_date.desc&limit=500')) || [];
  const out = {};
  for (const r of rows) if (!out[r.slug]) out[r.slug] = r.origin_date;
  return out;
}

// The two clocks as the projection needs them. Shared by the generator's
// callers (the rounds view, the calendar feed) so nobody rebuilds it.
export async function roundAnchors(db) {
  const done = (await sbGet(db, 'housekeeping_inspections?select=slug,inspected_on&order=inspected_on.desc&limit=500')) || [];
  const asked = (await sbGet(db, 'housekeeping_tasks?kind=eq.inspection&select=slug,origin_date&order=origin_date.desc&limit=500')) || [];
  const lastInspection = {};
  for (const r of done) if (!lastInspection[r.slug]) lastInspection[r.slug] = r.inspected_on;
  for (const r of asked) if (!lastInspection[r.slug] || r.origin_date > lastInspection[r.slug]) lastInspection[r.slug] = r.origin_date;
  return { lastInspection, lastDeepClean: await lastDeepCleanBySlug(db) };
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
