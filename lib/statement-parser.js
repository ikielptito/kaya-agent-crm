// ── MONTHLY REPORT TAB PARSER ────────────────────────────────────────
// Turns one tab of Era's per-property report spreadsheet into a structured
// statement draft. The layout (verified against the real 2026 sheets):
//
//   [merged] Monthly Report
//   [merged] <Month Year>
//   [merged] <Unit name>
//   No | Guest Name | Date of Stay | Booking Platform | No. Stay | Amount | Comission | Nett to Owner
//   …booking rows…
//   [merged] Total | … | Σamount | Σcommission | Σnett
//   (repeated per unit for multi-unit properties)
//   [merged] <PROPERTY> EXPENSES        ← heading drifts: EXPENSES/EXPENSESS/absent
//   DATE | DESCRIPTON | VILLA | AMOUNT  ← header labels drift too
//   …expense rows…
//   [merged] TOTAL | … | Σ
//   TOTAL PAYOUT | … | <number>
//
// Era is human: side mini-tables live in far-right columns, owner stays have
// zero amounts, dates go missing, the tab label can lag the month inside the
// sheet, and her arithmetic occasionally disagrees with her line items. The
// parser is deterministic and column-window-scoped (anything outside the
// detected header's columns is invisible), and every oddity becomes a flag or
// a failed reconciliation check — NEVER a silently wrong number. A statement
// with any failed check is marked needs_review for Ikiel to eyeball.

import crypto from 'node:crypto';

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const cellStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();
// Money cell → number. Numeric cells arrive as real numbers
// (UNFORMATTED_VALUE); text fallback strips currency noise.
function cellNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = cellStr(v).replace(/[Rp.,\s]/gi, '');
  if (!s || !/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}
const rowText = (row) => row.map(cellStr).join(' ').trim();

// '<Month Year>' anywhere in the row → {month: 0-11, year}
function rowMonthYear(row) {
  for (const c of row) {
    const m = cellStr(c).match(/^([a-z]+)\s+(\d{4})\s*$/i);
    if (!m) continue;
    const idx = MONTHS.findIndex(name => name.startsWith(m[1].toLowerCase().slice(0, 3)) && m[1].toLowerCase().startsWith(name.slice(0, 3)));
    if (idx >= 0) return { month: idx, year: parseInt(m[2], 10) };
  }
  return null;
}

// Booking header row → column map, or null.
function bookingHeaderCols(row) {
  const find = (re) => row.findIndex(c => re.test(cellStr(c)));
  const guest = find(/guest\s*nam/i);
  const amount = find(/^amount\s*$/i);
  const nett = find(/nett?\s*to\s*owner|^nett?\s*$/i);
  if (guest < 0 || (amount < 0 && nett < 0)) return null;
  return {
    no: find(/^no\.?\s*$/i),
    guest,
    dates: find(/date\s*of\s*stay/i),
    platform: find(/platform/i),
    nights: find(/no\.?\s*stay|night/i),
    amount,
    commission: find(/comm?iss?ion/i),
    nett,
  };
}

// Expense header row → column map, or null. Labels drift (DESCRIPTON,
// EXPENSESS, missing amount header), so DATE + a description-ish column is
// enough; the amount column falls back to "first numeric right of VILLA".
function expenseHeaderCols(row) {
  const find = (re) => row.findIndex(c => re.test(cellStr(c)));
  const date = find(/^date\s*$/i);
  const desc = find(/descr/i);
  if (date < 0 || desc < 0) return null;
  return {
    date, desc,
    villa: find(/^villa\s*$/i),
    amount: find(/amount|expens/i),
  };
}

export function parseMonthTab(rows, { tabTitle = '' } = {}) {
  const flags = new Set();
  const checks = [];
  const consumed = new Set();     // row indexes the parser accounted for
  const check = (name, expected, actual) => {
    const ok = expected === null || actual === null || Math.abs(expected - actual) <= 1;
    checks.push({ name, ok, expected, actual });
    return ok;
  };

  // ── Period: majority of in-sheet '<Month Year>' rows (they carry the
  // year; the tab label often doesn't). Tab label used as a cross-check.
  const monthVotes = new Map();
  rows.forEach((row) => {
    const my = rowMonthYear(row);
    if (my) monthVotes.set(`${my.year}-${String(my.month + 1).padStart(2, '0')}`, (monthVotes.get(`${my.year}-${String(my.month + 1).padStart(2, '0')}`) || 0) + 1);
  });
  const period = [...monthVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const tabMonth = MONTHS.findIndex(name => cellStr(tabTitle).toLowerCase().startsWith(name.slice(0, 3)));
  if (period && tabMonth >= 0 && parseInt(period.slice(5), 10) !== tabMonth + 1) flags.add('period_mismatch');

  // ── Booking blocks ────────────────────────────────────────────────
  const units = [];
  let maxCol = 0;                 // rightmost column any detected table uses
  for (let i = 0; i < rows.length; i++) {
    const cols = bookingHeaderCols(rows[i] || []);
    if (!cols) continue;
    consumed.add(i);
    maxCol = Math.max(maxCol, cols.nett, cols.amount, cols.commission);

    // Unit name: nearest preceding non-empty row that isn't the block's
    // boilerplate ('Monthly Report') or its month-year line.
    let unitName = '';
    for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
      const t = cellStr((rows[k] || [])[0]) || rowText((rows[k] || []).slice(0, cols.nett + 1));
      if (!t) continue;
      consumed.add(k);
      if (/monthly\s*report/i.test(t) || rowMonthYear(rows[k])) continue;
      unitName = t;
      break;
    }

    const bookings = [];
    let eraTotal = null;
    let blank = 0;
    for (let r = i + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const windowText = rowText(row.slice(0, cols.nett + 1));
      if (!windowText) { if (++blank >= 3) break; continue; }
      blank = 0;
      if (/^total\s*$/i.test(cellStr(row[0])) || /^total\s*$/i.test(windowText)) {
        eraTotal = {
          amount: cellNum(row[cols.amount]),
          commission: cols.commission >= 0 ? cellNum(row[cols.commission]) : null,
          nett: cellNum(row[cols.nett]),
        };
        consumed.add(r);
        break;
      }
      if (bookingHeaderCols(row) || expenseHeaderCols(row) || /expense/i.test(cellStr(row[0]))) { r--; break; }

      const guest = cols.guest >= 0 ? cellStr(row[cols.guest]) : '';
      const amount = cols.amount >= 0 ? cellNum(row[cols.amount]) : null;
      const nett = cols.nett >= 0 ? cellNum(row[cols.nett]) : null;
      // Template filler: no guest and no money (the pre-formatted `0 | 0`
      // rows Era leaves in place) — skip without ceremony.
      if (!guest && !amount && !nett) { consumed.add(r); continue; }
      const commission = cols.commission >= 0 ? cellNum(row[cols.commission]) : null;
      const lineFlags = [];
      if (guest && !amount && !nett) lineFlags.push('zero_amount');       // owner stay
      if (cols.dates >= 0 && !cellStr(row[cols.dates])) lineFlags.push('missing_date');
      if (amount !== null && commission !== null && nett !== null && Math.abs((amount - commission) - nett) > 1) {
        lineFlags.push('commission_mismatch');
      }
      bookings.push({
        guest_name: guest || null,
        stay_dates: cols.dates >= 0 ? cellStr(row[cols.dates]) || null : null,
        platform: cols.platform >= 0 ? cellStr(row[cols.platform]) || null : null,
        nights: cols.nights >= 0 ? cellNum(row[cols.nights]) : null,
        amount: amount || 0, commission: commission || 0, nett: nett || 0,
        flags: lineFlags, source_row: r,
      });
      consumed.add(r);
    }
    units.push({ unit_name: unitName || null, bookings, era_total: eraTotal });
    if (eraTotal) {
      check(`bookings_nett_vs_era_total${unitName ? ` (${unitName})` : ''}`,
        eraTotal.nett, bookings.reduce((a, b) => a + b.nett, 0));
    }
  }

  // ── Expense block ─────────────────────────────────────────────────
  const expenses = [];
  let eraExpenseTotal = null;
  for (let i = 0; i < rows.length; i++) {
    const cols = expenseHeaderCols(rows[i] || []);
    if (!cols) continue;
    consumed.add(i);
    if (i > 0 && /expense/i.test(rowText(rows[i - 1] || []))) consumed.add(i - 1);
    const amtCol = (row) => {
      if (cols.amount >= 0 && cellNum(row[cols.amount]) !== null) return cellNum(row[cols.amount]);
      // Header for the amount column is sometimes missing entirely — take
      // the first numeric cell right of the description column.
      for (let c = Math.max(cols.desc, cols.villa) + 1; c < row.length && c < cols.desc + 6; c++) {
        const n = cellNum(row[c]);
        if (n !== null) return n;
      }
      return null;
    };
    maxCol = Math.max(maxCol, cols.amount >= 0 ? cols.amount : cols.desc + 3);
    let blank = 0;
    for (let r = i + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const windowText = rowText(row.slice(0, Math.max(cols.desc, cols.villa, cols.amount) + 3));
      if (!windowText) { if (++blank >= 3) break; continue; }
      blank = 0;
      if (/^total\s*$/i.test(cellStr(row[0])) || /^total\s*$/i.test(windowText.replace(/[\d.,\s]+$/, '').trim())) {
        eraExpenseTotal = amtCol(row);
        consumed.add(r);
        break;
      }
      if (/total\s*payout/i.test(windowText)) { r--; break; }
      const desc = cellStr(row[cols.desc]);
      const amount = amtCol(row);
      if (!desc && amount === null) { consumed.add(r); continue; }
      const lineFlags = [];
      if (!cellStr(row[cols.date])) lineFlags.push('missing_date');
      if (amount === null) lineFlags.push('missing_amount');
      expenses.push({
        expense_date: cellStr(row[cols.date]) || null,
        description: desc || null,
        amount: amount || 0,
        flags: lineFlags, source_row: r,
      });
      consumed.add(r);
    }
    break;   // one expense block per tab
  }

  // ── TOTAL PAYOUT ──────────────────────────────────────────────────
  let eraPayoutTotal = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] || [];
    if (!row.some(c => /total\s*payout/i.test(cellStr(c)))) continue;
    for (const c of row) { const n = cellNum(c); if (n !== null && n !== 0) { eraPayoutTotal = n; break; } }
    if (eraPayoutTotal === null) for (const c of row) { const n = cellNum(c); if (n !== null) { eraPayoutTotal = n; break; } }
    consumed.add(i);
    break;
  }

  // Not a report tab at all (template/scratch tab): bail out.
  if (!units.length && eraPayoutTotal === null) return null;

  // ── Reconciliation ────────────────────────────────────────────────
  const nettSum = units.reduce((a, u) => a + u.bookings.reduce((x, b) => x + b.nett, 0), 0);
  const expSum = expenses.reduce((a, e) => a + e.amount, 0);
  if (eraExpenseTotal !== null) check('expenses_vs_era_total', eraExpenseTotal, expSum);
  if (eraPayoutTotal !== null) check('payout_vs_nett_minus_expenses', eraPayoutTotal, nettSum - expSum);
  if (!units.length) { flags.add('no_booking_block'); }
  if (eraPayoutTotal === null) { flags.add('no_total_payout'); }

  // Money-looking rows inside the tables' column span the parser didn't
  // account for (side tables in far-right columns are outside maxCol and
  // stay invisible by design). These go to the LLM fallback / Ikiel.
  const unparsed = [];
  rows.forEach((row, r) => {
    if (consumed.has(r)) return;
    const windowCells = row.slice(0, maxCol + 1);
    if (rowMonthYear(row) || /monthly\s*report/i.test(rowText(windowCells))) return;
    const hasMoney = windowCells.some(c => { const n = cellNum(c); return n !== null && Math.abs(n) >= 1000; });
    if (hasMoney) unparsed.push({ row: r, cells: windowCells.map(cellStr).filter(Boolean) });
  });
  if (unparsed.length) flags.add('unparsed_rows');

  const needsReview = checks.some(c => !c.ok) || flags.has('no_booking_block')
    || flags.has('no_total_payout') || flags.has('unparsed_rows') || flags.has('period_mismatch')
    || units.some(u => u.bookings.some(b => b.flags.length && !(b.flags.length === 1 && b.flags[0] === 'zero_amount')));

  return {
    period, tabTitle,
    units, expenses,
    era_expense_total: eraExpenseTotal,
    era_payout_total: eraPayoutTotal,
    totals: {
      gross: units.reduce((a, u) => a + u.bookings.reduce((x, b) => x + b.amount, 0), 0),
      commission: units.reduce((a, u) => a + u.bookings.reduce((x, b) => x + b.commission, 0), 0),
      nett: nettSum,
      expenses: expSum,
      payout: nettSum - expSum,
    },
    flags: [...flags],
    reconciliation: { checks, unparsed_rows: unparsed },
    needs_review: needsReview,
    source_hash: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
