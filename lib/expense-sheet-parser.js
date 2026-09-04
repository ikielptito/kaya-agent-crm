// ── EXPENSE SHEET PARSER ─────────────────────────────────────────────
// Era keeps a second kind of sheet beside the monthly reports: a running
// expense ledger per property, expense blocks only, several months per tab
// (LaneHAUS: one tab per year, Jan..Dec blocks) or one tab per month
// (Tropicana B "DOUBLE EIGHT"). Verified layouts, 4 Sep 2026:
//
//   [merged] LANEHAUS PERERENAN            ← property banner (drifts: LANE HAUS)
//   [merged] January 2026                  ← the block's month
//   DATE | DESCRIPTON | VILLA | AMOUNT     ← header drifts: EXPENSESS
//   …expense rows…
//   [merged] TOTAL | … | 5,773,320
//   (blank rows, next block)
//   TOTAL SHARING EXPENSES | | 23,065,948   ← footer: sum of the blocks
//   EACH UNIT EXPENSES     | | 7,688,649    ← footer: Era's own split, ignored
//
//   Tropicana B adds, after the last block:
//   Received payment from vadat | | 7650000  ← money the co-owners paid in
//   Total Balance               | | 8,905,400 ← expenses − received
//
// Output: one entry per month found, each with the same expense shape the
// statement parser produces, so lib/statements.js can drop them straight
// into statement_lines. Receipts are returned as signed adjustments (money
// in) so an expenses-only statement's payout equals Era's "Total Balance".

import crypto from 'node:crypto';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const cellStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();
function cellNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  let s = cellStr(v).replace(/rp|idr|\s/gi, '');
  if (!s || !/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/[.,]\d{1,2}$/, '').replace(/[.,]/g, '');
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
}
const rowText = (row) => row.map(cellStr).join(' ').trim();

function rowMonthYear(row) {
  for (const c of row) {
    const m = cellStr(c).match(/^([a-z]+)\s+(\d{4})\s*$/i);
    if (!m) continue;
    const idx = MONTHS.findIndex(name => name.startsWith(m[1].toLowerCase().slice(0, 3)) && m[1].toLowerCase().startsWith(name.slice(0, 3)));
    if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
  }
  return null;
}
function headerCols(row) {
  const find = (re) => row.findIndex(c => re.test(cellStr(c)));
  const date = find(/^date\s*$/i);
  const desc = find(/descr/i);
  if (date < 0 || desc < 0) return null;
  return { date, desc, villa: find(/^villa\s*$/i), amount: find(/amount|expens/i) };
}

// rows → { months: [{period, expenses, receipts, era_total, checks, source_rows}], footer, unparsed, source_hash }
export function parseExpenseSheetTab(rows, { tabTitle = '' } = {}) {
  const grid = (rows || []).map(r => Array.isArray(r) ? r : []);
  const consumed = new Set();
  const months = [];
  let current = null;        // period announced by the latest month-year row
  const footer = { sharing_total: null, each_unit: null, received: [], total_balance: null };

  const amountOf = (row, cols) => {
    if (cols.amount >= 0 && cellNum(row[cols.amount]) !== null) return cellNum(row[cols.amount]);
    for (let c = Math.max(cols.desc, cols.villa) + 1; c < row.length && c < cols.desc + 6; c++) {
      const n = cellNum(row[c]);
      if (n !== null) return n;
    }
    return null;
  };

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (consumed.has(i)) continue;
    const my = rowMonthYear(row);
    if (my) { current = my; consumed.add(i); continue; }
    const cols = headerCols(row);
    if (!cols) continue;
    consumed.add(i);
    const block = { period: current, expenses: [], receipts: [], era_total: null, source_rows: [i] };
    if (!current) block.flags = ['no_month_header'];
    let blank = 0;
    for (let r = i + 1; r < grid.length; r++) {
      const rr = grid[r];
      const text = rowText(rr);
      if (!text) { if (++blank >= 7) break; continue; }
      blank = 0;
      if (rowMonthYear(rr) || headerCols(rr)) break;      // next block starts (its rows stay unconsumed)
      if (/^total\s*$/i.test(cellStr(rr[0])) || /^total\s*$/i.test(text.replace(/[\d.,\s]+$/, '').trim())) {
        block.era_total = amountOf(rr, cols);
        consumed.add(r); block.source_rows.push(r);
        break;
      }
      if (/sharing|each\s*unit|received|total\s*balance/i.test(text)) break;   // footer reached
      const desc = cellStr(rr[cols.desc]);
      const amount = amountOf(rr, cols);
      if (!desc && amount === null) { consumed.add(r); continue; }
      const flags = [];
      if (!cellStr(rr[cols.date])) flags.push('missing_date');
      if (amount === null) flags.push('missing_amount');
      block.expenses.push({ expense_date: cellStr(rr[cols.date]) || null, description: desc || null, amount: amount || 0, flags, source_row: r });
      consumed.add(r); block.source_rows.push(r);
    }
    const sum = block.expenses.reduce((a, e) => a + e.amount, 0);
    block.checks = [{ name: 'expenses_vs_era_total', ok: block.era_total === null || Math.abs(block.era_total - sum) <= 1, expected: block.era_total, actual: sum }];
    months.push(block);
    current = null;   // a month header serves one block
  }

  // Footer rows and anything else with money in it.
  const unparsed = [];
  grid.forEach((row, r) => {
    if (consumed.has(r)) return;
    const text = rowText(row);
    if (!text) return;
    let value = null;
    for (const c of row) { const n = cellNum(c); if (n !== null && Math.abs(n) >= 1000) { value = n; break; } }
    if (value === null) return;
    if (/sharing\s*expenses/i.test(text)) { footer.sharing_total = value; return; }
    if (/each\s*unit/i.test(text)) { footer.each_unit = value; return; }
    if (/total\s*balance/i.test(text)) { footer.total_balance = value; return; }
    if (/received|payment\s+from|paid\s+by|transfer\s+from/i.test(text)) {
      footer.received.push({ description: row.map(cellStr).find(Boolean), amount: value, source_row: r });
      return;
    }
    if (/^(lane|tropicana|double|villa|haus)/i.test(text) && !/\d{4,}/.test(text)) return;   // property banner
    unparsed.push({ row: r, cells: row.map(cellStr).filter(Boolean) });
  });
  // Receipts belong to the last month on the tab (they sit under it).
  if (footer.received.length && months.length) {
    const last = months[months.length - 1];
    last.receipts = footer.received.map(x => ({ description: x.description, amount: Math.abs(x.amount), flags: ['receipt'], source_row: x.source_row }));
    if (footer.total_balance !== null) {
      const exp = last.expenses.reduce((a, e) => a + e.amount, 0);
      const rec = last.receipts.reduce((a, e) => a + e.amount, 0);
      last.checks.push({ name: 'balance_vs_era_total_balance', ok: Math.abs((exp - rec) - footer.total_balance) <= 1, expected: footer.total_balance, actual: exp - rec });
    }
  }
  if (footer.sharing_total !== null) {
    const all = months.reduce((a, m) => a + m.expenses.reduce((x, e) => x + e.amount, 0), 0);
    footer.sharing_check = { ok: Math.abs(all - footer.sharing_total) <= 1, expected: footer.sharing_total, actual: all };
  }

  if (!months.length) return null;
  return {
    tabTitle, months, footer, unparsed,
    source_hash: crypto.createHash('sha256').update(JSON.stringify(grid)).digest('hex'),
  };
}
