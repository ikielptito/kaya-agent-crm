// A visit's status on the Records page, pinned. The point of the page is
// that a visit which did not happen is still a record.
import { visitStatus } from '../lib/housekeeping-records.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};
const ON = '2026-09-08';
const v = (o) => ({ status: 'planned', task_date: '2026-09-07', notified_at: null, notes: null, ...o });

t('done is done', visitStatus(v({ status: 'done' }), ON), 'done');
t('skipped is skipped', visitStatus(v({ status: 'skipped' }), ON), 'skipped');
t('sent yesterday, never answered = not confirmed', visitStatus(v({ status: 'notified', notified_at: 'x' }), ON), 'unconfirmed');
t('confirmed yesterday, never closed = not confirmed', visitStatus(v({ status: 'confirmed', notified_at: 'x' }), ON), 'unconfirmed');
t('planned yesterday, never sent = never sent', visitStatus(v({}), ON), 'not_sent');
t('planned yesterday with the uncovered note = uncovered', visitStatus(v({ notes: "Uncovered: Putu's phone has not received messages" }), ON), 'uncovered');
t('today, sent = open', visitStatus(v({ task_date: ON, status: 'notified', notified_at: 'x' }), ON), 'open');
t('today, uncovered = uncovered', visitStatus(v({ task_date: ON, notes: 'Uncovered: nobody' }), ON), 'uncovered');
t('today, not yet sent = open', visitStatus(v({ task_date: ON }), ON), 'open');
t('tomorrow = upcoming', visitStatus(v({ task_date: '2026-09-09' }), ON), 'upcoming');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
