// node dev/payroll-parser.test.mjs
// Fixture = Era's real "Staff Salary and Expenses" tab as read on 4 Sep 2026,
// with the registry as it stood the same day (Ketut and Yoga just added).
import assert from 'node:assert/strict';
import { parsePayrollTab, slugsFor, matchPerson, titleMonthYear } from '../lib/payroll-parser.js';

const STAFF = [
  { id: 1, name: 'Gede Baglug', roles: ['housekeeper'], slugs: ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], pay_type: 'salaried', active: true },
  { id: 2, name: 'Naomi', roles: ['housekeeper'], slugs: ['villa-saturno'], pay_type: 'salaried', active: true },
  { id: 3, name: 'Ita', roles: ['housekeeper'], slugs: ['tropicana-a4', 'tropicana-a5', 'tropicana-b4'], pay_type: 'salaried', active: true },
  { id: 4, name: 'Ana', roles: ['housekeeper'], slugs: ['lanehaus-1', 'lanehaus-3'], pay_type: 'salaried', active: true },
  { id: 5, name: 'Putu', roles: ['housekeeper'], slugs: ['haus-1', 'haus-2', 'haus-4', 'haus-5'], pay_type: 'salaried', active: true },
  { id: 6, name: 'Dian', roles: ['pool', 'tukang'], slugs: [], pay_type: 'salaried', active: true },
  { id: 7, name: 'Wayan', roles: ['pool'], slugs: ['villa-saturno', 'astanine'], pay_type: 'salaried', active: true },
  { id: 8, name: 'BTC Electric', roles: ['tukang'], slugs: [], pay_type: 'per_job', active: true },
  { id: 9, name: 'Ketut Buda', roles: ['gardener'], slugs: ['lanehaus-1', 'lanehaus-3'], pay_type: 'salaried', active: true },
  { id: 10, name: 'Yoga', roles: ['gardener'], slugs: ['villa-saturno'], pay_type: 'salaried', active: true },
];
const UNPAID = ['haus-1', 'haus-2', 'haus-4', 'haus-5', 'tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'];

const ROWS = [
  ['Staff Salary and Expenses', '', ''],
  ['', '', ''],
  ['Era', 'Villa manager', 11500000],
  ['Ana', 'HK Astanine ', 2500000],
  ['Wayan', 'Pool Astanine ', 850000],
  ['Ana', 'HK Lane Haus', 1500000],
  ['Ketut', 'Gardener Lanehaus ', 800000],
  ['Dian', 'Pool Lanehaus ', 1000000],
  ['Putu', 'HK A5', 1000000],
  ['Dian', 'Pool A5 & garden ', 800000],
  ['Putu', 'HK A4', 1000000],
  ['Dian', 'Pool A4 & garden ', 800000],
  ['Putu', 'HK B4', 1000000],
  ['Dian', 'Pool B4 & garden ', 800000],
  ['Naomi', 'HK Saturno ', 2000000],
  ['Yoga', 'Gardener Saturno ', 800000],
  ['Wayan', 'Pool Saturno ', 600000],
  ['Internet ', 'Haus Canggu', 337500],
  ['Internet ', 'Lane Haus', 557500],
  ['Advance Payment ', 'Haus Canggu', 6920000],
  ['CA management ', 'A4,5 & B4', 2028000],
  ['Era from Romi', 'Haus Unit 2&4', 2500000],
  ['Water and garbage ', 'Lane and Saturday ', 650000],
  ['Laundry ', 'Lane, Haus, Tropicana, Astanine, Saturno ', 5000000],
  ['Balance from August ', 'Samba', 10000000],
  ['Petty Cash', 'Samba', 2000000],
  ['Electricity ', 'Haus, lane and Tropicana ', 12500000],
  ['TOTAL', '', 54943000],
];

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('slugs: Lane Haus is LaneHAUS, not HAUS', () => {
  assert.deepEqual(slugsFor('HK Lane Haus').sort(), ['lanehaus-1', 'lanehaus-3']);
  assert.deepEqual(slugsFor('Pool Lanehaus').sort(), ['lanehaus-1', 'lanehaus-3']);
});
t('slugs: Haus Canggu is the four HAUS units', () => {
  assert.deepEqual(slugsFor('Haus Canggu').sort(), ['haus-1', 'haus-2', 'haus-4', 'haus-5']);
});
t('slugs: Haus Unit 2&4 is exactly those two', () => {
  assert.deepEqual(slugsFor('Haus Unit 2&4').sort(), ['haus-2', 'haus-4']);
});
t('slugs: Saturday is Saturno, Lane and Saturday is both', () => {
  assert.deepEqual(slugsFor('Lane and Saturday').sort(), ['lanehaus-1', 'lanehaus-3', 'villa-saturno']);
});
t('slugs: A4,5 & B4 expands the shared letter', () => {
  assert.deepEqual(slugsFor('A4,5 & B4').sort(), ['tropicana-a4', 'tropicana-a5', 'tropicana-b4']);
});
t('slugs: Pool A5 & garden is one unit', () => {
  assert.deepEqual(slugsFor('Pool A5 & garden'), ['tropicana-a5']);
});
t('slugs: bare Tropicana means the Samba-paid units; Haus, lane and Tropicana', () => {
  assert.deepEqual(slugsFor('Haus, lane and Tropicana').sort(),
    ['haus-1', 'haus-2', 'haus-4', 'haus-5', 'lanehaus-1', 'lanehaus-3', 'tropicana-a4', 'tropicana-a5', 'tropicana-b4']);
});
t('slugs: the laundry line covers everything incl. Astanine', () => {
  const s = slugsFor('Lane, Haus, Tropicana, Astanine, Saturno');
  assert.ok(s.includes('astanine') && s.includes('villa-saturno') && s.includes('haus-1') && s.includes('lanehaus-3') && s.includes('tropicana-b4'));
  assert.equal(s.length, 11);
});
t('slugs: Samba is nobody (overhead)', () => assert.deepEqual(slugsFor('Samba'), []));

t('person: Ketut matches Ketut Buda; Era is known outside the registry; Internet is nobody', () => {
  assert.equal(matchPerson('Ketut', STAFF).staff.id, 9);
  assert.equal(matchPerson('Era', STAFF).name, 'Era');
  assert.equal(matchPerson('Era', STAFF).staff, null);
  assert.equal(matchPerson('Internet ', STAFF).name, null);
  assert.equal(matchPerson('Era from Romi', STAFF).name, null);
});

t('title: month and year forms', () => {
  assert.deepEqual(titleMonthYear('September 2026'), { month: 8, year: 2026 });
  assert.deepEqual(titleMonthYear('Sept 26'), { month: 8, year: 2026 });
  assert.deepEqual(titleMonthYear('Sheet1'), null);
  assert.deepEqual(titleMonthYear('August'), { month: 7, year: null });
});

const today = new Date('2026-09-04T00:00:00Z');
const parsed = parsePayrollTab(ROWS, { tabTitle: 'Sheet1', staff: STAFF, unpaidSlugs: UNPAID, today });

t('parses every data row and the sheet total', () => {
  assert.equal(parsed.lines.length, 25);
  assert.equal(parsed.era_total, 54943000);
  assert.equal(parsed.totals.run_total, 54943000);
  assert.ok(parsed.reconciliation.checks.find(c => c.name === 'total_matches_sheet').ok);
});
t('salary vs other split', () => {
  assert.equal(parsed.totals.salary_total, 26950000);
  assert.equal(parsed.totals.other_total, 27993000);   // payable non-salary: 54,943,000 - 26,950,000
  assert.equal(parsed.totals.memo_total, 14500000);
});
t('period comes from the Balance-from hint when the title has no month', () => {
  assert.equal(parsed.period, '2026-09');
  assert.ok(parsed.period_flags.includes('period_from_balance_hint'));
});
t('period prefers the tab title', () => {
  const p = parsePayrollTab(ROWS, { tabTitle: 'August 2026', staff: STAFF, today });
  assert.equal(p.period, '2026-08');
  assert.deepEqual(p.period_flags, []);
});
t('Dian is four lines, one payee', () => {
  const dian = parsed.lines.filter(l => l.payee === 'Dian');
  assert.equal(dian.length, 4);
  assert.equal(dian.reduce((a, l) => a + l.amount, 0), 3400000);
  assert.ok(dian.every(l => l.staff_id === 6 && l.role === 'pool'));
});
t('Putu on the Tropicana units is a roster mismatch naming Ita', () => {
  const putu = parsed.lines.filter(l => l.payee === 'Putu');
  assert.equal(putu.length, 3);
  assert.ok(putu.every(l => l.flags.includes('roster_mismatch') && l.flags.includes('registry:Ita')));
  const chk = parsed.reconciliation.checks.find(c => c.name === 'sheet_matches_registry');
  assert.equal(chk.ok, false);
  assert.equal(chk.actual.length, 3);
});
t('memo lines: balance, receipt and petty cash are listed but not paid out', () => {
  const memo = parsed.lines.filter(l => ['balance', 'receipt', 'petty_cash'].includes(l.category));
  assert.deepEqual(memo.map(l => l.payee).sort(), ['Balance from August', 'Era from Romi', 'Petty Cash']);
  assert.equal(memo.reduce((a, l) => a + l.amount, 0), 14500000);
});
t('Era is salary without a registry id; Era from Romi is a receipt', () => {
  const era = parsed.lines.find(l => l.payee === 'Era');
  assert.equal(era.category, 'salary');
  assert.equal(era.role, 'manager');
  assert.equal(era.staff_id, null);
  const romi = parsed.lines.find(l => l.payee === 'Era from Romi');
  assert.equal(romi.category, 'receipt');
  assert.ok(!romi.flags.includes('unclassified'));
  assert.deepEqual(romi.slugs.sort(), ['haus-2', 'haus-4']);
});
t('categories for the non-people rows', () => {
  const cat = (p) => parsed.lines.find(l => l.payee === p).category;
  assert.equal(cat('Internet'), 'utility');
  assert.equal(cat('Electricity'), 'utility');
  assert.equal(cat('Water and garbage'), 'utility');
  assert.equal(cat('Laundry'), 'laundry');
  assert.equal(cat('Advance Payment'), 'advance');
  assert.equal(cat('CA management'), 'building_fee');
  assert.equal(cat('Petty Cash'), 'petty_cash');
  assert.equal(cat('Balance from August'), 'balance');
});
t('housekeeping coverage: Ita is owed for A4/A5/B4 but the sheet pays them under Putu, so covered; HAUS and Tropicana B are exempt', () => {
  const chk = parsed.reconciliation.checks.find(c => c.name === 'housekeeping_covered');
  assert.equal(chk.ok, true, JSON.stringify(chk));
});
t('a missing housekeeping line is reported', () => {
  const rows = ROWS.filter(r => !(r[0] === 'Naomi'));
  const p = parsePayrollTab(rows, { tabTitle: 'September 2026', staff: STAFF, unpaidSlugs: UNPAID, today });
  const chk = p.reconciliation.checks.find(c => c.name === 'housekeeping_covered');
  assert.deepEqual(chk.actual, ['Naomi · villa-saturno']);
  assert.equal(p.needs_review, true);
});
t('a vendor on the sheet fails the vendor check', () => {
  const rows = [...ROWS.slice(0, -1), ['BTC Electric', 'AC service Haus Canggu', 1500000], ['TOTAL', '', 56443000]];
  const p = parsePayrollTab(rows, { tabTitle: 'September 2026', staff: STAFF, unpaidSlugs: UNPAID, today });
  assert.equal(p.reconciliation.checks.find(c => c.name === 'no_vendors_on_payroll').ok, false);
  assert.ok(p.lines.find(l => l.payee === 'BTC Electric').flags.includes('vendor_on_payroll'));
});
t('a total that disagrees with the lines fails the total check', () => {
  const rows = [...ROWS.slice(0, -1), ['TOTAL', '', 54000000]];   // the real sheet's total is 54,943,000
  const p = parsePayrollTab(rows, { tabTitle: 'September 2026', staff: STAFF, unpaidSlugs: UNPAID, today });
  const chk = p.reconciliation.checks.find(c => c.name === 'total_matches_sheet');
  assert.equal(chk.ok, false);
  assert.equal(chk.expected, 54000000);
});
t('formatted-text amounts still parse', () => {
  const rows = ROWS.map(r => [r[0], r[1], typeof r[2] === 'number' ? r[2].toLocaleString('en-US', { minimumFractionDigits: 2 }) : r[2]]);
  const p = parsePayrollTab(rows, { tabTitle: 'September 2026', staff: STAFF, unpaidSlugs: UNPAID, today });
  assert.equal(p.totals.run_total, 54943000);
  assert.equal(p.era_total, 54943000);
});
t('a non-payroll tab returns null', () => {
  assert.equal(parsePayrollTab([['Notes'], ['hello', 'world']], { tabTitle: 'Notes', staff: STAFF }), null);
});
t('hash is stable and changes with content', () => {
  const a = parsePayrollTab(ROWS, { tabTitle: 'x', staff: STAFF, today }).source_hash;
  const b = parsePayrollTab(ROWS, { tabTitle: 'x', staff: STAFF, today }).source_hash;
  const c = parsePayrollTab([...ROWS.slice(0, 5), ...ROWS.slice(6)], { tabTitle: 'x', staff: STAFF, today }).source_hash;
  assert.equal(a, b); assert.notEqual(a, c);
});

console.log(`\n${n} payroll parser tests passed`);
