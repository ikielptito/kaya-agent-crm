// The cleaning schedule, checked against calendars that look like Samba's.
//
// A scheduling bug does not throw. It sends a housekeeper to a villa with a
// tenant asleep in it, or leaves a unit uncleaned between tenancies, and
// nobody finds out until someone complains. So the rules are pure functions
// and every rule is pinned here.
import { planTasks, projectRounds, DEFAULTS } from '../lib/housekeeping.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const TODAY = '2026-09-01';
const datesOf = (tasks, kind, slug) =>
  tasks.filter(x => x.kind === kind && (!slug || x.slug === slug)).map(x => x.task_date).sort();

const unit = (slug, stays) => ({ slug, stays });
// Most fixtures below pin ONE rule, so they switch the twice-weekly clean off
// rather than have its Mondays and Thursdays collide with what is under test.
const NO_CLEANS = { 'haus-1': [], 'haus-2': [], 'villa-saturno': [], 'tropicana-b4': [] };
// The annotation the portal adds; recreated here so the fixtures read like
// the real payload.
const stay = (check_in, check_out, vacant_days_before = null) => ({
  check_in, check_out, nights: Math.round((Date.parse(check_out) - Date.parse(check_in)) / 86400000),
  vacant_days_before,
});

// ── Turnover ─────────────────────────────────────────────────────────
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-09-04')])] });
  t('a clean on the checkout day, not the day after', datesOf(p, 'turnover'), ['2026-09-04']);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [
    stay('2026-08-01', '2026-09-04'), stay('2026-09-04', '2026-10-01', 0)])] });
  const turn = p.find(x => x.kind === 'turnover');
  t('same-day arrival is flagged', [turn.task_date, turn.same_day, turn.guest_in_date],
    ['2026-09-04', true, '2026-09-04']);
}

// ── Before an arrival ────────────────────────────────────────────────
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [
    stay('2026-08-01', '2026-08-20'), stay('2026-09-10', '2026-09-30', 21)])] });
  t('freshen up the day before, after a long vacancy', datesOf(p, 'pre_arrival'), ['2026-09-09']);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [
    stay('2026-08-01', '2026-09-08'), stay('2026-09-10', '2026-09-30', 2)])] });
  t('a two-day gap needs no freshen-up', datesOf(p, 'pre_arrival'), []);
}

// ── The regular twice-weekly clean ───────────────────────────────────
// This is the service Samba sells, not a rule derived from bookings: fixed
// weekdays per villa, running whether or not anyone is staying.
{
  // 1 Sept 2026 is a Tuesday. Monday/Thursday over three weeks from then.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: { 'haus-1': [1, 4] } });
  t('regular cleans land on the villa\'s own weekdays', datesOf(p, 'regular'),
    ['2026-09-03', '2026-09-07', '2026-09-10', '2026-09-14', '2026-09-17', '2026-09-21']);
}
{
  // An empty villa keeps the rhythm: the twice-weekly clean is the product,
  // and it is what keeps a vacant villa showing well for viewings.
  const empty = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: { 'haus-1': [1, 4] } });
  const full = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-10-01')])], careDays: { 'haus-1': [1, 4] } });
  t('an empty villa is cleaned as often as an occupied one',
    datesOf(empty, 'regular').length, datesOf(full, 'regular').length);
}
{
  // Different villas, different days, so one housekeeper is not doing four
  // properties on one morning.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-1', []), unit('haus-2', [])],
    careDays: { 'haus-1': [1, 4], 'haus-2': [2, 5] },
  });
  t('each villa follows its own days', datesOf(p, 'regular', 'haus-2'),
    ['2026-09-01', '2026-09-04', '2026-09-08', '2026-09-11', '2026-09-15', '2026-09-18', '2026-09-22']);
}
{
  // A checkout day already has a turnover clean; a routine clean on top would
  // send the same person to the same villa twice for one visit's work.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-1', [stay('2026-08-01', '2026-09-03')])],   // checkout on a Thursday
    careDays: { 'haus-1': [1, 4] },
  });
  t('no regular clean on a turnover day', datesOf(p, 'regular').includes('2026-09-03'), false);
  t('the turnover is still there', datesOf(p, 'turnover'), ['2026-09-03']);
}
{
  // A villa with no property_care row is still cleaned, on the default days,
  // rather than silently dropping off the schedule.
  const p = planTasks({ today: TODAY, units: [unit('haus-9', [])] });
  t('an unconfigured villa falls back to the default days',
    datesOf(p, 'regular').length > 0, true);
}

// ── Inspections ──────────────────────────────────────────────────────
{
  // A villa with no history starts on a staggered day, not today: otherwise
  // the first run puts every unit's inspection on one morning, and one
  // housekeeper covering four villas cannot do four photo rounds in a day.
  // The offset is a stable hash of the slug, so it never moves between runs.
  const p1 = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS });
  const p2 = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS });
  const d = datesOf(p1, 'inspection')[0];
  t('a never-inspected villa is scheduled within the fortnight',
    d >= TODAY && d <= '2026-09-14', true);
  t('the staggered date is stable across runs', datesOf(p2, 'inspection'), [d]);
}
{
  // The real portfolio: nobody should face more than one round a day.
  const slugs = ['haus-1', 'haus-2', 'haus-4', 'haus-5', 'lanehaus-1', 'lanehaus-3',
    'villa-saturno', 'tropicana-a4', 'tropicana-a5', 'tropicana-b2', 'tropicana-b3',
    'tropicana-b4', 'tropicana-b5', 'tropicana-b6'];
  const p = planTasks({ today: TODAY, units: slugs.map(s => unit(s, [])), careDays: Object.fromEntries(slugs.map(s => [s, []])) });
  const perDay = {};
  for (const x of p.filter(y => y.kind === 'inspection')) perDay[x.task_date] = (perDay[x.task_date] || 0) + 1;
  t('all fourteen villas are scheduled', p.filter(y => y.kind === 'inspection').length, 14);
  t('no more than two villas inspected on any one day', Math.max(...Object.values(perDay)) <= 2, true);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, lastInspection: { 'haus-1': '2026-08-25' } });
  t('the next round is a fortnight after the last', datesOf(p, 'inspection'), ['2026-09-08']);
}
{
  // A round that was missed must come due now, not slide forward for ever.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, lastInspection: { 'haus-1': '2026-07-01' } });
  t('a missed round is due immediately', datesOf(p, 'inspection'), [TODAY]);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, lastInspection: { 'haus-1': '2026-08-31' } });
  t('a fresh inspection is not repeated', datesOf(p, 'inspection'), ['2026-09-14']);
}
{
  // The daily-spam bug. lastInspection carries the last round DONE *or*
  // ASKED FOR. Anchoring on completions alone meant an ignored inspection
  // stayed permanently due, minting a new task — and a new WhatsApp message
  // — every single day for every villa.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, lastInspection: { 'haus-1': TODAY } });
  t('an inspection already asked for today is not reissued', datesOf(p, 'inspection'), ['2026-09-15']);
}
{
  // A round scheduled for the future must not pull the next one forward.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, lastInspection: { 'haus-1': '2026-09-14' } });
  t('a future round pushes the next beyond the horizon', datesOf(p, 'inspection'), []);
}

// ── One trip, one message ────────────────────────────────────────────
{
  // A tenant checks out on 6 September, so that day already has a turnover
  // clean. The inspection due the same day slides to the 7th rather than
  // sending the housekeeper a second WhatsApp about one visit.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-2', [stay('2026-08-27', '2026-09-06')])],   // 10 nights: no long-stay deep clean
    careDays: NO_CLEANS,
    lastInspection: { 'haus-2': '2026-08-23' },      // due 6 Sept
  });
  t('turnover keeps its date', datesOf(p, 'turnover'), ['2026-09-06']);
  t('inspection slides off the collision', datesOf(p, 'inspection'), ['2026-09-07']);
}
{
  // No collision, no movement.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-2', [stay('2026-08-01', '2026-09-10')])],
    careDays: NO_CLEANS,
    lastInspection: { 'haus-2': '2026-08-23' },
  });
  t('inspection keeps its date when the day is free', datesOf(p, 'inspection'), ['2026-09-06']);
}
{
  // Two days in a row taken: the inspection keeps sliding until it is free.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-2', [stay('2026-08-01', '2026-09-06'), stay('2026-09-07', '2026-09-20', 1)])],
    careDays: NO_CLEANS,
    lastInspection: { 'haus-2': '2026-08-23' },
  });
  const insp = datesOf(p, 'inspection')[0];
  t('inspection never lands on a day that already has work',
    datesOf(p, 'turnover').concat(datesOf(p, 'pre_arrival')).includes(insp), false);
}

// ── The horizon ──────────────────────────────────────────────────────
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-06-01', '2026-06-20')])], careDays: NO_CLEANS });
  t('nothing is scheduled in the past', p.filter(x => x.task_date < TODAY), []);
  t('nothing is scheduled beyond the horizon',
    p.filter(x => x.task_date > '2026-09-22'), []);
}

// ── A whole portfolio at once ────────────────────────────────────────
{
  const p = planTasks({
    today: TODAY,
    units: [
      unit('haus-1', [stay('2026-08-15', '2026-09-06')]),                 // tenant leaving
      unit('villa-saturno', [stay('2026-09-01', '2026-10-15')]),          // long tenancy
      unit('tropicana-b4', []),                                           // empty for ever
    ],
  });
  t('every villa gets an inspection', datesOf(p, 'inspection').length, 3);
  t('only the leaving tenant makes a turnover', datesOf(p, 'turnover'), ['2026-09-06']);
  t('every villa gets its regular cleans regardless of occupancy',
    [...new Set(p.filter(x => x.kind === 'regular').map(x => x.slug))].sort(),
    ['haus-1', 'tropicana-b4', 'villa-saturno']);
}

// ── The quarterly deep clean ─────────────────────────────────────────
// Walls, oven, exterior windows, grout, pool furniture: the things a
// regular clean never reaches and a guest notices on day one. It wants an
// empty villa when it can have one.
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-06-10' } });
  t('a deep clean comes 90 days after the last one', datesOf(p, 'deep_clean'), ['2026-09-08']);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-04-01' } });
  t('an overdue deep clean is due today, not lost', datesOf(p, 'deep_clean'), [TODAY]);
}
{
  // Due on the 8th, guest in until the 12th: it waits for the villa to empty.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-20', '2026-09-12')])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-06-10' } });
  t('a deep clean waits for the villa to be empty', datesOf(p, 'deep_clean'), ['2026-09-13']);
}
{
  // Due on the 8th, checkout on the 12th: the 12th has the turnover, so it
  // lands on the 13th and never on top of the same visit.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-09-02', '2026-09-12'), stay('2026-09-13', '2026-09-30', 1)])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-06-10' } });
  const dc = datesOf(p, 'deep_clean')[0];
  t('a quarterly deep clean never shares a day with another visit', datesOf(p, 'turnover').concat(datesOf(p, 'pre_arrival')).includes(dc), false);
}
{
  // A tenant there for months: it happens on the due date anyway, and Era
  // can move it. Waiting for a vacancy that is not coming is the same as
  // never cleaning.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-12-31')])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-06-10' } });
  t('a long tenancy does not postpone the deep clean for ever', datesOf(p, 'deep_clean'), ['2026-09-08']);
}
{
  // Never done before: the first pass spreads villas across the coming six
  // weeks (only those landing inside the horizon are minted as tasks).
  const p = planTasks({ today: TODAY, units: [unit('haus-1', []), unit('haus-2', []), unit('villa-saturno', []), unit('tropicana-b4', [])], careDays: NO_CLEANS });
  const dates = datesOf(p, 'deep_clean');
  t('first-run deep cleans are staggered, not all today', new Set(dates).size, dates.length);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], careDays: NO_CLEANS, cfg: { deep_clean_every_days: 0 } });
  t('deep cleans can be switched off', datesOf(p, 'deep_clean'), []);
}

// ── Deep clean after a long stay ─────────────────────────────────────
{
  // 28 nights, out on the 6th: turnover on the 6th, deep clean on the 7th.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-09', '2026-09-06')])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-07-01' } });
  t('a long stay ends with a deep clean the day after the turnover', datesOf(p, 'deep_clean'), ['2026-09-07']);
  t('and the quarterly clock restarts from it (no second one in the window)', datesOf(p, 'deep_clean').length, 1);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-30', '2026-09-06')])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-08-25' } });
  t('a week-long stay does not', datesOf(p, 'deep_clean'), []);
}
{
  // Next guest arrives the day after checkout: the deep clean lands on the
  // checkout day itself and is flagged same-day for Era to weigh.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-09-06'), stay('2026-09-07', '2026-09-20', 1)])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-07-01' } });
  const dc = p.find(x => x.kind === 'deep_clean');
  t('back-to-back: deep clean on the checkout day, flagged', [dc.task_date, dc.same_day, dc.guest_in_date], ['2026-09-06', true, '2026-09-07']);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-09-06')])], careDays: NO_CLEANS,
    lastDeepClean: { 'haus-1': '2026-08-20' } });
  t('not when a deep clean happened in the last month', datesOf(p, 'deep_clean'), []);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-01', '2026-09-06')])], careDays: NO_CLEANS,
    cfg: { deep_clean_after_nights: 0 }, lastDeepClean: { 'haus-1': '2026-08-20' } });
  t('the long-stay rule can be switched off', datesOf(p, 'deep_clean'), []);
}

// ── The rounds ahead ─────────────────────────────────────────────────
{
  const r = projectRounds({ today: TODAY, months: 6, units: [unit('haus-1', [])],
    lastInspection: { 'haus-1': '2026-08-25' }, lastDeepClean: { 'haus-1': '2026-08-01' } });
  t('six months of inspections', r.filter(x => x.kind === 'inspection').map(x => x.date).slice(0, 3), ['2026-09-08', '2026-09-22', '2026-10-06']);
  t('two deep cleans in six months', r.filter(x => x.kind === 'deep_clean').map(x => x.date), ['2026-10-30', '2027-01-28']);
}
{
  const r = projectRounds({ today: TODAY, months: 3, units: [unit('haus-1', [stay('2026-10-20', '2026-11-10')])],
    lastInspection: { 'haus-1': '2026-08-25' }, lastDeepClean: { 'haus-1': '2026-08-01' } });
  t('a projected deep clean also avoids a known stay', r.find(x => x.kind === 'deep_clean').date, '2026-11-10');
}

// ── What counts as a question for Maya to answer ────────────────────
{
  const { looksLikeStaffQuestion } = await import('../lib/staff-help.js');
  const yes = ['kenapa harus foto oven?', 'Kenapa harus foto dalam oven', 'gimana cara kirim foto', 'apa itu deep clean', 'why do they need to photograph the sofa', 'boleh saya kerjakan besok pagi?', 'what does Needs a look mean'];
  const no = ['sudah', 'Sudah selesai', 'besok saja', 'lampu teras mati', 'ok', '🙏', 'terima kasih', 'Ok terimakasih', 'oke makasih ya 🙏', 'baik siap', 'sabun mandi tinggal sedikit', 'selesai'];
  t('questions are claimed', yes.map(looksLikeStaffQuestion), yes.map(() => true));
  t('task replies, acks and reports are not', no.map(looksLikeStaffQuestion), no.map(() => false));
}

{
  const { realText } = await import('../lib/housekeeping-intake.js');
  t('the image placeholder is not a finding', realText('[Agent sent an image — say briefly that you could not open it and offer to have Ikiel review it.]'), '');
  t('a real caption is', realText('jamur di plafon kamar mandi'), 'jamur di plafon kamar mandi');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
