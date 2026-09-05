// ── STATEMENT CHANGES ASKED FOR OVER WHATSAPP ────────────────────────
// Era: "I forgot to deduct the curtains, 2,500,000, from Tropicana A5's
// August payout." Maya turns that into a precise change, reads it back,
// and on Era's YES applies it:
//   • a DRAFT statement changes on the spot (it is not yet anyone's number)
//   • a PUBLISHED statement becomes an approval on Ikiel's Telegram; his
//     tap runs a proper amendment (history kept, "Revised" note, owner not
//     messaged unless he chooses to on the Payouts page)
// Nothing here guesses: missing amount, month or property is asked for.
// State lives in settings: stmt_change:<num> (the request in progress,
// 30 min) and stmt_change_approvals (pending taps, 7 days).

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { postToTelegram } from './telegram.js';
import { recomputeTotals, amendStart, amendFinalize, periodLabel } from './statements.js';
import { uploadPhoto, signPhotoUrl } from './maintenance.js';
import { postTelegramPhoto } from './telegram.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const MODEL = process.env.MAINTENANCE_LLM_MODEL || 'claude-haiku-4-5-20251001';
const PENDING_MS = 30 * 60e3;
const APPROVAL_MS = 7 * 86400e3;
const nowIso = () => new Date().toISOString();
const fmtIDR = (n) => `IDR ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const keyFor = (num) => `stmt_change:${String(num).replace(/\D/g, '')}`;

const GATE_RE = /deduct|potong|kurang|tambah|\badd\b|forgot|lupa|amend|revis|correct|ubah|ganti|expense|biaya|cost|payout|statement|report|remove|hapus|refund|discount/i;
const YES_RE = /^(yes|y|ya|yes please|ok(ay)?|oke|sure|betul|benar|siap|correct|confirm(ed)?|go ahead|do it|👍)[\s.!]*$/i;
const NO_RE = /^(no|nope|cancel|batal|jangan|tidak|stop|wrong|salah)[\s.!]*$/i;

async function sbGet(db, path) { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders }); return r.ok ? r.json() : null; }
async function sbPost(db, path, body) { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`insert ${path} → ${r.status}`); }
async function sbPatch(db, path, body) { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`patch ${path} → ${r.status}`); }
async function sbDelete(db, path) { await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: db.sbHeaders }); }

export async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    return r.ok ? ((await r.json().catch(() => ({})))?.messages?.[0]?.id || true) : null;
  } catch { return null; }
}

// The catalogue the model chooses from: every active group and its last
// six statements (period, status, id, payout). Small, and it makes the
// extraction a lookup rather than a guess.
async function catalogue(db) {
  const groups = (await sbGet(db, 'statement_groups?select=key,name,listing_slugs&active=eq.true&order=key.asc')) || [];
  const stmts = (await sbGet(db, 'statements?select=id,group_key,period,status,payout_total&status=neq.void&order=period.desc&limit=200')) || [];
  const byGroup = {};
  for (const s of stmts) (byGroup[s.group_key] ||= []).push(s);
  return groups.map(g => ({ key: g.key, name: g.name, slugs: g.listing_slugs || [], statements: (byGroup[g.key] || []).slice(0, 6) }));
}

const describe = (c) => c.op === 'remove'
  ? `remove ${c.kind} "${c.description}"${c.amount ? ` (${fmtIDR(c.amount)})` : ''}`
  : c.op === 'change'
    ? `change ${c.kind} "${c.description}" to ${fmtIDR(c.amount)}`
    : `add ${c.kind} "${c.description}"${c.date ? ` dated ${c.date}` : ''} ${fmtIDR(c.amount)}`;

async function extract(apiKey, { text, cat, pending, fromName }) {
  const prompt = `You are Maya, Samba Realty's assistant. ${fromName} (Samba's villa manager) is asking you to change a monthly owner statement over WhatsApp. Turn the request into a precise change against the catalogue below. Property names are informal ("A5", "Tropicana A5", "Saturno", "Haus 2&4", "Lane Haus"); months may be named or implied ("last month" = the month before the current one; today is ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}).

CATALOGUE (group key · name · units · statements as period/status/id):
${cat.map(g => `- ${g.key} · ${g.name} · ${g.slugs.join(', ')} · ${g.statements.map(s => `${s.period}/${s.status}/#${s.id}`).join(' ')}`).join('\n')}
${pending ? `\nA REQUEST IS ALREADY IN PROGRESS (they are correcting or completing it): ${JSON.stringify({ group_key: pending.group_key, period: pending.period, changes: pending.changes, missing: pending.missing })}` : ''}

They wrote: "${text}"

Reply with ONLY a JSON object:
{"related": true|false,
 "group_key": "<from the catalogue or null>",
 "period": "YYYY-MM or null",
 "changes": [{"op":"add"|"remove"|"change", "kind":"expense"|"adjustment", "description":"<short, as Era would write it on her sheet>", "amount": <number in IDR or null>, "date":"<DD Mon YYYY or null>"}],
 "missing": ["amount"|"period"|"property"|"description" ...],
 "reply": "<short WhatsApp reply in their language: read the change back exactly (property, month, line, amount) and ask them to reply YES to confirm; or ask for what is missing. No lists, no formality.>"}

"related" is false when the message is not about changing a statement (then everything else is ignored). "adjustment" is for a signed correction that is not a villa expense (a discount, a refund, money already paid); an expense is a cost paid for the villa — the curtains, a repair, a bill. Amounts like "2.5jt" = 2500000, "250rb" = 250000. Never invent an amount or a month they did not give.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const m = t.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

function summary(req) {
  const g = req.group_name || req.group_key;
  return `${g} · ${periodLabel(req.period)}: ${req.changes.map(describe).join('; ')}`;
}

// Apply the changes to a statement's lines. Returns the labels applied.
async function applyChanges(db, statementId, changes, flag) {
  const lines = (await sbGet(db, `statement_lines?statement_id=eq.${statementId}&select=*&order=position.asc,id.asc`)) || [];
  let pos = (lines[lines.length - 1]?.position ?? 0) + 1;
  const applied = [];
  for (const c of changes) {
    const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (c.op === 'remove' || c.op === 'change') {
      const target = lines.find(l => l.kind === c.kind && norm(l.description) === norm(c.description))
        || lines.find(l => l.kind === c.kind && norm(l.description).includes(norm(c.description)))
        || lines.find(l => l.kind === c.kind && c.amount && Math.abs(Number(l.amount) - Number(c.amount)) < 1);
      if (!target) throw new Error(`could not find the ${c.kind} "${c.description}" on that statement`);
      if (c.op === 'remove') { await sbDelete(db, `statement_lines?id=eq.${target.id}`); applied.push({ kind: c.kind, change: 'removed', label: `${target.expense_date ? target.expense_date + ' · ' : ''}${target.description}`, amount: target.amount }); }
      else { await sbPatch(db, `statement_lines?id=eq.${target.id}`, { amount: Number(c.amount), edited: true }); applied.push({ kind: c.kind, change: 'changed', label: `${target.expense_date ? target.expense_date + ' · ' : ''}${target.description}`, from: Number(target.amount), to: Number(c.amount) }); }
      continue;
    }
    const row = {
      statement_id: statementId, kind: c.kind === 'adjustment' ? 'adjustment' : 'expense', position: pos++,
      unit_name: null, guest_name: null, stay_dates: null, platform: null, nights: null, commission: null, nett: null,
      amount: Number(c.amount), expense_date: c.kind === 'adjustment' ? null : (c.date || null),
      description: String(c.description || (c.kind === 'adjustment' ? 'Adjustment' : 'Expense')).slice(0, 200),
      flags: ['manual', flag], edited: true, source_row: null,
    };
    await sbPost(db, 'statement_lines', row);
    applied.push({ kind: row.kind, change: 'added', label: `${row.expense_date ? row.expense_date + ' · ' : ''}${row.description}`, amount: row.amount });
  }
  return applied;
}

// Returns true when the message was consumed.
export async function handleStatementChangeRequest({ db, wa, fromNum, fromName = 'Era', text, apiKey, mediaType = null, mediaId = null, caption = null, fetchImage = null }) {
  const body = String(text || caption || '').replace(/^\[image\]\s*/i, '').replace(/^"|"$/g, '').trim();
  if (!apiKey) return false;
  const key = keyFor(fromNum);
  let pending = await getSettingValue(db, key);
  if (pending && (!pending.expires_at || Date.parse(pending.expires_at) < Date.now())) { pending = null; await saveSettingValue(db, key, null); }
  const hasImage = mediaType === 'image' && !!mediaId && !!fetchImage;

  // A photo of the invoice: keep it with the request. With no words and no
  // request in progress it is not ours (a maintenance photo, most likely).
  if (hasImage) {
    if (!pending && !GATE_RE.test(body)) return false;
    let path = null;
    try {
      const img = await fetchImage(mediaId);
      if (img?.base64) path = await uploadPhoto(db, 'invoices', { base64: img.base64, contentType: img.contentType || 'image/jpeg' });
    } catch { path = null; }
    if (pending) {
      pending.attachments = [...(pending.attachments || []), ...(path ? [{ path, at: nowIso() }] : [])];
      await saveSettingValue(db, key, pending);
      if (!body) {
        await sendText(wa, fromNum, path ? `Got the invoice, I'll attach it. ${pending.ready ? 'Reply YES to confirm the change.' : `Still need: ${(pending.missing || []).join(', ')}.`}` : 'I could not open that photo, but the change still stands. Try sending it again?');
        return true;
      }
      pending.pending_attachments = pending.attachments;   // survives the re-extract below
    } else {
      pending = { attachments: path ? [{ path, at: nowIso() }] : [], seed: true };
    }
  }
  if (!body) return false;

  // Confirmation or cancellation of a fully specified request.
  if (pending && pending.ready) {
    if (YES_RE.test(body)) {
      await saveSettingValue(db, key, null);
      return await executeRequest(db, wa, fromNum, pending);
    }
    if (NO_RE.test(body)) {
      await saveSettingValue(db, key, null);
      await sendText(wa, fromNum, 'Okay, cancelled. Nothing was changed.');
      return true;
    }
  }
  if ((!pending || pending.seed) && !GATE_RE.test(body)) return false;

  const cat = await catalogue(db);
  const out = await extract(apiKey, { text: body, cat, pending: pending && !pending.seed ? pending : null, fromName });
  if (!out || out.related !== true) return pending ? false : false;

  const group = cat.find(g => g.key === out.group_key) || null;
  const changes = (out.changes || []).filter(c => c && c.description).map(c => ({
    op: ['add', 'remove', 'change'].includes(c.op) ? c.op : 'add',
    kind: c.kind === 'adjustment' ? 'adjustment' : 'expense',
    description: String(c.description).slice(0, 200), amount: c.amount != null ? Number(c.amount) : null, date: c.date || null,
  }));
  const missing = new Set(out.missing || []);
  if (!group) missing.add('property');
  if (!out.period) missing.add('period');
  if (!changes.length) missing.add('description');
  if (changes.some(c => c.op !== 'remove' && !(c.amount > 0))) missing.add('amount');
  const st = group && out.period ? (group.statements.find(s => s.period === out.period) || null) : null;
  if (group && out.period && !st) {
    await saveSettingValue(db, key, null);
    await sendText(wa, fromNum, `I don't have a ${periodLabel(out.period)} statement for ${group.name} yet, so there is nothing to change. Once it is imported from your sheet, ask me again.`);
    return true;
  }
  const req = {
    group_key: group?.key || null, group_name: group?.name || null, period: out.period || null,
    statement_id: st?.id || null, status: st?.status || null, changes, missing: [...missing],
    attachments: [...(pending?.attachments || [])],
    ready: missing.size === 0, requested_by: fromNum, expires_at: new Date(Date.now() + PENDING_MS).toISOString(),
  };
  await saveSettingValue(db, key, req);
  const reply = String(out.reply || '').trim();
  await sendText(wa, fromNum, reply || (req.ready
    ? `Just to confirm: ${summary(req)}. Reply YES and I'll ${st.status === 'draft' ? 'change it' : 'send it to Ikiel to approve'}.`
    : `I need a bit more: ${[...missing].join(', ')}.`));
  return true;
}

// Invoices live beside the statement (settings.statement_attachments, keyed
// by statement id) — the Payouts page lists them with signed links.
async function recordAttachments(db, statementId, req, applied) {
  if (!(req.attachments || []).length) return;
  const all = (await getSettingValue(db, 'statement_attachments')) || {};
  const list = all[statementId] || [];
  for (const a of req.attachments) list.push({ path: a.path, at: a.at || nowIso(), by: req.requested_by, for: applied.map(x => x.label).join('; ').slice(0, 200) });
  all[statementId] = list.slice(-40);
  await saveSettingValue(db, 'statement_attachments', all);
}
async function telegramInvoice(db, req, caption) {
  for (const a of (req.attachments || []).slice(0, 3)) {
    try { const url = await signPhotoUrl(db, a.path, 7 * 86400); if (url) await postTelegramPhoto(url, caption); } catch { /* best-effort */ }
  }
}

async function executeRequest(db, wa, fromNum, req) {
  const st = (await sbGet(db, `statements?id=eq.${req.statement_id}&select=*&limit=1`))?.[0];
  if (!st) { await sendText(wa, fromNum, 'That statement is no longer there. Nothing changed.'); return true; }
  if (st.status === 'draft') {
    try {
      const applied = await applyChanges(db, st.id, req.changes, 'era_request');
      await sbPatch(db, `statements?id=eq.${st.id}`, { has_manual_edits: true, updated_at: nowIso() });
      const totals = await recomputeTotals(db, st.id);
      await recordAttachments(db, st.id, req, applied);
      await sendText(wa, fromNum, `Done. ${summary(req)}${(req.attachments || []).length ? ', invoice attached' : ''}. The ${periodLabel(req.period)} draft for ${req.group_name} now shows payout ${fmtIDR(totals.payout_total)}. Ikiel will see it when he publishes.`);
      await telegramInvoice(db, req, `Invoice from Era · ${req.group_name} · ${periodLabel(req.period)}`);
      await postToTelegram(`✏️ <b>Era changed a draft statement</b>\n${req.group_name} · ${periodLabel(req.period)}\n${applied.map(a => a.change === 'changed' ? `~ ${a.label} ${fmtIDR(a.from)} → ${fmtIDR(a.to)}` : `${a.change === 'added' ? '+' : '−'} ${a.label} ${fmtIDR(a.amount)}`).join('\n')}\nDraft payout now ${fmtIDR(totals.payout_total)}.`).catch(() => {});
    } catch (e) {
      await sendText(wa, fromNum, `I couldn't apply that: ${e.message}. Nothing was changed.`);
    }
    return true;
  }
  // Published: Ikiel approves with a tap.
  const token = Math.random().toString(36).slice(2, 10);
  const approvals = (await getSettingValue(db, 'stmt_change_approvals')) || {};
  approvals[token] = { ...req, created_at: nowIso(), expires_at: new Date(Date.now() + APPROVAL_MS).toISOString() };
  await saveSettingValue(db, 'stmt_change_approvals', approvals);
  await postToTelegram(
    `📝 <b>Era asks to amend a published statement</b>\n${req.group_name} · ${periodLabel(req.period)} (${st.status}, owner saw ${fmtIDR(st.payout_total)})\n${req.changes.map(c => '• ' + describe(c)).join('\n')}\nApprove to run the amendment (history kept, "Revised" note; the owner is not messaged unless you choose to on the Payouts page).`,
    { reply_markup: { inline_keyboard: [[{ text: '✓ Approve', callback_data: `stmtok:${token}` }, { text: '✗ Reject', callback_data: `stmtno:${token}` }]] } },
  ).catch(() => {});
  await telegramInvoice(db, req, `Invoice for the request above · ${req.group_name} · ${periodLabel(req.period)}`);
  await sendText(wa, fromNum, `Got it: ${summary(req)}${(req.attachments || []).length ? ', invoice attached' : ''}. That statement is already published, so I've sent it to Ikiel to approve. I'll tell you when it's done.`);
  return true;
}

// Telegram tap → amendment (or a polite no). Returns a line for the toast.
export async function resolveApproval(db, wa, token, approve) {
  const approvals = (await getSettingValue(db, 'stmt_change_approvals')) || {};
  const req = approvals[token];
  if (!req) return 'That request is no longer pending';
  delete approvals[token];
  await saveSettingValue(db, 'stmt_change_approvals', approvals);
  const who = req.requested_by;
  if (!approve) {
    await sendText(wa, who, `Ikiel didn't approve the change to ${req.group_name} · ${periodLabel(req.period)} (${req.changes.map(describe).join('; ')}). The statement stays as published.`);
    return `Rejected · Era told`;
  }
  try {
    await amendStart(db, req.statement_id, 'era-request');
    const applied = await applyChanges(db, req.statement_id, req.changes, 'era_request');
    const out = await amendFinalize(db, req.statement_id, { note: `Requested by Era: ${req.changes.map(describe).join('; ')}`.slice(0, 300), notifyOwner: false, actor: 'era-request', changes: applied });
    await recordAttachments(db, req.statement_id, req, applied);
    await sendText(wa, who, `Done, Ikiel approved it. ${summary(req)}. The ${periodLabel(req.period)} statement for ${req.group_name} now shows payout ${fmtIDR(out.payout_total)} (was ${fmtIDR(out.prev_payout)}).`);
    await postToTelegram(`✓ <b>Amended</b> ${req.group_name} · ${periodLabel(req.period)}: payout ${fmtIDR(out.prev_payout)} → ${fmtIDR(out.payout_total)}. Era has been told. Tell the owner from the Payouts page if you want them notified.`).catch(() => {});
    return `Amended · payout ${fmtIDR(out.payout_total)}`;
  } catch (e) {
    await postToTelegram(`❌ Amendment failed for ${req.group_name} · ${periodLabel(req.period)}: ${e.message}`).catch(() => {});
    return `Failed: ${e.message}`;
  }
}

// Signed links to the invoices kept beside a statement.
export async function statementAttachments(db, statementId) {
  const all = (await getSettingValue(db, 'statement_attachments')) || {};
  const list = all[statementId] || [];
  const out = [];
  for (const a of list) out.push({ ...a, url: await signPhotoUrl(db, a.path, 3600).catch(() => null) });
  return out;
}
