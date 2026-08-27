#!/usr/bin/env node
// Fixture tests for lib/statement-parser.js — every fixture encodes a drift
// actually observed in Era's real 2026 report sheets ("Unit 2 & 4 Haus
// Canggu" et al.): side balance tables in far-right columns, EXPENSESS /
// DESCRIPTON header spellings, a missing amount header, zero-amount owner
// stays, missing dates, stale tab labels, and arithmetic that doesn't
// reconcile. Run: node dev/statement-parser.test.mjs

import assert from 'node:assert';
import { parseMonthTab } from '../lib/statement-parser.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const E = '';   // empty cell shorthand

// ── Fixture: the real July 2026 "Unit 2 & 4" tab shape ──────────────
// Two unit blocks (unit 2 empty, unit 4 one booking), expense block WITHOUT
// an amount header (observed: header row is DATE|DESCRIPTON|VILLA| ), a side
// balance table in far-right columns, TOTAL PAYOUT at the end.
const JULY = [
  ['Monthly Report '],
  ['July 2026'],
  ['Unit 2 Haus Canggu'],
  [],
  ['No', 'Guest Name', 'Date of Stay', 'Booking Platform ', 'No. Stay', 'Amount ', 'Comission ', 'Nett to Owner'],
  [1, E, E, E, E, E, 0, 0],
  [2, E, E, E, E, E, 0, 0],
  [E, E, E, E, E, E, 0, 0],
  ['Total', E, E, E, E, 0, 0, 0],
  [],
  ['Monthly Report '],
  ['July 2026'],
  ['Unit 4 Haus Canggu'],
  [],
  ['No', 'Guest Name', 'Date of Stay', 'Booking Platform ', 'No. Stay', 'Amount ', 'Comission ', 'Nett to Owner',
    E, E, E, E, 'Balance July 2025 - January 2026', E],
  [1, 'Genevieve', '1-18 July', 'Direct Booking', 18, 16800000, 2520000, 14280000, E, E, E, E, 'July 2025', 29386125],
  [E, E, E, E, E, E, 0, 0, E, E, E, E, 'August 2025', 19671672],
  ['Total', E, E, E, E, 16800000, 2520000, 14280000, E, E, E, E, 'Total', 49057797],
  [],
  ['HAUS CANGGU UNIT 2 & 4'],
  ['July 2026'],
  [],
  ['DATE', 'DESCRIPTON', 'VILLA'],
  ['01 Jul 2026', 'Internet', 'Haus Canggu Unit 2 & 4', 168750],
  ['02 Jul 2026', 'Advance payment Sebastian', 'Haus Canggu Unit 2 & 4', 2460000],
  ['25 Jul 2026', 'Electricity Expense unit 2', 'Haus Canggu Unit 2 & 4', 503500],
  ['31 Jul 2026', 'Laundry unit 4', 'Haus Canggu Unit 2 & 4', 297000],
  ['TOTAL', E, E, 3429250],
  [],
  ['TOTAL PAYOUT ', E, E, 10850750],
];

console.log('parseMonthTab:');

test('real July tab: two unit blocks, one booking, expenses, payout', () => {
  const p = parseMonthTab(JULY, { tabTitle: 'July' });
  assert.equal(p.period, '2026-07');
  assert.equal(p.units.length, 2);
  assert.equal(p.units[0].unit_name, 'Unit 2 Haus Canggu');
  assert.equal(p.units[0].bookings.length, 0);
  assert.equal(p.units[1].unit_name, 'Unit 4 Haus Canggu');
  assert.equal(p.units[1].bookings.length, 1);
  const b = p.units[1].bookings[0];
  assert.equal(b.guest_name, 'Genevieve');
  assert.equal(b.amount, 16800000);
  assert.equal(b.commission, 2520000);
  assert.equal(b.nett, 14280000);
  assert.equal(b.nights, 18);
  assert.equal(p.expenses.length, 4);
  assert.equal(p.totals.expenses, 3429250);
  assert.equal(p.era_expense_total, 3429250);
  assert.equal(p.era_payout_total, 10850750);
  assert.equal(p.totals.payout, 14280000 - 3429250);
});

test('side balance table stays invisible (column window)', () => {
  const p = parseMonthTab(JULY, { tabTitle: 'July' });
  const allCells = JSON.stringify(p.units) + JSON.stringify(p.expenses);
  assert.ok(!allCells.includes('29386125'), 'balance figures must not leak into lines');
  assert.ok(!allCells.includes('August 2025'));
});

test('reconciliation passes when Era arithmetic is right', () => {
  const p = parseMonthTab(JULY, { tabTitle: 'July' });
  for (const c of p.reconciliation.checks) assert.ok(c.ok, `${c.name} expected ${c.expected} got ${c.actual}`);
  assert.equal(p.needs_review, false);
});

test('non-reconciling TOTAL PAYOUT fails a check and flags review', () => {
  const bad = JULY.map(r => [...r]);
  bad[bad.length - 1] = ['TOTAL PAYOUT ', E, E, 99999999];
  const p = parseMonthTab(bad, { tabTitle: 'July' });
  const c = p.reconciliation.checks.find(x => x.name === 'payout_vs_nett_minus_expenses');
  assert.ok(c && !c.ok);
  assert.equal(p.needs_review, true);
});

test('unit total that disagrees with its lines fails the unit check', () => {
  const bad = JULY.map(r => [...r]);
  bad[17] = ['Total', E, E, E, E, 16800000, 2520000, 14000000];   // Era's total off by 280k
  const p = parseMonthTab(bad, { tabTitle: 'July' });
  const c = p.reconciliation.checks.find(x => x.name.startsWith('bookings_nett_vs_era_total') && !x.ok);
  assert.ok(c, 'expected a failing unit reconciliation check');
  assert.equal(p.needs_review, true);
});

test('zero-amount owner stay is kept and flagged, not dropped', () => {
  const rows = [
    ['Monthly Report'], ['February 2026'], ['Unit 2 Haus Canggu'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Tim', '6 Feb - 15 March', 'Owner booking', 37, 0, 0, 0],
    ['Total', E, E, E, E, 0, 0, 0],
    [], ['TOTAL PAYOUT', E, 0],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'February' });
  assert.equal(p.units[0].bookings.length, 1);
  assert.ok(p.units[0].bookings[0].flags.includes('zero_amount'));
});

test('EXPENSESS header drift + missing expense date flagged', () => {
  const rows = [
    ['Monthly Report'], ['May 2026'], ['Unit 5 Haus Canggu'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Backi', '29 April-25 May', 'Airbnb', 26, 1000000, 150000, 850000],
    ['Total', E, E, E, E, 1000000, 150000, 850000],
    [],
    ['DATE', 'DESCRIPTON', 'VILLA', 'EXPENSESS'],
    ['01 May 2026', 'Internet', 'Unit 5', 278750],
    [E, 'Pool chemicals', 'Unit 5', 150000],
    ['TOTAL', E, E, 428750],
    ['TOTAL PAYOUT', E, 421250],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'May' });
  assert.equal(p.expenses.length, 2);
  assert.equal(p.totals.expenses, 428750);
  assert.ok(p.expenses[1].flags.includes('missing_date'));
});

test('commission that does not equal amount minus nett flags the line', () => {
  const rows = [
    ['Monthly Report'], ['March 2026'], ['Villa Saturno'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'David', '16-17 March', 'Airbnb', 1, 662295, 99344, 500000],
    ['Total', E, E, E, E, 662295, 99344, 500000],
    ['TOTAL PAYOUT', E, 500000],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'March' });
  assert.ok(p.units[0].bookings[0].flags.includes('commission_mismatch'));
  assert.equal(p.needs_review, true);
});

test('stale tab label vs in-sheet month flags period_mismatch, keeps in-sheet period', () => {
  const p = parseMonthTab(JULY, { tabTitle: 'June' });
  assert.equal(p.period, '2026-07');
  assert.ok(p.flags.includes('period_mismatch'));
  assert.equal(p.needs_review, true);
});

test('money row the parser cannot place lands in unparsed_rows', () => {
  const rows = JULY.map(r => [...r]);
  rows.splice(19, 0, [E, 'Mystery transfer', E, 1234567]);   // inside table span, no block
  const p = parseMonthTab(rows, { tabTitle: 'July' });
  assert.ok(p.flags.includes('unparsed_rows'));
  assert.ok(p.reconciliation.unparsed_rows.some(u => u.cells.includes('Mystery transfer')));
  assert.equal(p.needs_review, true);
});

test('non-report tab (template/scratch) returns null', () => {
  assert.equal(parseMonthTab([['Cleaning checklist'], ['towels', 12]], { tabTitle: 'Notes' }), null);
});

test('text-formatted numbers with separators still parse', () => {
  const rows = [
    ['Monthly Report'], ['January 2026'], ['Unit 1 Haus Canggu'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Victria', '29 Dec - 6 feb', 'Airbnb ', '39', '25,926,462', '3,888,969', '22,037,493'],
    ['Total', E, E, E, E, '25,926,462', '3,888,969', '22,037,493'],
    ['TOTAL PAYOUT', E, '22,037,493'],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'January' });
  assert.equal(p.units[0].bookings[0].amount, 25926462);
  assert.equal(p.era_payout_total, 22037493);
  assert.equal(p.needs_review, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
