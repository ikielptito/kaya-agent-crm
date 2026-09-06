// Logging an expense by telling Maya, receipt and all.
//
// Era's statements are built from her Google Sheets, and that stays the
// source of truth. But an expense happens on a Tuesday in a villa, not at
// month-end in a spreadsheet, and Ikiel's ask (6 Sep 2026) was: let her
// tell Maya "laundry HAUS 5 250rb" with a photo of the receipt, and have
// it filed. Sheets access is read-only, so Maya cannot write the row for
// her; instead:
//
//   • no statement for that month yet  → the expense waits in an inbox
//     (settings.expense_inbox) and is added the moment the month's draft
//     is created by the sheet sync, de-duplicated against the sheet;
//   • a draft exists                    → the line is added now, flagged
//     via_maya, and the sync keeps it when it re-imports the sheet;
//   • the month is already published    → it becomes a change request for
//     Ikiel to approve, the same path as "forgot to deduct".
//
// The receipt goes to the private photo bucket and is listed beside the
// statement under "Invoices & receipts". Undo removes the line or the
// inbox item within 30 minutes. A photo sent on its own within 15 minutes
// of an expense without a receipt is filed against it.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { uploadPhoto, signPhotoUrl } from './maintenance.js';
import { recomputeTotals } from './statements.js';
import { sendButtons, sendText } from './wa-interactive.js';

const INBOX_KEY = 'expense_inbox';
const WAIT_KEY = (num) => `expense_receipt_wait:${num}`;
const PARTIAL_KEY = (num) => `expense_partial:${num}`;
const MODEL = process.env.EXPENSE_LLM_MODEL || 'claude-sonnet-4-6';
const nowIso = () => new Date().toISOString();
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const idr = (n) => `IDR ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const newId = () => Math.random().toString(36).slice(2, 10);

async function sbGet(db, path) { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders }); return r.ok ? r.json() : []; }
async function sbPost(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return r.json().catch(() => []);
}
async function sbDelete(db, path) { await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: db.sbHeaders }); }

// ── The gate: does this read as spending money? ─────────────────────
// An amount and a spend word, and none of the words that belong to the
// statement-change handler (which runs first and owns those).
const AMOUNT = /(\d{1,3}([.,]\d{3})+|\d{4,}|\d+([.,]\d+)?\s*(rb|ribu|jt|juta|k)\b)/i;
const SPEND = /\b(beli|bayar|bought|paid|pay|expense|pengeluaran|biaya|invoice|receipt|nota|kwitansi|struk|laundry|gas|galon|listrik|pln|wifi|internet|pdam|air|sampah|token|pulsa|sabun|tisu|bensin|ongkos|service|servis|isi ulang|belanja|spent|cost of|for the|untuk)\b/i;
const NOT_MINE = /\b(deduct|potong|amend|revis|correct|ubah|ganti|remove|hapus|refund|discount|estimate|estimasi)\b|#\s?\d/i;
export function looksLikeExpense(text) {
  const t = String(text || '');
  return AMOUNT.test(t) && SPEND.test(t) && !NOT_MINE.test(t);
}

export function parseAmount(s) {
  const t = String(s || '').toLowerCase().replace(/idr|rp\.?/g, '').trim();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); return Math.round(n * (/jt|juta/.test(m[2]) ? 1e6 : 1e3)); }
  const d = t.match(/\d{1,3}(?:[.,]\d{3})+|\d{4,}/);
  return d ? parseInt(d[0].replace(/[.,]/g, ''), 10) : null;
}

// ── Extraction ──────────────────────────────────────────────────────
async function catalogue(db) {
  const groups = await sbGet(db, 'statement_groups?select=key,name,listing_slugs&active=is.true&order=key.asc');
  return groups.map(g => ({ key: g.key, name: g.name, slugs: g.listing_slugs || [] }));
}
export async function extractExpense(apiKey, { text, cat, partial = null }) {
  if (!apiKey) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400,
      system: 'You read a villa manager\'s WhatsApp line about money she spent and return the expense as JSON. Never invent an amount or a villa. Reply with ONLY JSON.',
      messages: [{ role: 'user', content:
`Properties (key — name — unit slugs):
${cat.map(g => `${g.key} — ${g.name} — ${g.slugs.join(', ')}`).join('\n')}

Today is ${today()} (Bali).${partial ? `\nShe was already asked to complete this expense: ${JSON.stringify(partial)}. Merge her new line into it.` : ''}

Her line:
"""${String(text).slice(0, 800)}"""

Return:
{"is_expense": true|false,
 "group_key": "<key or null>",
 "amount": <number in IDR or null; "250rb" = 250000, "1,2jt" = 1200000>,
 "description": "<what was bought or paid, short, as she wrote it, English or Indonesian>",
 "expense_date": "<YYYY-MM-DD; today unless she names a day>",
 "period": "<YYYY-MM of expense_date>",
 "unit": "<unit label like A5 or B4 if she names one within a multi-unit property, else null>",
 "confident": true|false,
 "missing": ["group_key" | "amount" | "description"]}

is_expense is true only for money spent on a villa (supplies, utilities, laundry, a repair she paid, a purchase). A question, a status update, a ticket reply or a booking is not an expense.` }],
    }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const out = JSON.parse(m[0]);
    const amount = out.amount != null ? Math.round(Number(out.amount)) : parseAmount(text);
    const missing = new Set(out.missing || []);
    if (!cat.some(g => g.key === out.group_key)) { out.group_key = null; missing.add('group_key'); }
    if (!(amount > 0)) missing.add('amount');
    if (!String(out.description || '').trim()) missing.add('description');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(out.expense_date || '')) ? out.expense_date : today();
    return { is_expense: !!out.is_expense, group_key: out.group_key, amount: amount > 0 ? amount : null, description: String(out.description || '').slice(0, 200), expense_date: date, period: date.slice(0, 7), unit: out.unit || null, confident: !!out.confident, missing: [...missing] };
  } catch { return null; }
}

// ── Filing ──────────────────────────────────────────────────────────
export async function inboxItems(db, { group_key = null, period = null, applied = false } = {}) {
  const all = (await getSettingValue(db, INBOX_KEY).catch(() => null)) || [];
  return all.filter(i => (applied || !i.applied_to) && (!group_key || i.group_key === group_key) && (!period || i.period === period));
}
async function saveInbox(db, all) { await saveSettingValue(db, INBOX_KEY, all.slice(-400)); }
export async function removeInboxItem(db, id) {
  const all = (await getSettingValue(db, INBOX_KEY).catch(() => null)) || [];
  await saveInbox(db, all.filter(i => i.id !== id));
}
async function addAttachment(db, statementId, { path, by, label }) {
  const all = (await getSettingValue(db, 'statement_attachments').catch(() => null)) || {};
  const list = all[statementId] || [];
  list.push({ path, at: nowIso(), by, for: label });
  all[statementId] = list.slice(-40);
  await saveSettingValue(db, 'statement_attachments', all);
}

// Where the expense lands: 'draft' (line added now), 'inbox' (waits for
// the month's draft), or 'published' (caller stages a change request).
export async function logExpense(db, { group_key, period, expense_date, description, amount, unit = null, receipt_path = null, by = 'era' }) {
  const st = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(group_key)}&period=eq.${period}&select=id,status&limit=1`))?.[0] || null;
  const desc = `${unit ? `${unit} · ` : ''}${String(description).slice(0, 180)}`;
  if (st && st.status !== 'draft' && st.status !== 'void') return { where: 'published', statement_id: st.id, status: st.status };
  if (st) {
    const lines = await sbGet(db, `statement_lines?statement_id=eq.${st.id}&select=position&order=position.desc&limit=1`);
    const row = {
      statement_id: st.id, kind: 'expense', position: (lines[0]?.position ?? 0) + 1,
      unit_name: null, guest_name: null, stay_dates: null, platform: null, nights: null, commission: null, nett: null,
      amount: Number(amount), expense_date, description: desc, flags: ['manual', 'via_maya'], edited: true, source_row: null,
    };
    const ins = await sbPost(db, 'statement_lines', row);
    await recomputeTotals(db, st.id);
    if (receipt_path) await addAttachment(db, st.id, { path: receipt_path, by, label: `${expense_date} · ${desc} ${idr(amount)}` });
    return { where: 'draft', statement_id: st.id, line_id: ins?.[0]?.id || null };
  }
  const all = (await getSettingValue(db, INBOX_KEY).catch(() => null)) || [];
  const item = { id: newId(), group_key, period, expense_date, description: desc, amount: Number(amount), receipt_path, by, at: nowIso(), applied_to: null };
  all.push(item);
  await saveInbox(db, all);
  return { where: 'inbox', id: item.id };
}

// Attach a receipt to the most recent log (inbox item or draft line).
export async function attachReceipt(db, ref, path, { by = 'era' } = {}) {
  if (ref.where === 'inbox') {
    const all = (await getSettingValue(db, INBOX_KEY).catch(() => null)) || [];
    const it = all.find(i => i.id === ref.id); if (!it) return false;
    it.receipt_path = path; await saveInbox(db, all); return true;
  }
  if (ref.where === 'draft' && ref.statement_id) { await addAttachment(db, ref.statement_id, { path, by, label: ref.label || 'receipt' }); return true; }
  return false;
}

// Called by the sheet sync when a month's draft is created or refreshed:
// unapplied inbox items for that group/period become via_maya lines,
// unless the sheet already carries the same expense.
export async function applyInbox(db, { statementId, group_key, period, sheetLines = [] }) {
  const items = await inboxItems(db, { group_key, period });
  if (!items.length) return { applied: 0, matched: 0 };
  const all = (await getSettingValue(db, INBOX_KEY).catch(() => null)) || [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const existing = (await sbGet(db, `statement_lines?statement_id=eq.${statementId}&select=position,kind,amount,description,flags`)) || [];
  let pos = existing.reduce((m, l) => Math.max(m, l.position ?? 0), 0) + 1;
  let applied = 0, matched = 0;
  for (const it of items) {
    const rec = all.find(x => x.id === it.id); if (!rec) continue;
    const words = norm(it.description).split(' ').filter(w => w.length > 3);
    const twin = [...sheetLines, ...existing].find(l => l.kind === 'expense' && !(l.flags || []).includes('via_maya')
      && Math.abs(Number(l.amount) - Number(it.amount)) < 1
      && (words.some(w => norm(l.description).includes(w)) || !words.length));
    if (twin) { rec.applied_to = statementId; rec.matched_sheet = true; matched++; continue; }
    const ins = await sbPost(db, 'statement_lines', {
      statement_id: statementId, kind: 'expense', position: pos++,
      unit_name: null, guest_name: null, stay_dates: null, platform: null, nights: null, commission: null, nett: null,
      amount: Number(it.amount), expense_date: it.expense_date, description: it.description, flags: ['manual', 'via_maya'], edited: true, source_row: null,
    });
    rec.applied_to = statementId; rec.line_id = ins?.[0]?.id || null; applied++;
    if (it.receipt_path) await addAttachment(db, statementId, { path: it.receipt_path, by: it.by, label: `${it.expense_date} · ${it.description} ${idr(it.amount)}` });
  }
  await saveInbox(db, all);
  if (applied) await recomputeTotals(db, statementId);
  return { applied, matched };
}

// Signed receipt links for the Payouts page.
export async function inboxForPage(db) {
  const items = await inboxItems(db);
  const names = Object.fromEntries((await sbGet(db, 'statement_groups?select=key,name')).map(g => [g.key, g.name]));
  const out = [];
  for (const it of items) out.push({ ...it, group_name: names[it.group_key] || it.group_key, receipt_url: it.receipt_path ? await signPhotoUrl(db, it.receipt_path, 3600).catch(() => null) : null });
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── The WhatsApp handler (team branch, after the statement-change one) ──
export async function handleExpenseMessage({ db, wa, fromNum, fromName = 'Era', text, mediaType = null, mediaId = null, caption = null, fetchImage = null, apiKey = process.env.ANTHROPIC_API_KEY }) {
  const num = String(fromNum || '').replace(/\D/g, '');
  const body = String(text || caption || '').replace(/^\[image\]\s*/i, '').trim();
  const hasImage = mediaType === 'image' && !!mediaId && typeof fetchImage === 'function';
  const by = fromName.toLowerCase();

  // A bare photo shortly after an expense without a receipt: file it.
  if (hasImage && !body) {
    const wait = await getSettingValue(db, WAIT_KEY(num)).catch(() => null);
    if (!wait || wait.expires_at < nowIso()) return false;
    const img = await fetchImage(mediaId).catch(() => null);
    if (!img?.base64) return false;
    const path = await uploadPhoto(db, `receipts/${wait.ref.group_key || 'misc'}/${wait.ref.period || 'x'}`, { base64: img.base64, contentType: img.contentType || 'image/jpeg' });
    const ok = await attachReceipt(db, wait.ref, path, { by });
    await saveSettingValue(db, WAIT_KEY(num), null);
    await sendText(wa, num, ok ? `Receipt filed against ${wait.ref.label}. 🧾` : 'I could not find the expense to file that receipt against — tell me which one.');
    return true;
  }

  const partial = await getSettingValue(db, PARTIAL_KEY(num)).catch(() => null);
  const partialLive = partial && partial.expires_at > nowIso() ? partial : null;
  if (!body || (!partialLive && !looksLikeExpense(body))) return false;

  const cat = await catalogue(db);
  const ex = await extractExpense(apiKey, { text: body, cat, partial: partialLive?.ex || null }).catch(() => null);
  if (!ex || !ex.is_expense) return false;
  if (ex.missing.length) {
    await saveSettingValue(db, PARTIAL_KEY(num), { ex, expires_at: new Date(Date.now() + 15 * 60e3).toISOString() });
    const ask = ex.missing.map(m => m === 'group_key' ? 'which villa' : m === 'amount' ? 'the amount' : 'what it was for').join(', ');
    await sendText(wa, num, `Got it as an expense — I just need ${ask}.`);
    return true;
  }
  await saveSettingValue(db, PARTIAL_KEY(num), null);

  let receipt_path = null;
  if (hasImage) {
    const img = await fetchImage(mediaId).catch(() => null);
    if (img?.base64) receipt_path = await uploadPhoto(db, `receipts/${ex.group_key}/${ex.period}`, { base64: img.base64, contentType: img.contentType || 'image/jpeg' }).catch(() => null);
  }
  const group = cat.find(g => g.key === ex.group_key);
  const label = `${group?.name || ex.group_key}: ${ex.description} ${idr(ex.amount)} (${ex.expense_date})`;
  const res = await logExpense(db, { group_key: ex.group_key, period: ex.period, expense_date: ex.expense_date, description: ex.description, amount: ex.amount, unit: ex.unit, receipt_path, by });

  if (res.where === 'published') {
    // The month is closed: the same approval path as any change to a
    // published statement, with the receipt riding along.
    const { handleStatementChangeRequest } = await import('./statement-requests.js');
    const line = `add expense ${ex.description} ${ex.amount} dated ${ex.expense_date} to ${group?.name || ex.group_key} ${ex.period} statement`;
    const took = await handleStatementChangeRequest({ db, wa, fromNum: num, fromName, text: line, apiKey, force: true });
    if (!took) await sendText(wa, num, `${ex.period} for ${group?.name || ex.group_key} is already ${res.status}, so this needs Ikiel's approval — ask me "add ${ex.description} ${idr(ex.amount)} to ${group?.name} ${ex.period}" and I will stage it.`);
    return true;
  }

  const monthLabel = new Date(ex.period + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const where = res.where === 'draft' ? `added to the ${monthLabel} draft for ${group?.name}` : `filed; it goes onto the ${monthLabel} statement for ${group?.name} the moment that month's draft is built from your sheet`;
  const reply = `Logged: ${ex.description}, ${idr(ex.amount)}, ${ex.expense_date}${ex.unit ? ` (${ex.unit})` : ''} — ${where}.${receipt_path ? ' Receipt filed. 🧾' : ' Send the receipt photo now and I file it with this.'}\n\nStill add it to your sheet at month end as usual — the sheet stays the record. I spot the duplicate so it is never counted twice.`;

  // Undo for 30 minutes, on the team assistant's stack.
  const uKey = `team_last_write:${num}`;
  const stack = ((await getSettingValue(db, uKey).catch(() => null)) || []).filter(w => w.expires_at > nowIso());
  const entry = { id: newId(), tool: 'log_expense', summary: label, inverse: res.where === 'draft' ? { table: 'statement_lines', delete: res.line_id, recompute: res.statement_id } : { inbox: res.id }, expires_at: new Date(Date.now() + 30 * 60e3).toISOString() };
  await saveSettingValue(db, uKey, [...stack, entry].slice(-3));
  if (!receipt_path) await saveSettingValue(db, WAIT_KEY(num), { ref: { ...res, group_key: ex.group_key, period: ex.period, label }, expires_at: new Date(Date.now() + 15 * 60e3).toISOString() });
  await sendButtons(wa, num, reply, [{ id: `team:undo:${entry.id}`, title: 'Undo' }]);
  return true;
}

// For the sync: statement lines Maya added, to survive a re-import.
export const VIA_MAYA = 'via_maya';
