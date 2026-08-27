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
import { statementToken } from './tokens.js';
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
  let meta = null;
  try { meta = await getFileMeta(group.sheet_file_id); } catch (e) { return { group: group.key, error: e.message }; }
  const state = (await getSettingValue(db, SYNC_STATE_KEY)) || {};
  if (!force && !dryRun && state[group.key]?.modifiedTime === meta.modifiedTime) {
    return { ...out, skipped: 'unchanged since last sync' };
  }

  const tabs = await listTabs(group.sheet_file_id);
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

  // One Telegram ping per group per run, however many months it produced —
  // a first backfill imports a whole year and must not storm the phone.
  if (newDrafts.length) {
    const listing = newDrafts.sort((a, b) => a.period.localeCompare(b.period))
      .map(d => `• ${periodLabel(d.period)} — ${fmtIDR(d.payout)}${d.review ? ' ⚠' : ''}`).join('\n');
    await postToTelegram(`📊 <b>${newDrafts.length === 1 ? 'New draft statement' : newDrafts.length + ' new draft statements'}</b>\n${group.name}\n${listing}\nReview &amp; publish in the admin Payouts tab.`);
  }

  state[group.key] = { modifiedTime: meta.modifiedTime, checked_at: nowIso() };
  if (!dryRun) await saveSettingValue(db, SYNC_STATE_KEY, state);
  return out;
}

export async function syncAllGroups(db, opts = {}) {
  const groups = await listGroups(db);
  const out = [];
  for (const g of groups) {
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

// ── Publish: freeze lines + snapshot Hostex month stats ─────────────
export async function publishStatement(db, id, { actor = 'admin', notifyOwner = true } = {}) {
  const st = (await sbGet(db, `statements?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!st) throw new Error('statement not found');
  if (st.status !== 'draft') throw new Error(`cannot publish a ${st.status} statement`);
  const group = (await sbGet(db, `statement_groups?key=eq.${st.group_key}&select=*&limit=1`))?.[0];

  // Hostex month aggregates, frozen now — the feed drifts (cancellations,
  // rate edits) but a statement the owner saw never does. Best-effort: a
  // portal outage shouldn't block a payout statement.
  let hostex = null;
  try {
    const slugs = (group?.listing_slugs || []).join(',');
    if (slugs) {
      const r = await fetch(`${PORTAL_BASE}/api/statements?action=month-stats&slugs=${encodeURIComponent(slugs)}&period=${st.period}`, {
        headers: { Authorization: `Bearer ${process.env.LISTING_SYNC_SECRET || ''}` },
      });
      if (r.ok) hostex = await r.json();
    }
  } catch { /* best-effort */ }

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
  if (st.notified_at) throw new Error('owner already notified — correct via adjustment lines instead');
  if (Number(st.paid_total) > 0) throw new Error('payments recorded — delete them first');
  await sbPatch(db, `statements?id=eq.${id}`, { status: 'draft', published_at: null, published_by: null, hostex_snapshot: null, updated_at: nowIso() });
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
  const pays = (await sbGet(db, `statement_payments?statement_id=eq.${id}&select=amount,paid_at&order=paid_at.asc`)) || [];
  const paidTotal = pays.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const settled = paidTotal >= Number(st.payout_total) - 1;
  const fields = {
    paid_total: paidTotal,
    updated_at: nowIso(),
  };
  // Only flip between the post-publish states — never resurrect a draft/void.
  if (['published', 'partial', 'paid'].includes(st.status)) {
    fields.status = settled && pays.length ? 'paid' : pays.length ? 'partial' : 'published';
    fields.paid_at = settled && pays.length ? pays[pays.length - 1].paid_at : null;
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
  const group = (await sbGet(db, `statement_groups?key=eq.${encodeURIComponent(groupKey)}&select=key,name,owner_names,payout_account&limit=1`))?.[0];
  const lines = await sbGet(db, `statement_lines?statement_id=eq.${st.id}&select=kind,unit_name,position,guest_name,stay_dates,platform,nights,amount,commission,nett,expense_date,description&order=position.asc`);
  const payments = await listPayments(db, st.id);
  const paidTotal = Number(st.paid_total) || 0;
  return {
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
    hostex: st.hostex_snapshot,
    lines: Array.isArray(lines) ? lines : [],
    payments: payments.map(p => ({ amount: p.amount, paid_at: p.paid_at, note: p.note, proof_url: p.proof_url })),
  };
}

// Everything the Excel export needs for one group, one call: the group, its
// published/partial/paid statements (a given year or all), lines, payments.
export async function exportData(db, groupKey, { year } = {}) {
  const group = (await sbGet(db, `statement_groups?key=eq.${encodeURIComponent(groupKey)}&select=*&limit=1`))?.[0];
  if (!group) return null;
  let q = `statements?group_key=eq.${encodeURIComponent(groupKey)}&status=in.(published,partial,paid)&select=*&order=period.asc`;
  if (year) q += `&period=like.${encodeURIComponent(year)}-*`;
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
  const sendable = queue.filter(st => st.statement_groups?.notify && (st.statement_groups?.owner_wa_nums || []).length);
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
    await noteRun(db, camp, { sent, failed, summary: { sent, failed, statements: statementsNotified, queued: sendable.length } });
  }
  return { queued: sendable.length, sent, failed, statements: statementsNotified, ...(preview ? { plan } : {}) };
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
