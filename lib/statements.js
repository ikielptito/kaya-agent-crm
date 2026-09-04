// ── OWNER STATEMENTS ORCHESTRATION ───────────────────────────────────
// The lifecycle engine for monthly payout statements (Samba Realty-managed
// villas): sync Era's report sheets into draft statements, publish (freeze +
// Hostex snapshot), notify owners via Maya, mark paid with proof.
//
// Non-clobber contract (the whole point of this module):
//   • a DRAFT Ikiel hasn't touched follows Era's sheet automatically
//   • a DRAFT with manual edits is never overwritten — sync flags
//     source_changed and Ikiel chooses "re-parse (discard my edits)"
//   • a PUBLISHED/PAID statement is IMMUTABLE — a later sheet edit writes
//     `discrepancy` and alerts, never touches the numbers the owner saw
//
// db = { SUPABASE_URL, sbHeaders } — the same shape lib/campaigns.js uses.

import crypto from 'node:crypto';
import { listTabs, getTabValues, getFileMeta, sheetsConfigured } from './sheets.js';
import { parseMonthTab } from './statement-parser.js';
import { parseExpenseSheetTab } from './expense-sheet-parser.js';
import { statementToken } from './tokens.js';
import { claimedGroupKeys } from './onboarded.js';
import { postToTelegram } from './telegram.js';
import { getSettingValue, saveSettingValue, resolveCampaign, isCampaignPaused, noteRun } from './campaigns.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const PORTAL_BASE = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';
const TEMPLATE_NAME = 'samba_owner_statement_v1';
const PROOF_BUCKET = 'payout-proofs';
const SYNC_STATE_KEY = 'statement_sync_state';

// ── Small PostgREST helpers ─────────────────────────────────────────
async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPost(db, path, body, prefer = 'return=representation') {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`insert ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return prefer.includes('representation') ? r.json() : null;
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patch ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function sbDelete(db, path) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: db.sbHeaders });
}

const nowIso = () => new Date().toISOString();
const fmtIDR = (n) => `IDR ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export function periodLabel(period) {
  const [y, m] = String(period || '').split('-').map(Number);
  if (!y || !m) return String(period || '');
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export async function listGroups(db, { activeOnly = true } = {}) {
  const rows = await sbGet(db, `statement_groups?select=*&order=key.asc${activeOnly ? '&active=eq.true' : ''}`);
  return Array.isArray(rows) ? rows : [];
}

// ── Parsed tab → statement_lines rows ───────────────────────────────
// Every row carries the FULL column set (nulls where a kind has no value):
// PostgREST bulk inserts reject arrays whose objects have differing keys
// (PGRST102 "All object keys must match").
const LINE_DEFAULTS = {
  kind: null, unit_name: null, position: 0,
  guest_name: null, stay_dates: null, platform: null, nights: null,
  amount: null, commission: null, nett: null,
  expense_date: null, description: null,
  flags: [], source_row: null,
};
const fullLine = (l) => ({ ...LINE_DEFAULTS, ...l });

function linesFromParse(parsed) {
  const lines = [];
  let pos = 0;
  for (const u of parsed.units) {
    for (const b of u.bookings) {
      lines.push(fullLine({
        kind: 'booking', unit_name: u.unit_name, position: pos++,
        guest_name: b.guest_name, stay_dates: b.stay_dates, platform: b.platform,
        nights: b.nights, amount: b.amount, commission: b.commission, nett: b.nett,
        flags: b.flags, source_row: b.source_row,
      }));
    }
  }
  for (const e of parsed.expenses) {
    lines.push(fullLine({
      kind: 'expense', position: pos++,
      expense_date: e.expense_date, description: e.description, amount: e.amount,
      flags: e.flags, source_row: e.source_row,
    }));
  }
  for (const a of parsed.adjustments || []) {
    lines.push(fullLine({
      kind: 'adjustment', position: pos++,
      description: a.description, amount: a.amount,
      flags: a.flags, source_row: a.source_row,
    }));
  }
  return lines;
}

function totalsFromLines(lines) {
  const t = { gross_total: 0, commission_total: 0, nett_total: 0, expenses_total: 0, adjustments_total: 0 };
  for (const l of lines) {
    if (l.kind === 'booking') {
      t.gross_total += Number(l.amount) || 0;
      t.commission_total += Number(l.commission) || 0;
      t.nett_total += Number(l.nett) || 0;
    } else if (l.kind === 'expense') {
      t.expenses_total += Number(l.amount) || 0;
    } else if (l.kind === 'adjustment') {
      t.adjustments_total += Number(l.amount) || 0;
    }
  }
  t.payout_total = t.nett_total - t.expenses_total + t.adjustments_total;
  return t;
}

// Recompute a statement's totals from its stored lines (after any edit).
export async function recomputeTotals(db, statementId) {
  const lines = await sbGet(db, `statement_lines?statement_id=eq.${statementId}&select=kind,amount,commission,nett`);
  const totals = totalsFromLines(Array.isArray(lines) ? lines : []);
  await sbPatch(db, `statements?id=eq.${statementId}`, { ...totals, updated_at: nowIso() });
  return totals;
}

// ── LLM fallback: classify rows the deterministic parser couldn't ───
// One call per sync, only when needed. Results are appended as flagged
// lines; the statement stays needs_review so Ikiel verifies them.
async function classifyUnparsedRows(parsed) {
  const key = process.env.ANTHROPIC_API_KEY;
  const rows = parsed.reconciliation?.unparsed_rows || [];
  if (!key || !rows.length) return [];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.STATEMENT_LLM_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `These spreadsheet rows are from a Bali villa monthly earnings report (bookings and expenses in IDR) that a rule-based parser could not classify. For each row decide: is it a booking (guest stay with revenue), an expense, or neither (ignore). Reply with ONLY a JSON array, one object per row, in order: {"kind":"booking"|"expense"|"ignore","guest_name":string|null,"stay_dates":string|null,"platform":string|null,"amount":number|null,"commission":number|null,"nett":number|null,"expense_date":string|null,"description":string|null}.\n\nRows:\n${rows.map(x => `row ${x.row}: ${JSON.stringify(x.cells)}`).join('\n')}`,
        }],
      }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const text = (d.content || []).map(c => c.text || '').join('');
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    if (!Array.isArray(arr)) return [];
    return arr.map((c, idx) => ({ ...c, source_row: rows[idx]?.row })).filter(c => c && c.kind !== 'ignore');
  } catch { return []; }
}

// ── Sync one group's sheet into draft statements ────────────────────
export async function syncGroup(db, group, { dryRun = false, force = false, results = null } = {}) {
  if (!sheetsConfigured()) return { group: group.key, error: 'Google OAuth not configured' };
  const out = { group: group.key, tabs: 0, created: 0, updated: 0, unchanged: 0, kept_edits: 0, discrepancies: 0, skipped: null, drafts: [] };
  const newDrafts = [];   // batched into ONE Telegram ping at the end of the run

  // Change probe: skip untouched files (Drive modifiedTime is per file).
  // A group may carry a report sheet, an expense ledger, or both.
  let meta = null, expMeta = null;
  try {
    if (group.sheet_file_id) meta = await getFileMeta(group.sheet_file_id);
    if (group.expense_sheet_file_id) expMeta = await getFileMeta(group.expense_sheet_file_id);
  } catch (e) { return { group: group.key, error: e.message }; }
  if (!meta && !expMeta) return { ...out, skipped: 'no sheet' };
  const state = (await getSettingValue(db, SYNC_STATE_KEY)) || {};
  if (!force && !dryRun
    && (state[group.key]?.modifiedTime || null) === (meta?.modifiedTime || null)
    && (state[group.key]?.expenseModifiedTime || null) === (expMeta?.modifiedTime || null)) {
    return { ...out, skipped: 'unchanged since last sync' };
  }

  const tabs = meta ? await listTabs(group.sheet_file_id) : [];
  for (const tab of tabs) {
    let parsed;
    try { parsed = parseMonthTab(await getTabValues(group.sheet_file_id, tab.title), { tabTitle: tab.title }); }
    catch (e) { out.drafts.push({ tab: tab.title, error: e.message }); continue; }
    if (!parsed) continue;                       // not a report tab
    out.tabs++;
    if (!parsed.period) { out.drafts.push({ tab: tab.title, error: 'no month/year detected' }); continue; }

    if (dryRun) { out.drafts.push({ tab: tab.title, period: parsed.period, totals: parsed.totals, era_payout_total: parsed.era_payout_total, needs_review: parsed.needs_review, flags: parsed.flags, reconciliation: parsed.reconciliation }); continue; }

    const existing = (await sbGet(db, `statements?group_key=eq.${group.key}&period=eq.${parsed.period}&select=*&limit=1`))?.[0] || null;

    if (existing && existing.source_hash === parsed.source_hash) {
      // Self-heal a partial failure: a statement whose hash matched but whose
      // line insert died mid-sync would otherwise stay empty forever.
      const anyLine = (await sbGet(db, `statement_lines?statement_id=eq.${existing.id}&select=id&limit=1`))?.[0];
      if (anyLine || existing.status !== 'draft' || existing.has_manual_edits) { out.unchanged++; continue; }
    }

    // Published/paid statements are immutable — record the drift, alert.
    if (existing && (existing.status === 'published' || existing.status === 'paid')) {
      out.discrepancies++;
      if (existing.source_changed) continue;   // already flagged — don't re-alert every sync
      await sbPatch(db, `statements?id=eq.${existing.id}`, {
        source_changed: true,
        discrepancy: { detected_at: nowIso(), note: `Era edited tab "${tab.title}" after this statement was ${existing.status}`, new_era_payout: parsed.era_payout_total, published_payout: existing.payout_total },
        updated_at: nowIso(),
      });
      await postToTelegram(`⚠️ <b>Statement source changed after publish</b>\n${group.name} · ${periodLabel(parsed.period)} (${existing.status})\nSheet now says payout ${fmtIDR(parsed.era_payout_total)} vs published ${fmtIDR(existing.payout_total)}. Review in the Payouts tab.`);
      continue;
    }

    // Drafts Ikiel edited: never clobber; flag and alert instead.
    if (existing && existing.has_manual_edits) {
      out.kept_edits++;
      if (existing.source_changed) continue;   // already flagged — don't re-alert every sync
      await sbPatch(db, `statements?id=eq.${existing.id}`, { source_changed: true, updated_at: nowIso() });
      await postToTelegram(`✏️ <b>Era updated a draft you've edited</b>\n${group.name} · ${periodLabel(parsed.period)}\nYour manual edits are kept. Use "Re-parse" in the Payouts tab to discard them and re-import.`);
      continue;
    }

    // LLM assist for rows the parser couldn't place (flagged, reviewable).
    const llmLines = parsed.reconciliation?.unparsed_rows?.length ? await classifyUnparsedRows(parsed) : [];
    const lines = linesFromParse(parsed);
    let pos = lines.length;
    for (const c of llmLines) {
      lines.push(fullLine({
        kind: c.kind === 'expense' ? 'expense' : 'booking', position: pos++,
        guest_name: c.guest_name || null, stay_dates: c.stay_dates || null, platform: c.platform || null,
        amount: Number(c.amount) || 0, commission: Number(c.commission) || 0, nett: Number(c.nett) || 0,
        expense_date: c.expense_date || null, description: c.description || null,
        flags: ['llm_classified'], source_row: c.source_row ?? null,
      }));
    }
    const totals = totalsFromLines(lines);
    const fields = {
      ...totals,
      era_payout_total: parsed.era_payout_total,
      reconciliation: parsed.reconciliation,
      needs_review: parsed.needs_review,
      source_hash: parsed.source_hash,
      source_tab: tab.title,
      parsed_at: nowIso(),
      source_changed: false,
      updated_at: nowIso(),
    };

    let statementId;
    if (existing) {
      await sbPatch(db, `statements?id=eq.${existing.id}`, fields);
      await sbDelete(db, `statement_lines?statement_id=eq.${existing.id}`);
      statementId = existing.id;
      out.updated++;
    } else {
      const inserted = await sbPost(db, 'statements', { group_key: group.key, period: parsed.period, status: 'draft', ...fields });
      statementId = inserted?.[0]?.id;
      out.created++;
      newDrafts.push({ period: parsed.period, payout: totals.payout_total, review: parsed.needs_review });
    }
    if (statementId && lines.length) {
      await sbPost(db, 'statement_lines', lines.map(l => ({ ...l, statement_id: statementId })), 'return=minimal');
    }
    if (results) results.push({ statement: `${group.key} ${parsed.period}`, action: existing ? 'updated' : 'created' });
  }

  // ── Expense ledger: fill months the report left without expenses ──
  if (expMeta) {
    try {
      const r = await syncExpenseSheet(db, group, { dryRun, out, newDrafts });
      out.expense_sheet = r;
    } catch (e) { out.expense_sheet = { error: e.message }; }
  }

  // One Telegram ping per group per run, however many months it produced —
  // a first backfill imports a whole year and must not storm the phone.
  if (newDrafts.length) {
    const listing = newDrafts.sort((a, b) => a.period.localeCompare(b.period))
      .map(d => `• ${periodLabel(d.period)} — ${fmtIDR(d.payout)}${d.review ? ' ⚠' : ''}`).join('\n');
    await postToTelegram(`📊 <b>${newDrafts.length === 1 ? 'New draft statement' : newDrafts.length + ' new draft statements'}</b>\n${group.name}\n${listing}\nReview &amp; publish in the admin Payouts tab.`);
  }

  state[group.key] = { modifiedTime: meta?.modifiedTime || null, expenseModifiedTime: expMeta?.modifiedTime || null, checked_at: nowIso() };
  if (!dryRun) await saveSettingValue(db, SYNC_STATE_KEY, state);
  return out;
}

// ── Expense ledger sync ──────────────────────────────────────────────
// Era's running expense sheet for a property (several months per tab, or
// one tab per month). Rules, in order:
//   • the report sheet wins: a month whose statement already has expense
//     lines that did not come from the ledger is left alone
//   • published months are never touched; they are listed so Ikiel can
//     amend them (the ledger has lines the owner never saw)
//   • edited drafts are kept, as always
//   • an untouched draft gets the ledger's lines (flag expense_sheet),
//     replacing any earlier ledger lines for that month
//   • a month with no statement gets a new draft with zero bookings, but
//     only from the group's first statement onward (LaneHAUS's ledger goes
//     back to 2025; the statements start in 2026), or from any month when
//     the group has no statements yet (an expenses-only group)
// Receipts ("Received payment from …") are direct rent Era collected for a
// unit: they become fee-free booking lines, so an expenses-only payout
// equals Era's own "Total Balance", negated.
async function syncExpenseSheet(db, group, { dryRun = false, out, newDrafts }) {
  const res = { tabs: 0, months: 0, filled: 0, created: 0, unchanged: 0, report_wins: 0, kept_edits: 0, published_pending: [], before_first: 0, errors: [] };
  const tabs = await listTabs(group.expense_sheet_file_id);
  const blocks = [];
  for (const tab of tabs) {
    let parsed;
    try { parsed = parseExpenseSheetTab(await getTabValues(group.expense_sheet_file_id, tab.title), { tabTitle: tab.title }); }
    catch (e) { res.errors.push({ tab: tab.title, error: e.message }); continue; }
    if (!parsed) continue;
    res.tabs++;
    for (const m of parsed.months) {
      if (!m.period) { res.errors.push({ tab: tab.title, error: 'expense block without a month header' }); continue; }
      blocks.push({ ...m, tab: tab.title });
    }
  }
  res.months = blocks.length;
  if (!blocks.length) return res;

  const existingAll = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(group.key)}&select=id,period,status,has_manual_edits&order=period.asc`)) || [];
  const firstPeriod = existingAll[0]?.period || null;

  for (const b of blocks.sort((x, y) => x.period.localeCompare(y.period))) {
    const existing = existingAll.find(s => s.period === b.period) || null;
    const expenses = b.expenses.map(e => fullLine({ kind: 'expense', expense_date: e.expense_date, description: e.description, amount: e.amount, flags: [...e.flags, 'expense_sheet'], source_row: e.source_row }));
    // "Received payment from Vadat" is rent a direct tenant paid to Era for
    // one of these units (Ikiel, 4 Sep 2026): a booking with no Samba fee,
    // so the month's maths is rent collected less expenses, which is Era's
    // own "Total Balance" with the sign flipped.
    const receipts = (b.receipts || []).map(r => {
      const who = String(r.description || '').match(/from\s+(.+?)\s*$/i)?.[1] || null;
      const guest = who ? who.charAt(0).toUpperCase() + who.slice(1) : null;
      return fullLine({ kind: 'booking', guest_name: guest, platform: 'Direct', amount: Math.abs(r.amount), commission: 0, nett: Math.abs(r.amount), flags: ['direct_rent', 'expense_sheet'], source_row: r.source_row });
    });
    const ledgerLines = [...receipts, ...expenses];
    const failed = (b.checks || []).filter(c => !c.ok);

    if (existing) {
      if (['published', 'partial', 'paid'].includes(existing.status)) {
        const hasExp = (await sbGet(db, `statement_lines?statement_id=eq.${existing.id}&kind=eq.expense&select=id&limit=1`))?.[0];
        if (!hasExp && expenses.length) res.published_pending.push({ period: b.period, id: existing.id, total: expenses.reduce((a, l) => a + l.amount, 0) });
        continue;
      }
      if (existing.has_manual_edits) { res.kept_edits++; continue; }
      const lines = (await sbGet(db, `statement_lines?statement_id=eq.${existing.id}&select=id,kind,flags,position&order=position.asc`)) || [];
      const reportExpenses = lines.filter(l => l.kind === 'expense' && !(l.flags || []).includes('expense_sheet'));
      if (reportExpenses.length) { res.report_wins++; continue; }
      if (dryRun) { res.filled++; continue; }
      await sbDelete(db, `statement_lines?statement_id=eq.${existing.id}&flags=cs.{expense_sheet}`);
      const kept = lines.filter(l => !(l.flags || []).includes('expense_sheet'));
      let pos = (kept[kept.length - 1]?.position ?? -1) + 1;
      if (ledgerLines.length) await sbPost(db, 'statement_lines', ledgerLines.map(l => ({ ...l, position: pos++, statement_id: existing.id })), 'return=minimal');
      await recomputeTotals(db, existing.id);
      await sbPatch(db, `statements?id=eq.${existing.id}`, { ...(failed.length ? { needs_review: true } : {}), updated_at: nowIso() });
      res.filled++;
      if (out) out.updated++;
      continue;
    }

    // No statement for this month.
    if (firstPeriod && b.period < firstPeriod) { res.before_first++; continue; }
    if (dryRun) { res.created++; continue; }
    const totals = totalsFromLines(ledgerLines);
    const checks = [...(b.checks || [])];
    if (!group.expenses_only) checks.push({ name: 'no_report_tab_for_month', ok: false, expected: 'report tab', actual: `only the expense ledger (${b.tab})` });
    const inserted = await sbPost(db, 'statements', {
      group_key: group.key, period: b.period, status: 'draft', ...totals,
      era_payout_total: null,
      reconciliation: { checks, unparsed_rows: [] },
      needs_review: checks.some(c => !c.ok),
      source_hash: null, source_tab: `${b.tab} (expense ledger)`, parsed_at: nowIso(), source_changed: false, updated_at: nowIso(),
    });
    const id = inserted?.[0]?.id;
    if (id && ledgerLines.length) {
      let pos = 0;
      await sbPost(db, 'statement_lines', ledgerLines.map(l => ({ ...l, position: pos++, statement_id: id })), 'return=minimal');
    }
    res.created++;
    if (out) out.created++;
    if (newDrafts) newDrafts.push({ period: b.period, payout: totals.payout_total, review: checks.some(c => !c.ok) });
  }

  if (res.published_pending.length) {
    const listing = res.published_pending.map(p => `• ${periodLabel(p.period)} — ${fmtIDR(p.total)} of expenses`).join('\n');
    await postToTelegram(`📒 <b>Expense ledger has lines for published months</b>\n${group.name}\n${listing}\nThose statements went out without expenses. Amend them in the Payouts tab to bring the ledger in.`).catch(() => {});
  }
  return res;
}

export async function syncAllGroups(db, opts = {}) {
  const groups = await listGroups(db);
  const out = [];
  for (const g of groups) {
    // No sheet of either kind → nothing to parse (a maintenance/reports-only group).
    if (!g.sheet_file_id && !g.expense_sheet_file_id) { out.push({ group: g.key, skipped: 'no sheet' }); continue; }
    try { out.push(await syncGroup(db, g, opts)); }
    catch (e) { out.push({ group: g.key, error: e.message }); }
  }
  return out;
}

// ── Re-parse a single draft, discarding manual edits (explicit ask) ──
export async function reparseStatement(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (st.status !== 'draft') throw new Error('only drafts can be re-parsed');
  const group = (await sbGet(db, `statement_groups?key=eq.${st.group_key}&select=*&limit=1`))?.[0];
  // Clear the edit guard, then force a full group re-sync (hash mismatch will
  // re-import this period's lines from the sheet).
  await sbPatch(db, `statements?id=eq.${id}`, { has_manual_edits: false, source_hash: null, updated_at: nowIso() });
  return syncGroup(db, group, { force: true });
}

// ── Auto carry-forward ──────────────────────────────────────────────
// Deficit months are carried by Samba (Ikiel) and repaid from later rental
// revenue: when the previous month's statement closed NEGATIVE, publishing
// this month rolls that deficit in as a signed adjustment line — unless a
// carry line already exists (Era writes "Minus from <month>" by hand
// sometimes; never double-count). Chained deficits compound naturally:
// each month's payout_total already includes what it inherited.
export function computeCarryAdjustment(prev, lines) {
  if (!prev) return null;
  const balance = Number(prev.payout_total) - Number(prev.paid_total || 0);
  if (balance >= -1) return null;   // no deficit to carry
  const already = (lines || []).some(l => l.kind === 'adjustment' &&
    ((l.flags || []).includes('carry_forward') || (l.flags || []).includes('auto_carry')
      || /minus|carr(y|ied)|deficit/i.test(l.description || '')));
  if (already) return null;
  return {
    amount: balance,
    description: `Carried forward from ${periodLabel(prev.period)} (deficit covered by Samba Realty)`,
  };
}
export function prevPeriodOf(period) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Stay-date parsing for Era's free-text ranges ────────────────────
// "10-13 June", "25 July - 11 Aug", "26 May - 26 June", "29 Dec - 6 feb",
// "5 May-5June", "22-27 arch" (typo for March). Month tokens are matched by
// containment so truncations survive. The statement's period anchors the
// year, with rollover on both ends. Returns {start, endEx} in UTC ms
// (checkout-exclusive) or null when the text can't be trusted.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthIdx(token) {
  const t = String(token || '').toLowerCase();
  if (t.length < 3) return -1;
  let i = MONTH_NAMES.findIndex(m => m.startsWith(t.slice(0, 3)) && t.startsWith(m.slice(0, 3)));
  if (i < 0) i = MONTH_NAMES.findIndex(m => m.includes(t));
  return i;
}
export function parseStayRange(text, period) {
  const [py, pmRaw] = String(period || '').split('-').map(Number);
  if (!py || !pmRaw) return null;
  const pm = pmRaw - 1;
  const halves = String(text || '').trim().split(/\s*[-–—]\s*/);
  if (halves.length !== 2) return null;
  const side = (part) => {
    const day = parseInt(part.match(/\d{1,2}/)?.[0], 10);
    const mon = monthIdx(part.match(/[A-Za-z]{3,}/)?.[0]);
    return { day: isFinite(day) ? day : null, mon: mon >= 0 ? mon : null };
  };
  const L = side(halves[0]), R = side(halves[1]);
  if (L.day === null || R.day === null) return null;
  const monL = L.mon ?? R.mon ?? pm;
  const monR = R.mon ?? monL;
  let yearL = py;
  if (monL - pm > 6) yearL--;          // "29 Dec - …" in a January statement
  if (pm - monL > 6) yearL++;
  let start = Date.UTC(yearL, monL, L.day);
  let yearR = yearL;
  let endEx = Date.UTC(yearR, monR, R.day);
  if (endEx <= start) endEx = Date.UTC(++yearR, monR, R.day);
  if (!isFinite(start) || !isFinite(endEx) || endEx <= start || endEx - start > 370 * 86400000) return null;
  return { start, endEx };
}

// ── Statement-recorded guest nights per unit slug, WITHIN a range ───
// Era's booking lines are the truth for direct rentals the Hostex calendar
// never saw — but she books by PAYMENT month (June's sheet can hold a
// July stay), so a line only contributes the nights its stay DATES overlap
// with the requested range. Statements one month either side are scanned to
// catch cross-recorded stays. Owner stays and zero-amount family stays are
// excluded; unparseable dates fall back to the recorded nights capped to
// one month, and only when the line's own statement sits inside the range.
export async function statementUnitNights(db, groupKey, from, to) {
  const group = (await sbGet(db, `statement_groups?key=eq.${encodeURIComponent(groupKey)}&select=listing_slugs&limit=1`))?.[0];
  if (!group) return null;
  const slugs = group.listing_slugs || [];
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return { bySlug: {}, unassigned: 0, from, to };
  const rangeStart = Date.UTC(+from.slice(0, 4), +from.slice(5) - 1, 1);
  const rangeEndEx = Date.UTC(+to.slice(0, 4), +to.slice(5), 1);
  const widen = (p, d) => { const dt = new Date(Date.UTC(+p.slice(0, 4), +p.slice(5) - 1 + d, 1)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; };
  const sts = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(groupKey)}&status=neq.void&period=gte.${widen(from, -1)}&period=lte.${widen(to, 1)}&select=id,period&order=period.asc`)) || [];

  const bySlug = {}; let unassigned = 0;
  const slugFor = (unitName) => {
    if (slugs.length === 1) return slugs[0];
    for (const slug of slugs) {
      const n = slug.match(/-(\d+)$/)?.[1];
      if (n && new RegExp(`unit\\s*0*${n}\\b`, 'i').test(unitName || '')) return slug;
    }
    return null;
  };
  for (const st of sts) {
    const inRange = st.period >= from && st.period <= to;
    const lines = (await sbGet(db, `statement_lines?statement_id=eq.${st.id}&kind=eq.booking&select=unit_name,platform,stay_dates,nights,flags`)) || [];
    for (const l of lines) {
      if (/owner/i.test(l.platform || '')) continue;
      if ((l.flags || []).includes('zero_amount')) continue;
      const recorded = Number(l.nights) || 0;
      const range = parseStayRange(l.stay_dates, st.period);
      let nights = 0;
      if (range) {
        nights = Math.max(0, Math.round((Math.min(range.endEx, rangeEndEx) - Math.max(range.start, rangeStart)) / 86400000));
        if (recorded) nights = Math.min(nights, recorded);
      } else if (recorded && inRange) {
        nights = Math.min(recorded, 31);   // dates unreadable: trust Era, one month max
      }
      if (!nights) continue;
      const slug = slugFor(l.unit_name);
      if (slug) bySlug[slug] = (bySlug[slug] || 0) + nights;
      else unassigned += nights;
    }
  }
  return { bySlug, unassigned, from, to };
}

async function fetchHostexSnapshot(db, group, period) {
  try {
    const slugs = (group?.listing_slugs || []).join(',');
    if (!slugs) return null;
    // Era's recorded guest nights ride along so the portal can count
    // direct rentals the calendar never saw as occupied nights.
    let stmtNights = '';
    try {
      const un = await statementUnitNights(db, group.key, period, period);
      if (un) stmtNights = `&stmt_nights=${encodeURIComponent(JSON.stringify({ bySlug: un.bySlug, unassigned: un.unassigned }))}`;
    } catch { /* best-effort */ }
    const r = await fetch(`${PORTAL_BASE}/api/statements?action=month-stats&slugs=${encodeURIComponent(slugs)}&period=${period}${stmtNights}`, {
      headers: { Authorization: `Bearer ${process.env.LISTING_SYNC_SECRET || ''}` },
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Re-freeze ONLY the Hostex context panel of an already-published statement
// (occupancy math improved, labels changed, …). Money is never touched —
// this exists precisely because the financial figures are immutable.
export async function refreshSnapshot(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=id,group_key,period,status&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (!['published', 'partial', 'paid'].includes(st.status)) throw new Error('refresh applies to published statements');
  const group = (await sbGet(db, `statement_groups?key=eq.${st.group_key}&select=*&limit=1`))?.[0];
  const hostex = await fetchHostexSnapshot(db, group, st.period);
  if (!hostex) throw new Error('Hostex stats unavailable');
  await sbPatch(db, `statements?id=eq.${id}`, { hostex_snapshot: hostex, updated_at: nowIso() });
  return { ok: true, group: st.group_key, period: st.period, occupancy: hostex.group?.occupancy_pct, owner_blocked: hostex.group?.owner_blocked };
}

// ── Publish: freeze lines + snapshot Hostex month stats ─────────────
export async function publishStatement(db, id, { actor = 'admin', notifyOwner = true } = {}) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (st.status !== 'draft') throw new Error(`cannot publish a ${st.status} statement`);
  const group = (await sbGet(db, `statement_groups?key=eq.${st.group_key}&select=*&limit=1`))?.[0];

  // Roll in the previous month's deficit before totals freeze. NOT
  // best-effort: publishing a wrong payout is worse than failing loudly.
  const prev = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(st.group_key)}&period=eq.${prevPeriodOf(st.period)}&status=in.(published,partial,paid)&select=payout_total,paid_total,period&limit=1`))?.[0];
  const existingLines = await sbGet(db, `statement_lines?statement_id=eq.${id}&select=kind,description,flags,position&order=position.desc`);
  // Expenses-only groups have no rent to recoup a deficit from: every month
  // stands alone as what the co-owners owe Samba, exactly like Era's own
  // per-month "Total Balance". No carry.
  const carry = group?.expenses_only ? null : computeCarryAdjustment(prev, existingLines);
  if (carry) {
    await sbPost(db, 'statement_lines', {
      statement_id: id, kind: 'adjustment', position: (existingLines?.[0]?.position ?? 0) + 1,
      description: carry.description, amount: carry.amount, flags: ['auto_carry'],
    }, 'return=minimal');
  }

  // Hostex month aggregates, frozen now — the feed drifts (cancellations,
  // rate edits) but a statement the owner saw never does. Best-effort: a
  // portal outage shouldn't block a payout statement.
  const hostex = await fetchHostexSnapshot(db, group, st.period);

  const totals = await recomputeTotals(db, id);
  await sbPatch(db, `statements?id=eq.${id}`, {
    status: 'published',
    published_at: nowIso(),
    published_by: actor,
    hostex_snapshot: hostex,
    // History backfill: publishing with notifyOwner=false pre-stamps
    // notified_at so the Maya sweep never announces settled months.
    ...(notifyOwner ? {} : { notified_at: nowIso() }),
    updated_at: nowIso(),
  });
  return { ok: true, payout_total: totals.payout_total, hostex: !!hostex, token: statementToken(st.group_key, st.period) };
}

export async function unpublishStatement(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (st.status !== 'published') throw new Error(`cannot unpublish a ${st.status} statement`);
  if (st.notified_at) throw new Error('owner already notified — use Amend instead, so the correction is visible');
  if (Number(st.paid_total) > 0) throw new Error('payments recorded — delete them first');
  await sbPatch(db, `statements?id=eq.${id}`, { status: 'draft', published_at: null, published_by: null, hostex_snapshot: null, updated_at: nowIso() });
  return { ok: true };
}

// ── Amendments: correct a published statement TRANSPARENTLY ─────────
// Publishing freezes numbers because the owner may have seen them; an
// amendment is the sanctioned way to change them afterwards — the banking
// "amended statement" pattern. Start snapshots the totals AND lines (so
// Cancel can restore exactly), the admin edits lines in place, Finalize
// closes the revision with a note the owner sees, recomputes the
// published/partial/paid status against the payments ledger, and can
// re-queue the Maya notification. The statement stays visible to the owner
// throughout — never a moment where their link 404s.
const AMEND_TOTAL_FIELDS = ['gross_total', 'commission_total', 'nett_total', 'expenses_total', 'adjustments_total', 'payout_total', 'era_payout_total'];
export const hasOpenRevision = (st) => Array.isArray(st?.revisions) && st.revisions.some(r => r && r.open);

export async function amendStart(db, id, actor = 'admin') {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (!['published', 'partial', 'paid'].includes(st.status)) {
    throw new Error(`only published statements can be amended — this one is ${st.status}`);
  }
  const revs = Array.isArray(st.revisions) ? st.revisions : [];
  if (revs.some(r => r && r.open)) return { ok: true, already_open: true };
  const lines = await sbGet(db, `statement_lines?statement_id=eq.${id}&select=*&order=position.asc,id.asc`);
  const prev = {};
  for (const k of AMEND_TOTAL_FIELDS) prev[k] = st[k];
  revs.push({ open: true, started_at: nowIso(), by: actor, prev, prev_lines: Array.isArray(lines) ? lines : [] });
  await sbPatch(db, `statements?id=eq.${id}`, { revisions: revs, updated_at: nowIso() });
  return { ok: true };
}

export async function amendFinalize(db, id, { note, notifyOwner = false, actor = 'admin' } = {}) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  const revs = Array.isArray(st.revisions) ? st.revisions : [];
  const rev = revs.find(r => r && r.open);
  if (!rev) throw new Error('no amendment in progress');
  const totals = await recomputeTotals(db, id);
  delete rev.prev_lines;             // history keeps totals, not the line dump
  rev.open = false;
  rev.at = nowIso();
  rev.by = actor;
  rev.note = String(note || '').slice(0, 300) || null;
  rev.new = { ...totals, era_payout_total: st.era_payout_total };
  await sbPatch(db, `statements?id=eq.${id}`, {
    revisions: revs,
    has_manual_edits: true,
    // Re-queue the Maya sweep so the owner hears the statement changed.
    ...(notifyOwner ? { notified_at: null } : {}),
    updated_at: nowIso(),
  });
  await recomputePayments(db, id);   // new payout total → status may flip
  return { ok: true, payout_total: totals.payout_total, prev_payout: rev.prev?.payout_total ?? null };
}

export async function amendCancel(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  const revs = Array.isArray(st.revisions) ? st.revisions : [];
  const idx = revs.findIndex(r => r && r.open);
  if (idx < 0) throw new Error('no amendment in progress');
  const rev = revs[idx];
  // Restore the exact pre-amendment lines and totals.
  await fetch(`${db.SUPABASE_URL}/rest/v1/statement_lines?statement_id=eq.${id}`, { method: 'DELETE', headers: db.sbHeaders });
  const restore = (rev.prev_lines || []).map(l => fullLine({ ...l, statement_id: id }));
  if (restore.length) {
    await fetch(`${db.SUPABASE_URL}/rest/v1/statement_lines`, {
      method: 'POST', headers: db.sbHeaders, body: JSON.stringify(restore),
    });
  }
  revs.splice(idx, 1);
  await sbPatch(db, `statements?id=eq.${id}`, { ...(rev.prev || {}), revisions: revs, updated_at: nowIso() });
  await recomputePayments(db, id);
  return { ok: true };
}

// ── Payments (partial or full) ──────────────────────────────────────
// A payout can be settled across several transfers. Each payment is a row in
// statement_payments; the statement's status/paid_total/balance derive from
// the ledger: no payments → published, some → partial, covered (±1 IDR) →
// paid. paid_at is the date of the payment that settled it.
async function recomputePayments(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=id,status,payout_total&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  // Returned (bounced) transfers stay in the ledger for the audit trail but
  // never count toward paid_total — the owed balance springs back.
  const pays = (await sbGet(db, `statement_payments?statement_id=eq.${id}&select=amount,paid_at,status&order=paid_at.asc`)) || [];
  const cleared = pays.filter(p => p.status !== 'returned');
  const paidTotal = cleared.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const settled = paidTotal >= Number(st.payout_total) - 1;
  const fields = {
    paid_total: paidTotal,
    updated_at: nowIso(),
  };
  // Only flip between the post-publish states — never resurrect a draft/void.
  if (['published', 'partial', 'paid'].includes(st.status)) {
    fields.status = settled && cleared.length ? 'paid' : cleared.length ? 'partial' : 'published';
    fields.paid_at = settled && cleared.length ? cleared[cleared.length - 1].paid_at : null;
  }
  await sbPatch(db, `statements?id=eq.${id}`, fields);
  return { paid_total: paidTotal, balance: Number(st.payout_total) - paidTotal, status: fields.status || st.status };
}

export async function recordPayment(db, id, { amount, note, base64, contentType, paidAt } = {}) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=id,status,payout_total,paid_total,group_key,period&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (!['published', 'partial'].includes(st.status)) throw new Error(`cannot record a payment on a ${st.status} statement`);
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new Error('payment amount must be a positive number');
  let proofPath = null;
  if (base64) {
    proofPath = await uploadProofBytes(db, st, { base64, contentType });
  }
  await sbPost(db, 'statement_payments', {
    statement_id: id, amount: amt, note: note || null, proof_path: proofPath,
    paid_at: paidAt || nowIso(),
  }, 'return=minimal');
  return recomputePayments(db, id);
}

export async function deletePayment(db, id, paymentId) {
  await sbDelete(db, `statement_payments?id=eq.${parseInt(paymentId, 10)}&statement_id=eq.${id}`);
  return recomputePayments(db, id);
}

// A transfer the bank bounced: keep the row (audit trail), flag it returned,
// and the owed balance restores. `undo` un-flags if it was marked by mistake.
export async function markPaymentReturned(db, id, paymentId, { note, undo = false } = {}) {
  await sbPatch(db, `statement_payments?id=eq.${parseInt(paymentId, 10)}&statement_id=eq.${id}`,
    undo ? { status: 'cleared', returned_at: null, return_note: null }
         : { status: 'returned', returned_at: nowIso(), return_note: note || null });
  return recomputePayments(db, id);
}

export async function listPayments(db, id) {
  const pays = (await sbGet(db, `statement_payments?statement_id=eq.${id}&select=*&order=paid_at.asc`)) || [];
  for (const p of pays) p.proof_url = p.proof_path ? await signProofUrl(db, p.proof_path) : null;
  return pays;
}

// Legacy one-shot: record a payment for the full remaining balance.
export async function markPaid(db, id) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=status,payout_total,paid_total&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  const remaining = Number(st.payout_total) - Number(st.paid_total || 0);
  if (remaining <= 0) throw new Error('nothing outstanding');
  return recordPayment(db, id, { amount: remaining, note: 'Paid in full' });
}

// Payment screenshot → PRIVATE bucket. Small images only (the admin page
// downscales before upload — serverless body cap is ~4.5MB).
async function uploadProofBytes(db, st, { base64, contentType }) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(String(contentType))) throw new Error('proof must be a jpeg/png/webp image');
  const bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length) throw new Error('empty upload');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('image too large');
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  const path = `${st.group_key}/${st.period}-${Date.now()}.${ext}`;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/${PROOF_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey,
      'Content-Type': contentType, 'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`proof upload → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return path;
}

// Legacy statement-level proof (pre-partial-payments UI path).
export async function saveProofUpload(db, id, { base64, contentType }) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=group_key,period&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  const path = await uploadProofBytes(db, st, { base64, contentType });
  await sbPatch(db, `statements?id=eq.${id}`, { proof_path: path, updated_at: nowIso() });
  return { ok: true, proof_path: path };
}

// Short-lived signed URL for viewing a proof (admin page + paid statements).
export async function signProofUrl(db, path) {
  if (!path) return null;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/sign/${PROOF_BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.signedURL ? `${db.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}

// ── Owner-facing payload (published/paid only — never drafts) ───────
export async function publicStatement(db, groupKey, period) {
  const st = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(groupKey)}&period=eq.${encodeURIComponent(period)}&status=in.(published,partial,paid)&select=*&limit=1`))?.[0];
  if (!st) return null;
  const group = (await sbGet(db, `statement_groups?key=eq.${encodeURIComponent(groupKey)}&select=*&limit=1`))?.[0];
  const lines = await sbGet(db, `statement_lines?statement_id=eq.${st.id}&select=kind,unit_name,position,guest_name,stay_dates,platform,nights,amount,commission,nett,expense_date,description&order=position.asc`);
  const payments = await listPayments(db, st.id);
  const paidTotal = Number(st.paid_total) || 0;
  // Previous published month, for the page's month-over-month delta chip.
  const prev = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(groupKey)}&period=eq.${prevPeriodOf(period)}&status=in.(published,partial,paid)&select=period,payout_total,hostex_snapshot&limit=1`))?.[0];
  return {
    previous: prev ? {
      period_label: periodLabel(prev.period),
      payout_total: prev.payout_total,
      occupancy_pct: prev.hostex_snapshot?.group?.occupancy_pct ?? null,
    } : null,
    group: group || { key: groupKey },
    period: st.period,
    period_label: periodLabel(st.period),
    status: st.status,
    currency: st.currency,
    totals: {
      gross: st.gross_total, commission: st.commission_total, nett: st.nett_total,
      expenses: st.expenses_total, adjustments: st.adjustments_total, payout: st.payout_total,
      paid: paidTotal, balance: Number(st.payout_total) - paidTotal,
    },
    paid_at: st.paid_at,
    published_at: st.published_at,
    // Closed amendments, oldest first — the page shows what changed and when.
    revisions: (Array.isArray(st.revisions) ? st.revisions : [])
      .filter(r => r && !r.open && r.at)
      .map(r => ({ at: r.at, note: r.note || null, prev_payout: r.prev?.payout_total ?? null, new_payout: r.new?.payout_total ?? null })),
    hostex: st.hostex_snapshot,
    lines: Array.isArray(lines) ? lines : [],
    payments: payments.map(p => ({ amount: p.amount, paid_at: p.paid_at, note: p.note, proof_url: p.proof_url, status: p.status || 'cleared' })),
  };
}

// Everything the Excel export needs for one group, one call: the group, its
// published/partial/paid statements (a given year or all), lines, payments.
export async function exportData(db, groupKey, { year, from, to } = {}) {
  const group = (await sbGet(db, `statement_groups?key=eq.${encodeURIComponent(groupKey)}&select=*&limit=1`))?.[0];
  if (!group) return null;
  let q = `statements?group_key=eq.${encodeURIComponent(groupKey)}&status=in.(published,partial,paid)&select=*&order=period.asc`;
  if (year) q += `&period=like.${encodeURIComponent(year)}-*`;
  // Banking-style range: periods are YYYY-MM, so string comparison is safe.
  if (/^\d{4}-\d{2}$/.test(String(from || ''))) q += `&period=gte.${from}`;
  if (/^\d{4}-\d{2}$/.test(String(to || ''))) q += `&period=lte.${to}`;
  const statements = (await sbGet(db, q)) || [];
  for (const st of statements) {
    st.lines = (await sbGet(db, `statement_lines?statement_id=eq.${st.id}&select=kind,unit_name,position,guest_name,stay_dates,platform,nights,amount,commission,nett,expense_date,description&order=position.asc`)) || [];
    st.payments = (await sbGet(db, `statement_payments?statement_id=eq.${st.id}&select=amount,paid_at,note&order=paid_at.asc`)) || [];
    st.period_label = periodLabel(st.period);
  }
  return { group, statements };
}

// ── Maya notify sweep ───────────────────────────────────────────────
// Event-driven: every published statement with notified_at null, for groups
// with notify=true and at least one owner number. Dedupe is the notified_at
// stamp itself (per statement, set once) — republishing is guarded upstream,
// so a statement can never announce twice.
export async function runOwnerStatementSweep({ SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, templatesMap = {}, preview = false }) {
  const db = { SUPABASE_URL, sbHeaders };
  if (!preview && (!WA_TOKEN || !WA_PHONE_ID)) return { skipped: 'no WhatsApp credentials' };

  const camp = await resolveCampaign(db, 'owner_statements');
  if (isCampaignPaused(camp)) return { skipped: 'campaign paused (command center)' };
  const cfg = (await getSettingValue(db, 'owner_statements')) || {};
  const cap = parseInt(cfg.notify_daily_cap, 10) || 0;
  if (!preview && cap <= 0) return { skipped: 'notify_daily_cap unset (arm in command center)' };
  if (!preview && !templatesMap[TEMPLATE_NAME]) return { skipped: `template ${TEMPLATE_NAME} not approved yet` };

  // status filter includes partial/paid: a payment recorded between publish
  // and the daily pass must not silently cancel the owner's notification.
  const queue = (await sbGet(db, `statements?status=in.(published,partial,paid)&notified_at=is.null&select=*,statement_groups(*)&order=period.asc&limit=50`)) || [];
  // Owners who haven't claimed their portal account are held, not dropped:
  // notified_at stays null, so the statement goes out on the first daily
  // pass after they onboard. Maya is never an owner's first contact.
  const claimed = await claimedGroupKeys();
  const sendable = queue.filter(st => st.statement_groups?.notify
    && (st.statement_groups?.owner_wa_nums || []).length
    && claimed.has(st.group_key));
  const heldForOnboarding = queue.filter(st => st.statement_groups?.notify
    && (st.statement_groups?.owner_wa_nums || []).length
    && !claimed.has(st.group_key)).length;
  const plan = [];
  let sent = 0, failed = 0, statementsNotified = 0;

  for (const st of sendable.slice(0, preview ? sendable.length : cap)) {
    const g = st.statement_groups;
    const tok = statementToken(st.group_key, st.period);
    const month = periodLabel(st.period);
    const payout = fmtIDR(st.payout_total);
    if (preview) {
      plan.push({ statement: `${st.group_key} ${st.period}`, to: g.owner_wa_nums, owner: g.owner_names, payout, url: `${PORTAL_BASE}/st/${tok}` });
      continue;
    }
    let anySent = false;
    for (const num of g.owner_wa_nums) {
      const to = String(num).replace(/\D/g, '');
      if (!to) continue;
      const firstName = String(g.owner_names || 'there').split(/[\s&,]+/)[0];
      const mid = await sendStatementTemplate(WA_PHONE_ID, WA_TOKEN, to, { name: firstName, month, property: g.name, payout, tok });
      if (!mid) { failed++; continue; }
      sent++; anySent = true;
      const ownerId = await ensureOwnerRow(db, to, g.owner_names);
      await sbPost(db, 'wa_messages', {
        owner_id: ownerId, wa_num: to, direction: 'outbound',
        content: `[Monthly statement sent — ${g.name} · ${month}: payout ${payout}]`,
        wa_message_id: typeof mid === 'string' ? mid : null,
        timestamp: nowIso(), source: 'cron', category: 'owner_statement',
        campaign_id: camp?.id || null, template_name: TEMPLATE_NAME, status: 'sent',
      }, 'return=minimal').catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }
    if (anySent) {
      statementsNotified++;
      await sbPatch(db, `statements?id=eq.${st.id}`, { notified_at: nowIso(), updated_at: nowIso() });
    }
  }
  if (!preview) {
    await noteRun(db, camp, { sent, failed, summary: { sent, failed, statements: statementsNotified, queued: sendable.length, held_for_onboarding: heldForOnboarding } });
  }
  return { queued: sendable.length, sent, failed, statements: statementsNotified, held_for_onboarding: heldForOnboarding, ...(preview ? { plan } : {}) };
}

async function sendStatementTemplate(phoneId, token, to, { name, month, property, payout, tok }) {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: TEMPLATE_NAME,
          language: { code: 'en' },
          components: [
            { type: 'body', parameters: [name, month, property, payout].map(text => ({ type: 'text', text: String(text) })) },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
          ],
        },
      }),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return false; }
}

// Minimal owners row so wa_messages.owner_id threads the send into the owner
// inbox. opt_in stays false (its default) — this must NOT enroll the number
// into the weekly-report push; statement notifications are driven purely by
// statement_groups.owner_wa_nums.
async function ensureOwnerRow(db, waNum, name) {
  const existing = (await sbGet(db, `owners?wa_num=eq.${waNum}&select=id&limit=1`))?.[0];
  if (existing) return existing.id;
  try {
    const rows = await sbPost(db, 'owners', { wa_num: waNum, name: name || null, notes: 'Auto-created by owner-statement notify' });
    return rows?.[0]?.id ?? null;
  } catch { return null; }
}

// ── What Maya knows about an owner's money ──────────────────────────
// Everything a managed-villa owner might ask about over WhatsApp, in one
// compact block: each PUBLISHED statement's totals, what has been paid and
// what is still owed, the bookings and the itemised expenses behind it, and
// any amendment notes. Drafts are deliberately excluded — an owner must never
// hear a number Ikiel has not yet published.
//
// Matched two ways: the number they are messaging from (statement_groups.
// owner_wa_nums), and the listing slugs on their portal account. Either is
// enough; a co-owner on a shared villa sees the shared group.
export async function ownerStatementsContext(db, { waNum, slugs = [], months = 6 } = {}) {
  const wa = String(waNum || '').replace(/\D/g, '');
  const mine = new Set((slugs || []).map(s => String(s).replace(/_/g, '-')));
  const groups = ((await sbGet(db, 'statement_groups?select=*&active=is.true')) || []).filter(g =>
    (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa))
    || (g.listing_slugs || []).some(s => mine.has(s)));
  if (!groups.length) return { text: '(no managed-villa statements on file for this owner)', groups: [] };

  const out = [];
  for (const g of groups) {
    const sts = (await sbGet(db,
      `statements?group_key=eq.${encodeURIComponent(g.key)}&status=in.(published,partial,paid)`
      + `&select=id,period,status,gross_total,commission_total,nett_total,payout_total,paid_total,revisions,hostex_snapshot,published_at`
      + `&order=period.desc&limit=${months}`)) || [];
    const tracks = g.tracks_payments !== false;
    out.push(`VILLA: ${g.name} (${(g.listing_slugs || []).join(', ')})${tracks ? '' : ' — payouts settled privately, no paid/unpaid status'}`);
    if (!sts.length) { out.push('  (no published statements yet)'); continue; }
    for (const s of sts) {
      const lines = (await sbGet(db, `statement_lines?statement_id=eq.${s.id}&select=kind,unit_name,guest_name,stay_dates,platform,nights,amount,commission,nett,expense_date,description&order=position.asc`)) || [];
      const bookings = lines.filter(l => l.kind === 'booking');
      const expenses = lines.filter(l => l.kind === 'expense');
      const adjustments = lines.filter(l => l.kind === 'adjustment');
      const owed = Number(s.payout_total) - Number(s.paid_total || 0);
      const nights = bookings.reduce((a, b) => a + (Number(b.nights) || 0), 0);
      const occ = s.hostex_snapshot?.group?.occupancy_pct;
      out.push(`\n${periodLabel(s.period)} — ${s.status.toUpperCase()}${s.published_at ? ` (published ${String(s.published_at).slice(0, 10)})` : ''}`);
      out.push(`  Gross rental income ${fmtIDR(s.gross_total)} · Samba management fee ${fmtIDR(s.commission_total)} · nett to owner ${fmtIDR(s.nett_total)}`);
      out.push(`  Expenses ${fmtIDR(expenses.reduce((a, l) => a + Number(l.amount || 0), 0))}${adjustments.length ? ` · adjustments ${fmtIDR(adjustments.reduce((a, l) => a + Number(l.amount || 0), 0))}` : ''} · PAYOUT ${fmtIDR(s.payout_total)}`);
      if (tracks) {
        out.push(owed <= 1 && Number(s.paid_total) > 0 ? `  Paid in full (${fmtIDR(s.paid_total)})`
          : Number(s.paid_total) > 0 ? `  Paid ${fmtIDR(s.paid_total)} so far, ${fmtIDR(owed)} still to come`
          : owed < -1 ? `  Negative month: deficit of ${fmtIDR(-owed)} covered by Samba and carried into the next statement`
          : `  Not yet paid out (${fmtIDR(owed)} to come)`);
      }
      out.push(`  Bookings: ${bookings.length}${nights ? `, ${nights} nights` : ''}${occ != null ? `, occupancy ${occ}%` : ''}`);
      for (const b of bookings.slice(0, 12)) {
        out.push(`    · ${[b.unit_name, b.guest_name, b.stay_dates, b.platform].filter(Boolean).join(' · ')}: ${fmtIDR(b.amount)} gross, ${fmtIDR(b.nett)} nett`);
      }
      if (expenses.length) {
        out.push(`  Expenses (${expenses.length}):`);
        for (const e of expenses.slice(0, 25)) out.push(`    · ${e.expense_date || ''} ${e.description || ''}: ${fmtIDR(e.amount)}`);
        if (expenses.length > 25) out.push(`    · … and ${expenses.length - 25} more`);
      }
      for (const a of adjustments) out.push(`  Adjustment: ${a.description || ''}: ${fmtIDR(a.amount)}`);
      const notes = (s.revisions || []).filter(r => r && !r.open && r.note).map(r => r.note);
      if (notes.length) out.push(`  Amendment notes: ${notes.join(' | ')}`);
    }
  }
  return { text: out.join('\n').slice(0, 9000), groups: groups.map(g => g.key) };
}
