// ── STAFF PAYROLL SHEET PARSER ───────────────────────────────────────
// Turns one tab of Era's "Staff Salary and Expenses" spreadsheet into a
// structured payroll run. The layout (read from the real sheet, 4 Sep 2026):
//
//   [merged] Staff Salary and Expenses
//   <blank>
//   Era              | Villa manager                 | 11,500,000
//   Ana              | HK Astanine                   |  2,500,000
//   Dian             | Pool A5 & garden              |    800,000
//   Internet         | Haus Canggu                   |    337,500
//   CA management    | A4,5 & B4                     |  2,028,000
//   Water and garbage| Lane and Saturday             |    650,000   ← autocorrect of Saturno
//   Balance from August | Samba                      | 10,000,000
//   [merged] TOTAL   |                               | 54,943,000
//
// Three columns: who or what, a free-text description that carries the role
// and the property, and the amount. A person appears once per property he
// serves (Dian four times), so "payee" is a grouping over lines, not a row.
//
// Same discipline as statement-parser.js: deterministic, every oddity is a
// flag or a failed reconciliation check, never a silently wrong number. The
// registry (staff table) is passed in so the parser can say who a row is,
// whether a vendor has crept onto payroll, and where the sheet disagrees
// with who actually covers a villa.

import crypto from 'node:crypto';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const cellStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();
// Money cell → number. Numeric cells arrive as numbers (UNFORMATTED_VALUE);
// a text fallback tolerates "11,500,000.00" and "1.500.000": a one- or
// two-digit tail after the last separator is a decimal fraction and drops,
// every other separator is a thousands mark.
function cellNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  let s = cellStr(v).replace(/rp|idr|\s/gi, '');
  if (!s || !/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/[.,]\d{1,2}$/, '').replace(/[.,]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// Month token → 0-11, tolerant of truncation ("Sept", "Aug", "Agustus" no).
function monthIdx(token) {
  const t = String(token || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t.length < 3) return -1;
  return MONTHS.findIndex(m => m.startsWith(t.slice(0, 3)) && t.startsWith(m.slice(0, 3)));
}
const periodOf = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;

// "<Month> <Year>" / "<Month>-<yy>" / "<Month>" anywhere in a title.
// Year is optional: Era may label a tab just "September". Returns
// {month, year|null} or null.
export function titleMonthYear(title) {
  const t = cellStr(title);
  const m = t.match(/([A-Za-z]{3,9})\s*[-/ ]?\s*'?(\d{2,4})?\b/);
  if (!m) return null;
  const month = monthIdx(m[1]);
  if (month < 0) return null;
  let year = m[2] ? parseInt(m[2], 10) : null;
  if (year != null && year < 100) year += 2000;
  return { month, year };
}

// ── Property allocation from Era's free text ─────────────────────────
// Phrases are consumed in order so "Lane Haus" never doubles as HAUS Canggu
// and "Haus Unit 2&4" never expands to all four HAUS units.
const LANE = ['lanehaus-1', 'lanehaus-3'];
const HAUS = ['haus-1', 'haus-2', 'haus-4', 'haus-5'];
// Tropicana without a unit code means the Samba-paid Tropicana units. B2, B3,
// B5 and B6 are cleaned but paid outside Samba (Era, 3 Sep 2026).
const TROPICANA_SAMBA = ['tropicana-a4', 'tropicana-a5', 'tropicana-b4'];

export function slugsFor(text) {
  // Commas survive as separators: "Lane, Haus" is two properties, while
  // "Lane Haus" is LaneHAUS.
  let t = ' ' + cellStr(text).toLowerCase().replace(/[./;]+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ') + ' ';
  const out = new Set();
  const take = (re, slugs) => {
    if (!re.test(t)) return false;
    for (const s of slugs) out.add(s);
    t = t.replace(re, ' ');
    return true;
  };
  take(/lane\s*haus|lanehaus|\blane\b/g, LANE);
  take(/\bhaus(?:\s*canggu)?\s*unit\s*2\s*&\s*4\b|\bunit\s*2\s*&\s*4\b/g, ['haus-2', 'haus-4']);
  take(/\bastanine\b/g, ['astanine']);
  // "Saturday" is what Era's keyboard makes of Saturno.
  take(/\bsaturno\b|\bsaturday\b/g, ['villa-saturno']);
  take(/\bhaus(?:\s*canggu)?\b/g, HAUS);
  // Unit codes: "A5", "B4", "A4,5 & B4" (a second bare digit after a comma
  // inherits the letter), "A4 & garden".
  let codes = false;
  t = t.replace(/\b([ab])\s*(\d)(?:,(\d))?\b/g, (_, letter, d1, d2) => {
    codes = true;
    out.add(`tropicana-${letter}${d1}`);
    if (d2) out.add(`tropicana-${letter}${d2}`);
    return ' ';
  });
  if (!codes) take(/\btropicana(?:\s*valley)?\b/g, TROPICANA_SAMBA);
  else t = t.replace(/\btropicana(?:\s*valley)?\b/g, ' ');
  return [...out];
}

// ── Row classification ───────────────────────────────────────────────
const ROLE_RE = [
  [/\bhk\b|house\s*keep|cleaning|cleaner/i, 'housekeeper'],
  [/\bpool\b/i, 'pool'],
  [/garden/i, 'gardener'],
  [/manager/i, 'manager'],
];
function roleOf(desc) {
  for (const [re, role] of ROLE_RE) if (re.test(desc)) return role;
  return null;
}

const CATEGORY_RE = [
  [/balance/i, 'balance'],
  [/\bfrom\b/i, 'receipt'],            // "Era from Romi": money that came in, not out
  [/internet|wifi|electric|\bpln\b|water|garbage|sampah|\bgas\b/i, 'utility'],
  [/laundry/i, 'laundry'],
  [/advance/i, 'advance'],
  [/petty/i, 'petty_cash'],
  [/management|\bca\b|iuran|building|\bipl\b/i, 'building_fee'],
];
function categoryOfLabel(label) {
  for (const [re, cat] of CATEGORY_RE) if (re.test(label)) return cat;
  return null;
}
// Lines Era lists but does not add into her TOTAL: a balance carried from
// last month, money received, and the petty-cash float she holds. They are
// kept as memo lines (visible, never paid out). Verified against the real
// sheet: lines sum to 69,443,000, her TOTAL is 54,943,000, and exactly these
// three (10,000,000 + 2,500,000 + 2,000,000) make up the difference.
export const NON_PAYABLE = new Set(['balance', 'receipt', 'petty_cash']);
export const isPayable = (l) => !NON_PAYABLE.has(l.category);

// People Era pays who are deliberately NOT in the staff registry (the
// registry drives WhatsApp routing, and Era's number must keep routing as
// the team line, never as a housekeeper).
const KNOWN_OUTSIDE_REGISTRY = { era: 'manager' };

const norm = (s) => cellStr(s).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// Who is this row about? Exact name, then first-name match ("Ketut" →
// "Ketut Buda"). Returns {staff|null, name|null}.
export function matchPerson(label, staff = []) {
  const l = norm(label);
  if (!l) return { staff: null, name: null };
  const first = l.split(' ')[0];
  let hit = staff.find(s => norm(s.name) === l)
    || staff.find(s => norm(s.name).split(' ')[0] === first && l.split(' ').length === 1)
    || staff.find(s => norm(s.name) === first);
  if (hit) return { staff: hit, name: hit.name };
  // A bare first name only: "Era from Romi" is a transfer label, not Era's pay.
  if (KNOWN_OUTSIDE_REGISTRY[first] && l.split(' ').length === 1) return { staff: null, name: cellStr(label).split(/\s+/)[0] };
  return { staff: null, name: null };
}

// ── Tab → run ────────────────────────────────────────────────────────
// options.staff: registry rows (id, name, roles, slugs, pay_type, active).
// options.unpaidSlugs: villas whose cleaning is paid outside this sheet.
// Returns null when the tab is not a payroll tab.
export function parsePayrollTab(rows, { tabTitle = '', staff = [], unpaidSlugs = [], today = new Date() } = {}) {
  const grid = (rows || []).map(r => Array.isArray(r) ? r : []);
  const lines = [];
  const unparsed = [];
  let eraTotal = null;
  let balanceHintMonth = -1;
  let dataRows = 0;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const texts = [];
    let amount = null;
    for (const c of row) {
      const n = cellNum(c);
      if (n !== null && typeof c === 'number') { amount = n; continue; }
      const s = cellStr(c);
      if (!s) continue;
      const n2 = cellNum(s);
      if (n2 !== null && /\d/.test(s) && !/[a-z]/i.test(s)) { amount = n2; continue; }
      texts.push(s);
    }
    if (!texts.length && amount === null) continue;                      // blank
    const label = texts[0] || '';
    const desc = texts.slice(1).join(' ');

    if (/^total\b/i.test(label) || /^total\b/i.test(desc)) { eraTotal = amount; continue; }
    if (/salary|expenses/i.test(label) && amount === null && !desc) continue;   // sheet title
    if (amount === null) { unparsed.push({ row: i, cells: row.map(cellStr) }); continue; }
    dataRows++;

    const flags = [];
    const person = matchPerson(label, staff);
    const role = roleOf(desc);
    let category, payee, personName = null, staffId = null, slugs = slugsFor(desc);

    if (person.name && (role || person.staff)) {
      category = 'salary';
      payee = person.name; personName = person.name; staffId = person.staff?.id ?? null;
      if (person.staff && person.staff.pay_type === 'per_job') flags.push('vendor_on_payroll');
      if (!person.staff) flags.push('not_in_registry');
      // Registry coverage check: the sheet pays X for a villa the registry
      // says Y covers (only for role-specific coverage, e.g. housekeepers).
      if (person.staff && role && slugs.length) {
        for (const slug of slugs) {
          const coverers = staff.filter(s => s.active !== false && (s.roles || []).includes(role) && (s.slugs || []).includes(slug));
          if (coverers.length && !coverers.some(s => s.id === person.staff.id)) {
            flags.push('roster_mismatch');
            flags.push(`registry:${coverers.map(s => s.name).join('/')}`);
            break;
          }
        }
      }
    } else {
      category = categoryOfLabel(label) || categoryOfLabel(desc) || 'other';
      payee = label.replace(/\s+/g, ' ').trim();
      if (category === 'other') flags.push('unclassified');
      if (category === 'balance') {
        const m = label.match(/from\s+([a-z]+)/i);
        if (m) balanceHintMonth = monthIdx(m[1]);
      }
      if (/samba/i.test(desc)) slugs = [];
    }
    if (!slugs.length && isPayable({ category }) && category !== 'other' && !/samba/i.test(desc)) flags.push('no_property');
    if (amount === 0) flags.push('zero_amount');

    lines.push({
      category, payee, person_name: personName, staff_id: staffId, role,
      description: desc || null, slugs, amount, flags, source_row: i, position: lines.length,
    });
  }

  if (dataRows < 3) return null;   // not a payroll tab

  // Period: tab title first, then the "Balance from <Month>" hint (+1),
  // else unknown — the caller decides whether to assume the current month.
  const nowY = today.getUTCFullYear(), nowM = today.getUTCMonth();
  let period = null;
  const periodFlags = [];
  const tm = titleMonthYear(tabTitle);
  if (tm) {
    let y = tm.year;
    if (y == null) { y = nowY; if (periodOf(y, tm.month) > periodOf(nowY, nowM)) y -= 1; periodFlags.push('year_assumed'); }
    period = periodOf(y, tm.month);
  } else if (balanceHintMonth >= 0) {
    const m = (balanceHintMonth + 1) % 12;
    let y = nowY + (balanceHintMonth === 11 ? 1 : 0);
    if (periodOf(y, m) > periodOf(nowY, nowM)) y -= 1;
    period = periodOf(y, m);
    periodFlags.push('period_from_balance_hint');
  }

  // Totals + checks. run_total is what gets paid out; memo lines sit beside it.
  const salary_total = lines.filter(l => l.category === 'salary').reduce((a, l) => a + l.amount, 0);
  const run_total = lines.filter(isPayable).reduce((a, l) => a + l.amount, 0);
  const other_total = run_total - salary_total;
  const memo_total = lines.filter(l => !isPayable(l)).reduce((a, l) => a + l.amount, 0);

  const checks = [];
  checks.push({
    name: 'total_matches_sheet', ok: eraTotal == null ? false : Math.abs(run_total - eraTotal) <= 1,
    expected: eraTotal, actual: run_total,
  });
  const vendors = lines.filter(l => l.flags.includes('vendor_on_payroll'));
  checks.push({ name: 'no_vendors_on_payroll', ok: !vendors.length, actual: vendors.map(l => l.payee) });
  const mismatches = lines.filter(l => l.flags.includes('roster_mismatch'));
  checks.push({
    name: 'sheet_matches_registry', ok: !mismatches.length,
    actual: mismatches.map(l => `${l.payee} paid for ${l.slugs.join(', ')}; registry: ${(l.flags.find(f => f.startsWith('registry:')) || '').slice(9)}`),
  });
  // Every salaried housekeeper in the registry should be paid for each villa
  // she covers, unless that villa's cleaning is paid outside Samba.
  const missing = [];
  for (const s of staff) {
    if (s.active === false || s.pay_type !== 'salaried' || !(s.roles || []).includes('housekeeper')) continue;
    for (const slug of s.slugs || []) {
      if (unpaidSlugs.includes(slug)) continue;
      const paid = lines.some(l => l.category === 'salary' && l.role === 'housekeeper' && l.slugs.includes(slug));
      if (!paid) missing.push(`${s.name} · ${slug}`);
    }
  }
  checks.push({ name: 'housekeeping_covered', ok: !missing.length, actual: missing });
  checks.push({ name: 'no_unparsed_rows', ok: !unparsed.length, actual: unparsed.length });

  const needs_review = checks.some(c => !c.ok) || lines.some(l => l.flags.includes('unclassified') || l.flags.includes('not_in_registry'));
  const source_hash = crypto.createHash('sha256').update(JSON.stringify(grid)).digest('hex');

  return {
    period, period_flags: periodFlags, lines,
    totals: { salary_total, other_total, run_total, memo_total },
    era_total: eraTotal,
    reconciliation: { checks, unparsed_rows: unparsed },
    needs_review, source_hash,
  };
}
