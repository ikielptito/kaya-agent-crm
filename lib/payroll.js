// ── STAFF PAYROLL ORCHESTRATION ──────────────────────────────────────
// Era's "Staff Salary and Expenses" sheet → one payroll_run per month →
// payee view (who gets paid what, one transfer each) and property view
// (what each villa's staff cost, next to that month's owner statement).
//
// Same non-clobber contract as lib/statements.js: an untouched draft
// follows the sheet, a draft Ikiel edited is never overwritten (flag and
// alert), a published run is immutable (record the drift, alert).
//
// db = { SUPABASE_URL, sbHeaders }.

import crypto from 'node:crypto';
import { listTabs, getTabValues, getFileMeta, sheetsConfigured } from './sheets.js';
import { parsePayrollTab, isPayable } from './payroll-parser.js';
import { listStaff } from './staff.js';
import { postToTelegram } from './telegram.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';

const SETTINGS_KEY = 'payroll';
const SYNC_STATE_KEY = 'payroll_sync_state';
const PROOF_BUCKET = 'payout-proofs';
const DEFAULT_SHEET = '1QREAhDjQAWgYxSPWXgqqDZX8GRUJN6NCx6R8j5LJdIA';
const DEFAULT_UNPAID = ['haus-1', 'haus-2', 'haus-4', 'haus-5', 'tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'];

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
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) });
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
const witaPeriod = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);

export async function payrollSettings(db) {
  const v = (await getSettingValue(db, SETTINGS_KEY)) || {};
  return {
    sheet_file_id: v.sheet_file_id || DEFAULT_SHEET,
    unpaid_slugs: Array.isArray(v.unpaid_slugs) ? v.unpaid_slugs : DEFAULT_UNPAID,
  };
}
export async function patchPayrollSettings(db, fields = {}) {
  const cur = await payrollSettings(db);
  const next = { ...cur };
  if (typeof fields.sheet_file_id === 'string' && fields.sheet_file_id.trim()) next.sheet_file_id = fields.sheet_file_id.trim();
  if (Array.isArray(fields.unpaid_slugs)) next.unpaid_slugs = fields.unpaid_slugs.map(String);
  await saveSettingValue(db, SETTINGS_KEY, next);
  return next;
}

// ── Lines ────────────────────────────────────────────────────────────
// Uniform key set (PostgREST bulk inserts need it).
const LINE_DEFAULTS = {
  category: 'other', payee: '', person_name: null, staff_id: null, role: null,
  description: null, slugs: [], amount: 0, flags: [], edited: false, source_row: null, position: 0,
};
const fullLine = (l) => ({ ...LINE_DEFAULTS, ...l });

// run_total is what gets paid out. Balance-carried, receipts and the petty
// cash float are memo lines: shown, never paid (Era's own TOTAL excludes them).
function totalsFromLines(lines) {
  const salary_total = lines.filter(l => l.category === 'salary').reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const run_total = lines.filter(isPayable).reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const memo_total = lines.filter(l => !isPayable(l)).reduce((a, l) => a + (Number(l.amount) || 0), 0);
  return { salary_total, other_total: run_total - salary_total, run_total, memo_total };
}
export async function recomputeTotals(db, runId) {
  const lines = (await sbGet(db, `payroll_lines?run_id=eq.${runId}&select=category,amount`)) || [];
  // (isPayable reads only category, so this narrow select is enough.)
  const totals = totalsFromLines(lines);
  await sbPatch(db, `payroll_runs?id=eq.${runId}`, { ...totals, updated_at: nowIso() });
  return totals;
}

// ── Probe: the read-only first look at the sheet ─────────────────────
export async function probePayroll(db, { tab = null, maxRows = 80 } = {}) {
  if (!sheetsConfigured()) throw new Error('Google OAuth not configured');
  const cfg = await payrollSettings(db);
  const meta = await getFileMeta(cfg.sheet_file_id);
  const tabs = await listTabs(cfg.sheet_file_id);
  const pick = tab ? tabs.find(t => t.title === tab) : tabs[0];
  if (!pick) return { file: meta, tabs, error: 'tab not found' };
  const rows = await getTabValues(cfg.sheet_file_id, pick.title);
  const staff = ((await listStaff(db)) || []).filter(x => (x.entity || 'samba') === 'samba');
  const parsed = parsePayrollTab(rows, { tabTitle: pick.title, staff, unpaidSlugs: cfg.unpaid_slugs });
  return { file: meta, tabs, tab: pick.title, rows: rows.slice(0, maxRows), parsed };
}

// ── Sync ─────────────────────────────────────────────────────────────
export const ENTITIES = {
  samba: { key: 'samba', name: 'Samba', source: 'sheet' },
  double8: { key: 'double8', name: 'Double 8', source: 'ledger', group_key: 'tropicana-b2356' },
};
export const entityOf = (e) => ENTITIES[String(e || 'samba')] ? String(e || 'samba') : null;

// Both entities in one pass (the daily cron).
export async function syncAllPayroll(db, opts = {}) {
  const out = {};
  try { out.samba = await syncPayroll(db, opts); } catch (e) { out.samba = { error: e.message }; }
  try { out.double8 = await syncDouble8(db, opts); } catch (e) { out.double8 = { error: e.message }; }
  return out;
}

export async function syncPayroll(db, { dryRun = false, force = false } = {}) {
  if (!sheetsConfigured()) return { error: 'Google OAuth not configured' };
  const cfg = await payrollSettings(db);
  const out = { tabs: 0, created: 0, updated: 0, unchanged: 0, kept_edits: 0, discrepancies: 0, skipped: null, runs: [] };

  let meta = null;
  try { meta = await getFileMeta(cfg.sheet_file_id); } catch (e) { return { error: e.message }; }
  const state = (await getSettingValue(db, SYNC_STATE_KEY)) || {};
  if (!force && !dryRun && state.modifiedTime === meta.modifiedTime) return { ...out, skipped: 'unchanged since last sync' };

  const staff = ((await listStaff(db)) || []).filter(x => (x.entity || 'samba') === 'samba');
  const tabs = await listTabs(cfg.sheet_file_id);
  const newDrafts = [];
  for (const tab of tabs) {
    let parsed;
    try { parsed = parsePayrollTab(await getTabValues(cfg.sheet_file_id, tab.title), { tabTitle: tab.title, staff, unpaidSlugs: cfg.unpaid_slugs }); }
    catch (e) { out.runs.push({ tab: tab.title, error: e.message }); continue; }
    if (!parsed) continue;
    out.tabs++;
    // A sheet Era overwrites in place carries no month anywhere: it is the
    // current month, flagged so the review shows the assumption.
    let period = parsed.period;
    const periodFlags = [...parsed.period_flags];
    if (!period) { period = witaPeriod(); periodFlags.push('period_assumed'); }

    if (dryRun) { out.runs.push({ tab: tab.title, period, period_flags: periodFlags, totals: parsed.totals, era_total: parsed.era_total, needs_review: parsed.needs_review, checks: parsed.reconciliation.checks, lines: parsed.lines.length }); continue; }

    const existing = (await sbGet(db, `payroll_runs?entity=eq.samba&period=eq.${period}&select=*&limit=1`))?.[0] || null;
    if (existing && existing.source_hash === parsed.source_hash) {
      const anyLine = (await sbGet(db, `payroll_lines?run_id=eq.${existing.id}&select=id&limit=1`))?.[0];
      if (anyLine || existing.status !== 'draft' || existing.has_manual_edits) { out.unchanged++; continue; }
    }
    if (existing && ['published', 'partial', 'paid'].includes(existing.status)) {
      out.discrepancies++;
      if (existing.source_changed) continue;
      await sbPatch(db, `payroll_runs?id=eq.${existing.id}`, {
        source_changed: true,
        discrepancy: { detected_at: nowIso(), note: `Era edited tab "${tab.title}" after this run was ${existing.status}`, new_total: parsed.totals.run_total, published_total: existing.run_total },
        updated_at: nowIso(),
      });
      await postToTelegram(`⚠️ <b>Payroll sheet changed after publish</b>\n${periodLabel(period)} (${existing.status})\nSheet now totals ${fmtIDR(parsed.totals.run_total)} vs published ${fmtIDR(existing.run_total)}. Review in the Payroll tab.`);
      continue;
    }
    if (existing && existing.has_manual_edits) {
      out.kept_edits++;
      if (existing.source_changed) continue;
      await sbPatch(db, `payroll_runs?id=eq.${existing.id}`, { source_changed: true, updated_at: nowIso() });
      await postToTelegram(`✏️ <b>Era updated a payroll draft you've edited</b>\n${periodLabel(period)}\nYour manual edits are kept. Use "Re-import" in the Payroll tab to discard them.`);
      continue;
    }

    const lines = parsed.lines.map(fullLine);
    const fields = {
      ...parsed.totals, era_total: parsed.era_total,
      reconciliation: parsed.reconciliation, needs_review: parsed.needs_review,
      period_flags: periodFlags, source_hash: parsed.source_hash, source_tab: tab.title,
      parsed_at: nowIso(), source_changed: false, updated_at: nowIso(),
    };
    let runId;
    if (existing) {
      await sbPatch(db, `payroll_runs?id=eq.${existing.id}`, fields);
      await sbDelete(db, `payroll_lines?run_id=eq.${existing.id}`);
      runId = existing.id; out.updated++;
    } else {
      const ins = await sbPost(db, 'payroll_runs', { entity: 'samba', period, status: 'draft', ...fields });
      runId = ins?.[0]?.id; out.created++;
      newDrafts.push({ period, total: parsed.totals.run_total, review: parsed.needs_review });
    }
    if (runId && lines.length) await sbPost(db, 'payroll_lines', lines.map(l => ({ ...l, run_id: runId })), 'return=minimal');
    out.runs.push({ tab: tab.title, period, action: existing ? 'updated' : 'created', total: parsed.totals.run_total, needs_review: parsed.needs_review });
  }

  if (newDrafts.length) {
    const listing = newDrafts.sort((a, b) => a.period.localeCompare(b.period))
      .map(d => `• ${periodLabel(d.period)} — ${fmtIDR(d.total)}${d.review ? ' ⚠' : ''}`).join('\n');
    await postToTelegram(`👥 <b>${newDrafts.length === 1 ? 'New payroll draft' : newDrafts.length + ' new payroll drafts'}</b>\n${listing}\nReview in the Payroll tab.`);
  }
  if (!dryRun) await saveSettingValue(db, SYNC_STATE_KEY, { modifiedTime: meta.modifiedTime, checked_at: nowIso() });
  return out;
}

export async function reimportRun(db, id) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=id,status,entity&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  if (run.status !== 'draft') throw new Error('only drafts can be re-imported');
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { has_manual_edits: false, source_hash: null, updated_at: nowIso() });
  return run.entity === 'double8' ? syncDouble8(db, { force: true }) : syncPayroll(db, { force: true });
}

// ── Views ────────────────────────────────────────────────────────────
// Payee view: one row per person or label, with what was paid so far.
export function payeeView(lines, payments = []) {
  const by = new Map();
  for (const l of lines) {
    if (!isPayable(l)) continue;
    const k = l.payee;
    const row = by.get(k) || { payee: k, staff_id: l.staff_id, category: l.category, role: l.role, lines: [], total: 0, paid: 0, slugs: new Set() };
    row.lines.push(l);
    row.total += Number(l.amount) || 0;
    for (const s of l.slugs || []) row.slugs.add(s);
    if (l.staff_id && !row.staff_id) row.staff_id = l.staff_id;
    by.set(k, row);
  }
  for (const p of payments) {
    if (p.status === 'returned') continue;
    const row = by.get(p.payee);
    if (row) row.paid += Number(p.amount) || 0;
  }
  return [...by.values()].map(r => ({ ...r, slugs: [...r.slugs].sort(), balance: r.total - r.paid }))
    .sort((a, b) => (a.category === 'salary' ? 0 : 1) - (b.category === 'salary' ? 0 : 1) || b.total - a.total);
}

// Property view: each line's amount split evenly across its properties;
// lines with none land on Samba overhead.
export function propertyView(lines) {
  const by = new Map();
  for (const l of lines) {
    if (!isPayable(l)) continue;
    const amt = Number(l.amount) || 0;
    const slugs = (l.slugs || []).length ? l.slugs : ['samba'];
    const share = amt / slugs.length;
    for (const s of slugs) {
      const row = by.get(s) || { slug: s, total: 0, salary: 0, other: 0, lines: 0 };
      row.total += share;
      if (l.category === 'salary') row.salary += share; else row.other += share;
      row.lines++;
      by.set(s, row);
    }
  }
  return [...by.values()].sort((a, b) => (a.slug === 'samba') - (b.slug === 'samba') || a.slug.localeCompare(b.slug));
}

// The property view next to that month's owner statements: for each
// statement group, the staff cost allocated to its units vs the expenses
// the owner was charged. Groups with no statement that month show null.
async function statementComparison(db, period, props) {
  const groups = (await sbGet(db, 'statement_groups?select=key,name,listing_slugs,active&active=eq.true')) || [];
  const stmts = (await sbGet(db, `statements?period=eq.${period}&select=id,group_key,status,expenses_total,payout_total`)) || [];
  const bySlug = new Map(props.map(p => [p.slug, p]));
  return groups.map(g => {
    const slugs = g.listing_slugs || [];
    const allocated = slugs.reduce((a, s) => a + (bySlug.get(s)?.total || 0), 0);
    const st = stmts.find(s => s.group_key === g.key) || null;
    return {
      group_key: g.key, name: g.name, slugs, allocated,
      statement: st ? { id: st.id, status: st.status, expenses_total: Number(st.expenses_total) || 0 } : null,
    };
  }).filter(g => g.allocated > 0 || g.statement);
}

export async function listRuns(db, { entity = 'samba' } = {}) {
  const runs = (await sbGet(db, `payroll_runs?entity=eq.${entity}&select=*&order=period.desc&limit=60`)) || [];
  const outstanding = runs.filter(r => ['published', 'partial'].includes(r.status));
  return {
    runs,
    outstanding: { count: outstanding.length, total: outstanding.reduce((a, r) => a + Math.max(0, (Number(r.run_total) || 0) - (Number(r.paid_total) || 0)), 0) },
  };
}

export async function runDetail(db, id) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!run) return null;
  const lines = (await sbGet(db, `payroll_lines?run_id=eq.${id}&select=*&order=position.asc,id.asc`)) || [];
  const payments = await listPayments(db, id);
  const props = propertyView(lines);
  const ent = ENTITIES[run.entity || 'samba'] || ENTITIES.samba;
  return {
    run, lines, payments,
    entity: ent,
    payees: payeeView(lines, payments),
    properties: props,
    statements: ent.source === 'sheet' ? await statementComparison(db, run.period, props) : [],
    period_label: periodLabel(run.period),
  };
}

// ── Editing (drafts only) ────────────────────────────────────────────
const EDITABLE = new Set(['category', 'payee', 'person_name', 'staff_id', 'role', 'description', 'slugs', 'amount', 'position']);
async function editableRun(db, id) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=id,status&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  if (run.status !== 'draft') throw new Error(`run is ${run.status} — lines are frozen`);
  return run;
}
export async function patchLine(db, id, lineId, fields = {}) {
  await editableRun(db, id);
  const f = {};
  for (const [k, v] of Object.entries(fields)) if (EDITABLE.has(k)) f[k] = v;
  if (!Object.keys(f).length) throw new Error('no editable fields');
  if ('amount' in f) f.amount = Number(f.amount) || 0;
  await sbPatch(db, `payroll_lines?id=eq.${parseInt(lineId, 10)}&run_id=eq.${id}`, { ...f, edited: true });
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { has_manual_edits: true });
  return { ok: true, totals: await recomputeTotals(db, id) };
}
export async function addLine(db, id, fields = {}) {
  await editableRun(db, id);
  const maxPos = (await sbGet(db, `payroll_lines?run_id=eq.${id}&select=position&order=position.desc&limit=1`))?.[0]?.position ?? 0;
  const row = fullLine({ position: maxPos + 1, edited: true, flags: ['manual'] });
  for (const [k, v] of Object.entries(fields)) if (EDITABLE.has(k) && k !== 'position') row[k] = v;
  row.amount = Number(row.amount) || 0;
  if (!row.payee) throw new Error('payee is required');
  await sbPost(db, 'payroll_lines', { ...row, run_id: id }, 'return=minimal');
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { has_manual_edits: true });
  return { ok: true, totals: await recomputeTotals(db, id) };
}
export async function deleteLine(db, id, lineId) {
  await editableRun(db, id);
  await sbDelete(db, `payroll_lines?id=eq.${parseInt(lineId, 10)}&run_id=eq.${id}`);
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { has_manual_edits: true });
  return { ok: true, totals: await recomputeTotals(db, id) };
}

// ── Publish / unpublish ──────────────────────────────────────────────
// Publishing freezes the lines; it is the "this is what I'm paying" step.
export async function publishRun(db, id, { actor = 'admin' } = {}) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  if (run.status !== 'draft') throw new Error(`run is already ${run.status}`);
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { status: 'published', published_at: nowIso(), published_by: actor, updated_at: nowIso() });
  return { ok: true, status: 'published' };
}
export async function unpublishRun(db, id) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=id,status,paid_total&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  if (run.status !== 'published') throw new Error(`cannot unpublish a ${run.status} run`);
  if (Number(run.paid_total) > 0) throw new Error('payments already recorded — delete them first');
  await sbPatch(db, `payroll_runs?id=eq.${id}`, { status: 'draft', published_at: null, published_by: null, updated_at: nowIso() });
  return { ok: true, status: 'draft' };
}

// ── Payments ─────────────────────────────────────────────────────────
async function recomputePayments(db, id) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=id,status,run_total&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  const pays = (await sbGet(db, `payroll_payments?run_id=eq.${id}&select=amount,paid_at,status&order=paid_at.asc`)) || [];
  const cleared = pays.filter(p => p.status !== 'returned');
  const paidTotal = cleared.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const settled = paidTotal >= Number(run.run_total) - 1;
  const fields = { paid_total: paidTotal, updated_at: nowIso() };
  if (['published', 'partial', 'paid'].includes(run.status)) {
    fields.status = settled && cleared.length ? 'paid' : cleared.length ? 'partial' : 'published';
    fields.paid_at = settled && cleared.length ? cleared[cleared.length - 1].paid_at : null;
  }
  await sbPatch(db, `payroll_runs?id=eq.${id}`, fields);
  return { paid_total: paidTotal, balance: Number(run.run_total) - paidTotal, status: fields.status || run.status };
}
export async function recordPayment(db, id, { payee, staffId, amount, note, paidAt, base64, contentType } = {}) {
  const run = (await sbGet(db, `payroll_runs?id=eq.${id}&select=id,status,period&limit=1`))?.[0];
  if (!run) throw new Error('run not found');
  if (!['published', 'partial'].includes(run.status)) throw new Error(`cannot record a payment on a ${run.status} run`);
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new Error('payment amount must be a positive number');
  if (!payee) throw new Error('payee is required');
  let proofPath = null;
  if (base64) proofPath = await uploadProof(db, run, { base64, contentType });
  await sbPost(db, 'payroll_payments', {
    run_id: id, payee: String(payee), staff_id: staffId ? parseInt(staffId, 10) : null,
    amount: amt, note: note || null, proof_path: proofPath, paid_at: paidAt || nowIso(),
  }, 'return=minimal');
  return recomputePayments(db, id);
}
export async function deletePayment(db, id, paymentId) {
  await sbDelete(db, `payroll_payments?id=eq.${parseInt(paymentId, 10)}&run_id=eq.${id}`);
  return recomputePayments(db, id);
}
export async function listPayments(db, id) {
  const pays = (await sbGet(db, `payroll_payments?run_id=eq.${id}&select=*&order=paid_at.asc`)) || [];
  for (const p of pays) p.proof_url = p.proof_path ? await signProofUrl(db, p.proof_path) : null;
  return pays;
}
async function uploadProof(db, run, { base64, contentType }) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(String(contentType))) throw new Error('proof must be a jpeg/png/webp image');
  const bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length) throw new Error('empty upload');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('image too large');
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  const path = `payroll/${run.period}-${Date.now()}.${ext}`;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/${PROOF_BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!r.ok) throw new Error(`proof upload → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return path;
}
async function signProofUrl(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/sign/${PROOF_BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.signedURL ? `${db.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}


// ── Double 8: payroll derived from the DOUBLE EIGHT ledger ───────────
// Oli pays the Tropicana B staff from the salary rows Era writes on the
// expense ledger (the sheet whose screenshot she sends him monthly). Those
// rows already reach the Tropicana B statements as expense lines, so the
// Double 8 payroll run is a view over them: one run per statement month,
// the salary lines as payroll lines, payments recorded per payee. Money
// never crosses into Samba's runs.
const SALARY_RE = /salary|salaries|gaji/i;
const ROLE_HINT_RE = /housekeep|\bhk\b|pool|garden/i;
const NOT_SALARY_RE = /maintenance|machine|fix|repair|bulb|electric|chemical|material|laundry|internet|water/i;
export function isLedgerSalaryLine(l) {
  const d = String(l.description || '');
  if (SALARY_RE.test(d)) return true;
  return ROLE_HINT_RE.test(d) && !NOT_SALARY_RE.test(d) && Number(l.amount) >= 500000;
}
function ledgerRole(desc) {
  const d = String(desc || '');
  if (/housekeep|\bhk\b/i.test(d)) return 'housekeeper';
  if (/pool/i.test(d)) return 'pool';
  if (/garden/i.test(d)) return 'gardener';
  return null;
}
function ledgerSlugs(desc, all) {
  const out = new Set();
  String(desc || '').replace(/\b([ab])\s*(\d)\b/gi, (_, l, n) => { out.add(`tropicana-${l.toLowerCase()}${n}`); return ''; });
  return out.size ? [...out].filter(s => all.includes(s)) : all;
}
export async function syncDouble8(db, { dryRun = false } = {}) {
  const ent = ENTITIES.double8;
  const group = (await sbGet(db, `statement_groups?key=eq.${ent.group_key}&select=key,name,listing_slugs&limit=1`))?.[0];
  if (!group) return { error: `group ${ent.group_key} not found` };
  const slugsAll = group.listing_slugs || [];
  const staff = ((await listStaff(db)) || []).filter(x => x.entity === 'double8' && x.active !== false);
  const stmts = (await sbGet(db, `statements?group_key=eq.${ent.group_key}&status=neq.void&select=id,period,status&order=period.asc`)) || [];
  const out = { months: stmts.length, created: 0, updated: 0, unchanged: 0, kept_edits: 0, discrepancies: 0, runs: [] };
  for (const st of stmts) {
    const raw = (await sbGet(db, `statement_lines?statement_id=eq.${st.id}&kind=eq.expense&select=id,description,amount,expense_date,position&order=position.asc`)) || [];
    const lines = raw.filter(isLedgerSalaryLine).map((l, i) => {
      const role = ledgerRole(l.description);
      const person = role ? staff.find(x => (x.roles || []).includes(role)) : null;
      return fullLine({
        category: 'salary', payee: person ? person.name : String(l.description || 'Salary').trim(),
        person_name: person ? person.name : null, staff_id: person?.id ?? null, role,
        description: l.description, slugs: ledgerSlugs(l.description, slugsAll), amount: Number(l.amount) || 0,
        flags: person ? [] : ['not_in_registry'], source_row: l.id, position: i,
      });
    });
    const hash = crypto.createHash('sha256').update(JSON.stringify(lines.map(l => [l.description, l.amount, l.payee]))).digest('hex');
    const existing = (await sbGet(db, `payroll_runs?entity=eq.double8&period=eq.${st.period}&select=*&limit=1`))?.[0] || null;
    if (existing && existing.source_hash === hash) { out.unchanged++; continue; }
    if (existing && ['published', 'partial', 'paid'].includes(existing.status)) {
      out.discrepancies++;
      if (!existing.source_changed) {
        await sbPatch(db, `payroll_runs?id=eq.${existing.id}`, { source_changed: true, discrepancy: { detected_at: nowIso(), note: `Ledger salary lines for ${periodLabel(st.period)} changed after this run was ${existing.status}` }, updated_at: nowIso() });
      }
      continue;
    }
    if (existing && existing.has_manual_edits) { out.kept_edits++; continue; }
    if (dryRun) { out.runs.push({ period: st.period, action: existing ? 'update' : 'create', lines: lines.length, total: lines.reduce((a, l) => a + l.amount, 0) }); continue; }
    const totals = totalsFromLines(lines);
    const checks = [{ name: 'salary_lines_found', ok: lines.length > 0, actual: lines.length }];
    const fields = { ...totals, era_total: null, reconciliation: { checks, unparsed_rows: [] }, needs_review: lines.some(l => l.flags.includes('not_in_registry')), period_flags: [], source_hash: hash, source_tab: `Tropicana B statement · ${periodLabel(st.period)}`, source_statement_id: st.id, parsed_at: nowIso(), source_changed: false, updated_at: nowIso() };
    let runId;
    if (existing) { await sbPatch(db, `payroll_runs?id=eq.${existing.id}`, fields); await sbDelete(db, `payroll_lines?run_id=eq.${existing.id}`); runId = existing.id; out.updated++; }
    else { const ins = await sbPost(db, 'payroll_runs', { entity: 'double8', period: st.period, status: 'draft', ...fields }); runId = ins?.[0]?.id; out.created++; }
    if (runId && lines.length) await sbPost(db, 'payroll_lines', lines.map(l => ({ ...l, run_id: runId })), 'return=minimal');
    out.runs.push({ period: st.period, action: existing ? 'updated' : 'created', lines: lines.length, total: totals.run_total });
  }
  return out;
}

// A note from whoever is using the tab (Oli shaping the feature) straight
// to Ikiel's Telegram, with who and where it came from.
export async function sendFeedback(db, { entity, from, text, run_period } = {}) {
  const body = String(text || '').trim().slice(0, 1500);
  if (!body) throw new Error('feedback text required');
  await postToTelegram(`💬 <b>Payroll feedback</b> · ${ENTITIES[entity]?.name || entity || 'Samba'}${from ? ` · from ${from}` : ''}${run_period ? ` · ${periodLabel(run_period)}` : ''}\n${body}`);
  return { ok: true };
}
