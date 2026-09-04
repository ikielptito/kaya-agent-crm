// node dev/expense-sheet-parser.test.mjs
// Fixtures are cut from the real sheets as read on 4 Sep 2026: LaneHAUS
// (several months per tab, "EACH UNIT" footer) and Tropicana B "DOUBLE
// EIGHT" (one month per tab, received-payment footer).
import assert from 'node:assert/strict';
import { parseExpenseSheetTab } from '../lib/expense-sheet-parser.js';

const LANE = [
  ['LANEHAUS PERERENAN'], ['January 2026'], [],
  ['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT'],
  ['01 Jan 2026', 'Housekeeping', 'Lane Haus Canggu', 1800000],
  ['01 Jan 2026', 'Pool guy', 'Lane Haus Canggu', 1000000],
  ['01 Jan 2026', 'PDAM', 'Lane Haus Canggu', 80820],
  ['06 Jan 2026', 'Electricity', 'Lane Haus Canggu', 1003500],
  ['TOTAL', '', '', 3884320],
  [], [], [], [],
  ['LANE HAUS PERERENAN'], ['March 2026'], [],
  ['DATE', 'DESCRIPTON', 'VILLA', 'EXPENSESS'],
  ['28 Feb 2026', 'Garbage', 'Lane Haus Pererenan', 250000],
  ['01 Mar 2026', 'Housekeeping salary', 'Lane Haus Pererenan', 1500000],
  ['02 Mar 2026', 'Poll and garden electricity', 'Lane Haus Pererenan', 503500],
  ['TOTAL', '', '', 2253500],
  [], [],
  ['LANE HAUS PERERENAN'], ['April 2026'], [],
  ['DATE', 'DESCRIPTON', 'VILLA', 'EXPENSESS'],
  ['01 Apr 2026', 'Electricity', 'Lanehaus pererenan', 1003500],
  ['20 Apr 2026', 'Garden light', 'Lanehaus pererenan', 270000],
  ['TOTAL', '', '', 1273500],
  [], [],
  ['TOTAL SHARING EXPENSES', '', 7411320],
  ['EACH UNIT EXPENSES', '', 2470440],
];

const DOUBLE_EIGHT = [
  ['DOUBLE EIGHT', 'DOUBLE EIGHT', 'DOUBLE EIGHT', '', '', ''],
  ['August 2026', 'August 2026', 'August 2026', '', '', ''],
  [],
  ['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT', '', ''],
  ['06 Aug 2026', 'Electricity B5', 'Double Eight', 1003500, '', ''],
  ['31 Aug 2026', 'Laundry B5', 'Double Eight', 425000, '', 425],
  ['01 Sep 2026', 'Housekeeping Salary', 'Double Eight', 3800000, '', ''],
  ['01 Sep 2026', 'Pool Salary', 'Double Eight', 2400000, '', ''],
  ['TOTAL', 'TOTAL', 'TOTAL', 7628500, '', ''],
  [],
  ['Received payment from vadat', '', 7650000, '', '', ''],
  ['Total Balance', '', -21500, '', '', ''],
];

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const lane = parseExpenseSheetTab(LANE, { tabTitle: '2026' });
t('LaneHAUS: three months from one tab, each with its own period', () => {
  assert.deepEqual(lane.months.map(m => m.period), ['2026-01', '2026-03', '2026-04']);
});
t('LaneHAUS: every block reconciles to its TOTAL and the EXPENSESS header drift is fine', () => {
  assert.ok(lane.months.every(m => m.checks[0].ok), JSON.stringify(lane.months.map(m => m.checks)));
  assert.equal(lane.months[1].expenses.length, 3);
  assert.equal(lane.months[1].era_total, 2253500);
});
t('LaneHAUS: a February-dated line inside the March block stays in March', () => {
  assert.equal(lane.months[1].expenses[0].description, 'Garbage');
});
t('LaneHAUS: the footer is read, not turned into expenses; EACH UNIT is ignored', () => {
  assert.equal(lane.footer.sharing_total, 7411320);
  assert.equal(lane.footer.each_unit, 2470440);
  assert.ok(lane.footer.sharing_check.ok);
  assert.equal(lane.unparsed.length, 0);
  assert.ok(lane.months.every(m => m.receipts.length === 0));
});

const de = parseExpenseSheetTab(DOUBLE_EIGHT, { tabTitle: 'August' });
t('Double Eight: one month, side-column noise ignored', () => {
  assert.equal(de.months.length, 1);
  assert.equal(de.months[0].period, '2026-08');
  assert.equal(de.months[0].expenses.length, 4);
  assert.equal(de.months[0].era_total, 7628500);
  assert.ok(de.months[0].checks[0].ok);
});
t('Double Eight: the received payment is a receipt on the month, and the balance check matches Era', () => {
  assert.deepEqual(de.months[0].receipts.map(r => r.amount), [7650000]);
  const chk = de.months[0].checks.find(c => c.name === 'balance_vs_era_total_balance');
  assert.ok(chk && chk.ok, JSON.stringify(chk));
  assert.equal(de.unparsed.length, 0);
});
t('a tab with no expense blocks returns null', () => {
  assert.equal(parseExpenseSheetTab([['Notes'], ['hello']], { tabTitle: 'Sheet2' }), null);
});
t('a block without a month header is flagged', () => {
  const p = parseExpenseSheetTab([['DATE', 'DESCRIPTON', 'VILLA', 'AMOUNT'], ['01 Jan 2026', 'X', 'Y', 1000], ['TOTAL', '', '', 1000]]);
  assert.equal(p.months[0].period, null);
  assert.deepEqual(p.months[0].flags, ['no_month_header']);
});

console.log(`\n${n} expense-sheet parser tests passed`);
