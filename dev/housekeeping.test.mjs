// The cleaning schedule, checked against calendars that look like Samba's.
//
// A scheduling bug does not throw. It sends a housekeeper to a villa with a
// tenant asleep in it, or leaves a unit uncleaned between tenancies, and
// nobody finds out until someone complains. So the rules are pure functions
// and every rule is pinned here.
import { planTasks, vacancyRuns, DEFAULTS } from '../lib/housekeeping.js';

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
// The annotation the portal adds; recreated here so the fixtures read like
// the real payload.
const stay = (check_in, check_out, vacant_days_before = null) => ({
  check_in, check_out, nights: Math.round((Date.parse(check_out) - Date.parse(check_in)) / 86400000),
  vacant_days_before,
});

// ── Vacancy runs ─────────────────────────────────────────────────────
// check_out is EXCLUSIVE: a stay ending on the 5th leaves the villa free on
// the 5th, so back-to-back tenants leave a run of zero days, not one.
t('back-to-back leaves no vacancy',
  vacancyRuns([stay('2026-09-01', '2026-09-05'), stay('2026-09-05', '2026-09-10')], '2026-09-30'),
  [{ start: '2026-09-10', end: '2026-09-30', days: 20 }]);

t('a real gap is measured from the checkout day',
  vacancyRuns([stay('2026-09-01', '2026-09-05'), stay('2026-09-12', '2026-09-20')], '2026-09-20'),
  [{ start: '2026-09-05', end: '2026-09-12', days: 7 }]);

t('overlapping stays merge rather than double-count',
  vacancyRuns([stay('2026-09-01', '2026-09-10'), stay('2026-09-04', '2026-09-14')], '2026-09-16'),
  [{ start: '2026-09-14', end: '2026-09-16', days: 2 }]);

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

// ── During a long stay ───────────────────────────────────────────────
{
  // A four-week tenancy starting today: cleans on days 7, 14 and 21.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-09-01', '2026-09-29')])] });
  t('a long stay gets a weekly clean', datesOf(p, 'during_stay'),
    ['2026-09-08', '2026-09-15', '2026-09-22']);
}
{
  // A week-long stay is under the threshold and gets nothing but its turnover.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-09-01', '2026-09-08')])] });
  t('a short stay is left alone', datesOf(p, 'during_stay'), []);
}
{
  // The last clean must never land on or after the checkout, which already
  // has a turnover clean of its own.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-09-01', '2026-09-15')])] });
  t('no in-stay clean on the checkout day', datesOf(p, 'during_stay'), ['2026-09-08']);
}
{
  // A 22-night tenancy ending on the 6th: the day-21 clean falls on the 5th,
  // one day before the turnover clean, so it is dropped as duplicated work.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-08-15', '2026-09-06')])] });
  t('no in-stay clean right before the turnover', datesOf(p, 'during_stay'), []);
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

// ── An empty villa ───────────────────────────────────────────────────
{
  // Emptied on 20 August and nothing booked: visits every 14 days from then,
  // so 3 and 17 September fall inside the 21-day horizon.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-07-01', '2026-08-20')])] });
  t('an empty villa is visited every fortnight', datesOf(p, 'vacant_upkeep'),
    ['2026-09-03', '2026-09-17']);
}
{
  // A gap of a week between tenants is not long enough to warrant a visit
  // of its own; the turnover and the pre-arrival already cover it.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [
    stay('2026-08-25', '2026-09-05'), stay('2026-09-12', '2026-09-30', 7)])] });
  t('a short gap needs no upkeep visit', datesOf(p, 'vacant_upkeep'), []);
}

// ── Inspections ──────────────────────────────────────────────────────
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])] });
  t('a villa never inspected is inspected today', datesOf(p, 'inspection'), [TODAY]);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], lastInspection: { 'haus-1': '2026-08-25' } });
  t('the next round is a fortnight after the last', datesOf(p, 'inspection'), ['2026-09-08']);
}
{
  // A round that was missed must come due now, not slide forward for ever.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], lastInspection: { 'haus-1': '2026-07-01' } });
  t('a missed round is due immediately', datesOf(p, 'inspection'), [TODAY]);
}
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], lastInspection: { 'haus-1': '2026-08-31' } });
  t('a fresh inspection is not repeated', datesOf(p, 'inspection'), ['2026-09-14']);
}
{
  // The daily-spam bug. lastInspection carries the last round DONE *or*
  // ASKED FOR. Anchoring on completions alone meant an ignored inspection
  // stayed permanently due, minting a new task — and a new WhatsApp message
  // — every single day for every villa.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], lastInspection: { 'haus-1': TODAY } });
  t('an inspection already asked for today is not reissued', datesOf(p, 'inspection'), ['2026-09-15']);
}
{
  // A round scheduled for the future must not pull the next one forward.
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [])], lastInspection: { 'haus-1': '2026-09-14' } });
  t('a future round pushes the next beyond the horizon', datesOf(p, 'inspection'), []);
}

// ── One trip, one message ────────────────────────────────────────────
{
  // A tenant checks out on 6 September, so that day already has a turnover
  // clean. The inspection due the same day slides to the 7th rather than
  // sending the housekeeper a second WhatsApp about one visit.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-2', [stay('2026-08-01', '2026-09-06')])],
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
    lastInspection: { 'haus-2': '2026-08-23' },
  });
  t('inspection keeps its date when the day is free', datesOf(p, 'inspection'), ['2026-09-06']);
}
{
  // Two days in a row taken: the inspection keeps sliding until it is free.
  const p = planTasks({
    today: TODAY,
    units: [unit('haus-2', [stay('2026-08-01', '2026-09-06'), stay('2026-09-07', '2026-09-20', 1)])],
    lastInspection: { 'haus-2': '2026-08-23' },
  });
  const insp = datesOf(p, 'inspection')[0];
  t('inspection never lands on a day that already has work',
    datesOf(p, 'turnover').concat(datesOf(p, 'pre_arrival')).includes(insp), false);
}

// ── The horizon ──────────────────────────────────────────────────────
{
  const p = planTasks({ today: TODAY, units: [unit('haus-1', [stay('2026-06-01', '2026-06-20')])] });
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
  t('only the long tenancy makes in-stay cleans',
    [...new Set(p.filter(x => x.kind === 'during_stay').map(x => x.slug))], ['villa-saturno']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
