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

// ── Drift observed in the REAL sheets on first production import (27 Aug) ──

test('wide blank gap before the merged Total still closes the block (A4 March shape)', () => {
  const rows = [
    ['Monthly Report'], ['March 2026'], ['A4 Tropicana Valley'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Ilyas', '10 March - 10 april', 'Direct', 30, 26000000, 5200000, 20800000],
    [], [], [], [],
    ['Total', E, E, E, E, 26000000, 5200000, 20800000],
    [],
    ['DATE', 'DESCRIPTON', 'VILLA', 'EXPENSESS'],
    ['01 Mar 2026', 'Housekeeping salary', 'A4', 1000000],
    ['TOTAL', E, E, 1000000],
    ['TOTAL PAYOUT', E, 19800000],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'March' });
  assert.equal(p.units[0].era_total.nett, 20800000, 'Total row after 4 blanks must be captured');
  assert.ok(!p.flags.includes('unparsed_rows'));
  assert.equal(p.needs_review, false);
});

test('T0TAL PAYOUT typo (zero for O) still found', () => {
  const rows = [
    ['Monthly Report'], ['March 2026'], ['A4 Tropicana Valley'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Ilyas', '10-12 March', 'Direct', 2, 1000000, 200000, 800000],
    ['Total', E, E, E, E, 1000000, 200000, 800000],
    ['T0TAL PAYOUT', E, 800000],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'March' });
  assert.equal(p.era_payout_total, 800000);
  assert.equal(p.needs_review, false);
});

test('"Minus from February" carry-forward becomes a negative adjustment that reconciles', () => {
  // Real A4 March 2026: 20.8M nett − 4,462,714 exp − 2,053,995 carry = 14,283,291
  const rows = [
    ['Monthly Report'], ['March 2026'], ['A4 Tropicana Valley'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Ilyas', '10 March - 10 april', 'Direct', 30, 26000000, 5200000, 20800000],
    ['Total', E, E, E, E, 26000000, 5200000, 20800000],
    [],
    ['DATE', 'DESCRIPTON', 'VILLA', 'EXPENSESS'],
    ['01 Mar 2026', 'Expenses lumped', 'A4', 4462714],
    ['TOTAL', E, E, 4462714],
    [],
    ['Minus from February ', E, 2053995],
    [],
    ['T0TAL PAYOUT', E, 14283291],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'March' });
  assert.equal(p.adjustments.length, 1);
  assert.equal(p.adjustments[0].amount, -2053995);
  assert.equal(p.totals.payout, 14283291);
  const c = p.reconciliation.checks.find(x => x.name === 'payout_vs_nett_minus_expenses');
  assert.ok(c && c.ok, 'carry-forward must reconcile the payout check');
});

test('two expense blocks in one tab both parse (B4 April catch-up shape)', () => {
  const rows = [
    ['Monthly Report'], ['April 2026'], ['B4 Tropicana Valley'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Guest', '1-3 April', 'Airbnb', 2, 1500000, 300000, 1200000],
    ['Total', E, E, E, E, 1500000, 300000, 1200000],
    [],
    ['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT'],
    ['01 Apr 2026', 'Housekeeping', 'B4', 1000000],
    ['TOTAL', E, E, 1000000],
    [],
    ['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT'],
    ['1 Feb 2026', 'Common Area Sharing cost', 'B4', 431399],
    ['1 Feb 2026', 'Pool guy Salary', 'B4', 600000],
    ['TOTAL', E, E, 1031399],
    ['TOTAL PAYOUT', E, -831399],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'April' });
  assert.equal(p.expenses.length, 3, 'both blocks\' expense lines parse');
  assert.equal(p.era_expense_total, 2031399, 'era totals accumulate across blocks');
  assert.equal(p.totals.payout, 1200000 - 2031399);
  assert.ok(!p.flags.includes('unparsed_rows'));
});

test('negative TOTAL PAYOUT (deficit month) parses and reconciles', () => {
  const rows = [
    ['Monthly Report'], ['February 2026'], ['A4 Tropicana Valley'], [],
    ['No', 'Guest Name', 'Date of Stay', 'Booking Platform', 'No. Stay', 'Amount', 'Comission', 'Nett to Owner'],
    [1, 'Artem', '22-24 Feb', 'Airbnb', 2, 3477380, 695476, 2781904],
    ['Total', E, E, E, E, 3477380, 695476, 2781904],
    ['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT'],
    ['01 Feb 2026', 'Expenses lumped', 'A4', 4835899],
    ['TOTAL', E, E, 4835899],
    ['TOTAL PAYOUT', E, '-2,053,995'],
  ];
  const p = parseMonthTab(rows, { tabTitle: 'February' });
  assert.equal(p.era_payout_total, -2053995);
  assert.equal(p.totals.payout, -2053995);
  assert.equal(p.needs_review, false);
});

// ── Carry-forward of negative balances (lib/statements.js) ──────────
const { computeCarryAdjustment, prevPeriodOf } = await import('../lib/statements.js');
console.log('\ncarry-forward:');

test('prevPeriodOf handles year boundary', () => {
  assert.equal(prevPeriodOf('2026-05'), '2026-04');
  assert.equal(prevPeriodOf('2026-01'), '2025-12');
});

test('prior deficit rolls in as a negative adjustment', () => {
  const c = computeCarryAdjustment({ period: '2026-04', payout_total: -8957285, paid_total: 0 }, []);
  assert.ok(c);
  assert.equal(c.amount, -8957285);
  assert.ok(/April 2026/.test(c.description));
});

test('no carry when the prior month was positive or absent', () => {
  assert.equal(computeCarryAdjustment({ period: '2026-04', payout_total: 5000000, paid_total: 0 }, []), null);
  assert.equal(computeCarryAdjustment(null, []), null);
});

test("Era's own \"Minus from …\" line suppresses the auto carry (never double-count)", () => {
  const lines = [{ kind: 'adjustment', description: 'Minus from February ', flags: ['carry_forward'] }];
  assert.equal(computeCarryAdjustment({ period: '2026-02', payout_total: -2053995, paid_total: 0 }, lines), null);
});

test('partial payment against a deficit reduces what carries', () => {
  const c = computeCarryAdjustment({ period: '2026-04', payout_total: -1000000, paid_total: 0 }, []);
  assert.equal(c.amount, -1000000);
  const c2 = computeCarryAdjustment({ period: '2026-04', payout_total: 3000000, paid_total: 3000000 }, []);
  assert.equal(c2, null);
});

// ── Stay-date range parsing (Era's free-text formats) ───────────────
const { parseStayRange } = await import('../lib/statements.js');
const D = (y, m, d) => Date.UTC(y, m - 1, d);
console.log('\nstay-date parsing:');

test('"10-13 June" in a June statement', () => {
  const r = parseStayRange('10-13 June', '2026-06');
  assert.deepEqual([r.start, r.endEx], [D(2026, 6, 10), D(2026, 6, 13)]);
});
test('"25 July - 11 Aug" recorded in JUNE has zero June overlap', () => {
  const r = parseStayRange('25 July - 11 Aug', '2026-06');
  assert.deepEqual([r.start, r.endEx], [D(2026, 7, 25), D(2026, 8, 11)]);
  const overlap = Math.max(0, Math.min(r.endEx, D(2026, 7, 1)) - Math.max(r.start, D(2026, 6, 1))) / 86400000;
  assert.equal(overlap, 0);
});
test('"26 May - 26 June" spans into June correctly', () => {
  const r = parseStayRange('26 May - 26 June', '2026-06');
  assert.deepEqual([r.start, r.endEx], [D(2026, 5, 26), D(2026, 6, 26)]);
});
test('"29 Dec - 6 feb" in a January statement crosses BOTH year ends', () => {
  const r = parseStayRange('29 Dec - 6 feb', '2026-01');
  assert.deepEqual([r.start, r.endEx], [D(2025, 12, 29), D(2026, 2, 6)]);
});
test('"5 May-5June" without spaces, "22-27 arch" typo month', () => {
  const a = parseStayRange('5 May-5June', '2026-05');
  assert.deepEqual([a.start, a.endEx], [D(2026, 5, 5), D(2026, 6, 5)]);
  const b = parseStayRange('22-27 arch', '2026-03');
  assert.deepEqual([b.start, b.endEx], [D(2026, 3, 22), D(2026, 3, 27)]);
});
test('bare "1-18" inherits the statement month; garbage returns null', () => {
  const r = parseStayRange('1-18', '2026-07');
  assert.deepEqual([r.start, r.endEx], [D(2026, 7, 1), D(2026, 7, 18)]);
  assert.equal(parseStayRange('', '2026-07'), null);
  assert.equal(parseStayRange('sometime soon', '2026-07'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
