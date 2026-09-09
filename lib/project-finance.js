// Project finance — the Tropicana Valley development as a whole, stored.
//
// Five tables (migrations/2026-09-09-project-finance.sql) mirror the
// workbook Ikiel and Oli ran the project from: a ledger of every rupiah in
// or out, the costs still to pay, the buyers still paying, the loans, and
// the bank balances. This module is the storage layer only: whitelisted
// reads and writes, plus the upsert the portal uses to write each closed
// month's rental income and expenses for the unsold B units. The headline
// maths (how much of the loan is left to pay, given cash, remaining costs,
// receivables and rent) lives in the portal's lib/project-finance.js next to
// the Hostex revenue it needs.
import { getSettingValue, saveSettingValue } from './campaigns.js';
import { sbRows } from './sb-rows.js';

const SETTINGS_KEY = 'project_finance';
const DEFAULTS = {
  fx_usd: 16300,
  rental_group_key: 'tropicana-b2356',
  rental_from: '2025-08',
  projection_months: 3,
  units_total: 14,
  units_unsold: ['B2', 'B3', 'B5', 'B6'],
};

// Table → the columns a client may write. id/project_key/timestamps are
// ours; source/source_ref on the ledger are set by the importer or the
// rental upsert, never by the editor (a manual row is source 'manual').
export const TABLES = {
  ledger: { name: 'project_ledger', cols: ['entry_date', 'direction', 'amount', 'fx_amount', 'fx_currency', 'category', 'description', 'account', 'counterparty', 'unit', 'commitment_id', 'note', 'flags'] },
  commitments: { name: 'project_commitments', cols: ['name', 'category', 'total', 'due_on', 'status', 'note', 'position'] },
  receivables: { name: 'project_receivables', cols: ['buyer', 'units', 'contract_amount', 'currency', 'fx_rate', 'balance_override', 'ledger_match', 'status', 'note', 'position'] },
  loans: { name: 'project_loans', cols: ['key', 'lender', 'principal', 'currency', 'fx_rate', 'interest_rate', 'started_on', 'headline', 'note'] },
  accounts: { name: 'project_accounts', cols: ['name', 'kind', 'counts_as_cash', 'balance', 'balance_as_of', 'note', 'position'] },
};

const NUMERIC = new Set(['amount', 'fx_amount', 'total', 'contract_amount', 'fx_rate', 'balance_override', 'principal', 'interest_rate', 'balance', 'position', 'commitment_id']);
const BOOL = new Set(['headline', 'counts_as_cash']);
const ARR = new Set(['units', 'flags']);

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  if (r.status === 404) throw Object.assign(new Error('project finance tables are missing: run migrations/2026-09-09-project-finance.sql'), { code: 'migration' });
  if (!r.ok) throw new Error(`read ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function sbWrite(db, method, path, body, prefer = 'return=representation') {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...db.sbHeaders, Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method.toLowerCase()} ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return prefer.includes('representation') ? r.json() : null;
}

export async function financeSettings(db) {
  const v = (await getSettingValue(db, SETTINGS_KEY)) || {};
  return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
}
export async function patchFinanceSettings(db, fields = {}) {
  const cur = await financeSettings(db);
  const next = { ...cur };
  for (const k of ['fx_usd', 'projection_months', 'units_total']) if (fields[k] != null && Number.isFinite(Number(fields[k]))) next[k] = Number(fields[k]);
  for (const k of ['rental_group_key', 'rental_from']) if (typeof fields[k] === 'string' && fields[k].trim()) next[k] = fields[k].trim();
  if (Array.isArray(fields.units_unsold)) next.units_unsold = fields.units_unsold.map(s => String(s).trim().toUpperCase()).filter(Boolean);
  await saveSettingValue(db, SETTINGS_KEY, next);
  return next;
}

// Everything the dashboard needs, in one read. The ledger can outgrow a
// PostgREST page, so it goes through sbRows.
export async function financeGet(db, { project_key = 'tropicana' } = {}) {
  const pk = encodeURIComponent(project_key);
  const probe = await fetch(`${db.SUPABASE_URL}/rest/v1/project_ledger?select=id&limit=1`, { headers: db.sbHeaders });
  if (probe.status === 404 || probe.status === 400) return { error: 'migration', message: 'Run migrations/2026-09-09-project-finance.sql in Supabase, then reload.' };
  const [ledger, commitments, receivables, loans, accounts, settings] = await Promise.all([
    sbRows(db.SUPABASE_URL, db.sbHeaders, `project_ledger?project_key=eq.${pk}&select=*&order=entry_date.asc,id.asc`),
    sbGet(db, `project_commitments?project_key=eq.${pk}&select=*&order=position.asc,id.asc`),
    sbGet(db, `project_receivables?project_key=eq.${pk}&select=*&order=position.asc,id.asc`),
    sbGet(db, `project_loans?project_key=eq.${pk}&select=*&order=id.asc`),
    sbGet(db, `project_accounts?project_key=eq.${pk}&select=*&order=position.asc,id.asc`),
    financeSettings(db),
  ]);
  return { project_key, ledger, commitments, receivables, loans, accounts, settings };
}

// Insert (no id) or update (id) one row of one table, whitelisted columns
// only. Returns the stored row.
export async function financePut(db, { table, row = {}, project_key = 'tropicana' } = {}) {
  const t = TABLES[table];
  if (!t) throw new Error(`unknown table: ${table}`);
  const clean = {};
  for (const c of t.cols) {
    if (!(c in row)) continue;
    let v = row[c];
    if (v === '' || v === undefined) v = null;
    if (v != null && NUMERIC.has(c)) { v = Number(v); if (!Number.isFinite(v)) throw new Error(`${c} must be a number`); }
    if (BOOL.has(c)) v = !!v;
    if (ARR.has(c)) {
      v = Array.isArray(v) ? v.map(x => String(x).trim()) : String(v || '').split(',').map(x => x.trim());
      v = v.filter(Boolean).map(x => c === 'units' ? x.toUpperCase() : x.toLowerCase());
    }
    if (v != null && typeof v === 'string') v = v.trim();
    clean[c] = v;
  }
  if (table === 'ledger') {
    if (clean.direction && !['in', 'out'].includes(clean.direction)) throw new Error('direction must be in or out');
    if (clean.amount != null && clean.amount < 0) throw new Error('amount must be positive; use direction for the sign');
    if (clean.entry_date && !/^\d{4}-\d{2}-\d{2}$/.test(clean.entry_date)) throw new Error('entry_date must be YYYY-MM-DD');
  }
  const id = row.id != null ? parseInt(row.id, 10) : null;
  if (id) {
    clean.updated_at = new Date().toISOString();
    const out = await sbWrite(db, 'PATCH', `${t.name}?id=eq.${id}&project_key=eq.${encodeURIComponent(project_key)}`, clean);
    if (!out?.length) throw new Error('row not found');
    return { row: out[0] };
  }
  if (table === 'ledger') { if (!clean.entry_date || !clean.direction || clean.amount == null) throw new Error('entry_date, direction and amount are required'); clean.source = 'manual'; }
  if (table === 'commitments' && !clean.name) throw new Error('name is required');
  if (table === 'receivables' && (!clean.buyer || !clean.ledger_match)) throw new Error('buyer and ledger_match are required');
  if (table === 'loans' && (!clean.key || !clean.lender)) throw new Error('key and lender are required');
  if (table === 'accounts' && !clean.name) throw new Error('name is required');
  const out = await sbWrite(db, 'POST', t.name, { ...clean, project_key });
  return { row: out[0] };
}

export async function financeDelete(db, { table, id, project_key = 'tropicana' } = {}) {
  const t = TABLES[table];
  if (!t) throw new Error(`unknown table: ${table}`);
  const n = parseInt(id, 10);
  if (!n) throw new Error('id required');
  await sbWrite(db, 'DELETE', `${t.name}?id=eq.${n}&project_key=eq.${encodeURIComponent(project_key)}`, undefined, 'return=minimal');
  return { ok: true, deleted: n };
}

// The portal writes each closed month's rent and expenses for the rental
// units as ledger rows keyed by source_ref ('rental:<slug|group>:<YYYY-MM>:
// income|expense'). Re-running replaces amounts; a month that came out zero
// is deleted so it never shows as a phantom line.
export async function financeRentalUpsert(db, { rows = [], project_key = 'tropicana' } = {}) {
  const keep = [], drop = [];
  for (const r of rows) {
    if (!r || !/^rental:[a-z0-9-]+:\d{4}-\d{2}:(income|expense)$/.test(String(r.source_ref || ''))) continue;
    const amount = Math.round(Number(r.amount) || 0);
    if (amount <= 0) { drop.push(r.source_ref); continue; }
    keep.push({
      project_key, source: 'rental', source_ref: r.source_ref,
      entry_date: r.entry_date, direction: r.direction === 'out' ? 'out' : 'in', amount,
      category: r.direction === 'out' ? 'rental_expense' : 'rental_income',
      description: String(r.description || '').slice(0, 200), account: r.account || null,
      counterparty: r.counterparty || null, unit: r.unit || null, updated_at: new Date().toISOString(), flags: [],
    });
  }
  if (keep.length) await sbWrite(db, 'POST', 'project_ledger?on_conflict=source_ref', keep, 'resolution=merge-duplicates,return=minimal');
  for (const ref of drop) await sbWrite(db, 'DELETE', `project_ledger?source_ref=eq.${encodeURIComponent(ref)}`, undefined, 'return=minimal');
  return { upserted: keep.length, removed: drop.length };
}
