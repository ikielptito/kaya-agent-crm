// Era's reply to the backlog nudge, read as status updates on tickets that
// already exist — never as new reports.
//
// On 5 Sep 2026 Maya asked Era about nine waiting tickets and Era answered
// exactly as asked: "#4 patio chairs is done. Bought a new one / #7 shower
// head been replaced…". The staff report parser then turned that reply into
// four NEW tickets, filed them under Villa Saturno because no villa was
// named, and Ikiel approved two before anyone noticed. This module claims
// such replies first: if the message references ticket numbers, or arrives
// within a day of a backlog nudge and reads as a progress report, each line
// is mapped to an open ticket and applied — done, estimate, waiting, note —
// and Maya reads back what she did so a mistake is visible immediately.

import { completeItem, patchItem, snoozeItem, appendThread, publishItem } from './maintenance.js';
import { getSettingValue } from './campaigns.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const MODEL = process.env.MAINTENANCE_LLM_MODEL_STRONG || 'claude-sonnet-4-6';
const nowIso = () => new Date().toISOString();

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    return r.ok ? ((await r.json().catch(() => ({}))).messages?.[0]?.id || true) : null;
  } catch { return null; }
}

const placeOf = (i) => i.unit_label ? `${i.statement_groups?.name || i.group_key} (${i.unit_label})` : (i.statement_groups?.name || i.slug || i.group_key);

// ── Does this read as a status reply? ───────────────────────────────
// Ticket numbers are the strong signal. Without them, only a message that
// lands within a day of a nudge and carries progress words is taken.
const HAS_IDS = /(^|\s)#\s?\d{1,5}\b/;
const PROGRESS = /\b(done|finished|selesai|sudah|replaced|fixed|bought|installed|waiting|menunggu|estimate|estimasi|price|harga|pending|in progress|scheduled|tomorrow|besok|next week|not yet|belum)\b/i;

export function looksLikeStatusReply(text, { nudgedRecently = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length < 4) return false;
  if (HAS_IDS.test(t)) return true;
  return nudgedRecently && PROGRESS.test(t) && t.length > 15;
}

async function nudgedWithin(db, waNum, hours) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const rows = await sbGet(db, `wa_messages?wa_num=eq.${encodeURIComponent(waNum)}&direction=eq.outbound&timestamp=gte.${encodeURIComponent(since)}&content=like.*Maintenance%20backlog*&select=id&limit=1`);
  return !!rows?.length;
}

// ── Parse: one call, the open tickets as the vocabulary ─────────────
export async function parseStatusReply(text, openItems, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey || !openItems.length) return null;
  const list = openItems.map(i => `#${i.id} | ${placeOf(i)} | ${i.status}${i.estimated_cost ? ` | est ${i.estimated_cost}` : ''} | ${i.title}`).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 900,
      system: `You read a villa manager's WhatsApp reply about maintenance tickets and map each line to an existing ticket. You never invent tickets. Reply with ONLY JSON.`,
      messages: [{ role: 'user', content:
`Open tickets:
${list}

Her reply:
"""${String(text).slice(0, 2000)}"""

For each line of her reply, find the ticket it is about. Match by the "#number" when given; otherwise by villa and subject (e.g. "A5 glass" → the A5 glassware ticket). Lines that mention a ticket number that is not in the list, or that match nothing, go to "unmatched".

Actions:
- "done": the work is finished (done, replaced, fixed, bought and installed, selesai, sudah).
- "estimate": she gives a price. Compute the total in IDR (e.g. "15,000/pcs x 4 and bowl 25,000" → 85000). Keep the ticket open.
- "waiting": blocked on something (villa occupied, owner, part, design). Include what on, and a date if she gives one (YYYY-MM-DD) else null.
- "note": any other progress remark, e.g. "needs inspection", "partly done: wardrobe finished, table pending".

{"actions":[{"id":<ticket id>,"action":"done|estimate|waiting|note","note":"<her words, short, English or Indonesian as written>","estimated_cost":<number or null>,"until":"<YYYY-MM-DD or null>"}],
 "unmatched":["<line>"]}` }],
    }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const out = JSON.parse(m[0]);
    const ids = new Set(openItems.map(i => i.id));
    return {
      actions: (out.actions || []).filter(a => ids.has(Number(a.id)) && ['done', 'estimate', 'waiting', 'note'].includes(a.action))
        .map(a => ({ id: Number(a.id), action: a.action, note: String(a.note || '').slice(0, 300), estimated_cost: a.estimated_cost != null ? Number(a.estimated_cost) || null : null, until: /^\d{4}-\d{2}-\d{2}$/.test(String(a.until || '')) ? a.until : null })),
      unmatched: (out.unmatched || []).map(String).slice(0, 10),
    };
  } catch { return null; }
}

// ── Apply, then read back ───────────────────────────────────────────
export async function applyStatusActions(db, actions, openItems, { who = 'Era' } = {}) {
  const by = Object.fromEntries(openItems.map(i => [i.id, i]));
  const lines = [];
  for (const a of actions) {
    const it = by[a.id]; if (!it) continue;
    const label = `#${it.id} ${it.title.slice(0, 40)}`;
    try {
      if (a.action === 'done') {
        // A ticket she never published cannot be closed as it stands; it
        // was routine work she has already done, so publish it as such and
        // close it. The owner is told it is finished, not asked to approve.
        if (it.status === 'new') await publishItem(db, it.id, { requires_approval: false, actor: who });
        await completeItem(db, it.id, { note: `${who}: ${a.note}`, by: who });
        lines.push(`✅ ${label} → done`);
      } else if (a.action === 'estimate' && a.estimated_cost) {
        await patchItem(db, it.id, { estimated_cost: a.estimated_cost });
        await appendThread(db, it.id, { who, text: a.note });
        lines.push(`💰 ${label} → estimate IDR ${a.estimated_cost.toLocaleString('en-US')}${it.status === 'new' ? ' (still needs Publish on the page)' : ''}`);
      } else if (a.action === 'waiting') {
        if (['approved', 'scheduled'].includes(it.status)) await snoozeItem(db, it.id, { untilDate: a.until || undefined, note: a.note, who: who.toLowerCase() });
        else await appendThread(db, it.id, { who, text: `Waiting: ${a.note}` });
        lines.push(`⏸ ${label} → waiting${a.until ? ` until ${a.until}` : ''}: ${a.note}`);
      } else {
        await appendThread(db, it.id, { who, text: a.note });
        lines.push(`📝 ${label} → noted: ${a.note}`);
      }
      await fetch(`${db.SUPABASE_URL}/rest/v1/maintenance_items?id=eq.${it.id}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify({ updated_at: nowIso() }) }).catch(() => {});
    } catch (e) { lines.push(`⚠️ ${label} → could not apply (${e.message})`); }
  }
  return lines;
}

// ── The handler, for the team branch of the webhook ─────────────────
export async function handleBacklogReply({ db, wa, fromNum, text, who = 'Era', apiKey }) {
  const body = String(text || '').trim();
  const nudged = await nudgedWithin(db, fromNum, 24).catch(() => false);
  if (!looksLikeStatusReply(body, { nudgedRecently: nudged })) return false;
  const open = (await sbGet(db, `maintenance_items?status=in.(new,pending_approval,approved,scheduled)&select=*,statement_groups(key,name)&order=created_at.asc&limit=100`)) || [];
  if (!open.length) return false;
  const parsed = await parseStatusReply(body, open, { apiKey }).catch(() => null);
  if (!parsed || (!parsed.actions.length && !parsed.unmatched.length)) return false;
  const lines = await applyStatusActions(db, parsed.actions, open, { who });
  const unmatched = parsed.unmatched.length ? `\n\nI could not match: ${parsed.unmatched.map(u => `"${u.slice(0, 60)}"`).join(', ')}. If one of those is a new problem, send it with the villa name and a photo and I will file it.` : '';
  const reply = lines.length
    ? `Got it, ${who}. Applied:\n${lines.join('\n')}${unmatched}\n\nIf I read any of that wrong, reply "undo #<number>".`
    : `Thanks ${who}, I could not match that to an open ticket.${unmatched}`;
  await sendText(wa, fromNum, reply);
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: fromNum, direction: 'outbound', content: reply, timestamp: nowIso(), source: 'webhook', category: 'maintenance_staff' }),
  }).catch(() => {});
  return true;
}

// "undo #4": reopen a ticket closed by mistake.
export async function handleBacklogUndo({ db, wa, fromNum, text }) {
  const m = String(text || '').trim().match(/^undo\s*#?\s?(\d{1,5})\b/i);
  if (!m) return false;
  const { reopenItem } = await import('./maintenance.js');
  try { await reopenItem(db, Number(m[1])); await sendText(wa, fromNum, `Reopened #${m[1]}.`); }
  catch (e) { await sendText(wa, fromNum, `Could not reopen #${m[1]}: ${e.message}`); }
  return true;
}
