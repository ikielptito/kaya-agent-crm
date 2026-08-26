// ── VIEWINGS ────────────────────────────────────────────────────────────
// Structured viewing appointments — the conversion step that used to live
// only as free text in chat. A viewing rides the relay transport (the ask to
// the villa contact IS a relay, so window re-openers, nudges and answer
// delivery come free) plus its own state machine:
//
//   requested → confirmed → completed | no_show
//            ↘ declined | expired | cancelled
//
// Maya never confirms a slot herself: 'confirmed' is set only from the villa
// contact's own reply (captureRelayAnswer's viewing classification), from an
// update_viewing action grounded in the conversation, or manually from the
// console. No client PII is ever stored — the agent's client stays theirs.
//
// The table is created by a manual Supabase migration (SCHEMA.sql). Every
// helper here degrades to a no-op when the table doesn't exist yet, so the
// code can deploy ahead of the migration.

import crypto from 'node:crypto';
import { ownerIdByWa } from './relay.js';

const iso = () => new Date().toISOString();

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  if (!r.ok) return null;                       // table missing → null, callers skip
  return r.json().catch(() => null);
}
async function sbPost(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) ? rows[0] : rows;
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
  });
  return r.ok;
}

// Open a viewing: one row, tied to the relay that carries the ask.
export async function createViewing(db, { agent, slug, propertyName, contactWa, contactName, requestedWindow, relayId }) {
  return sbPost(db, 'viewings', {
    agent_id: agent?.id ?? null,
    agent_wa: String(agent?.wa_num || '').replace(/\D/g, '') || null,
    agent_name: agent?.name || agent?.agency || null,
    rental_slug: slug || null,
    property_name: propertyName || slug || null,
    contact_wa: String(contactWa || '').replace(/\D/g, '') || null,
    contact_name: contactName || null,
    requested_window: String(requestedWindow || '').slice(0, 200) || null,
    status: 'requested',
    relay_id: relayId ?? null,
    created_at: iso(), updated_at: iso(),
  });
}

export async function updateViewing(db, id, patch) {
  return sbPatch(db, `viewings?id=eq.${id}`, { ...patch, updated_at: iso() });
}

export async function viewingByRelay(db, relayId) {
  if (relayId == null) return null;
  const rows = await sbGet(db, `viewings?relay_id=eq.${relayId}&select=*&limit=1`);
  return rows?.[0] || null;
}

// Live viewings for one agent — fed into Maya's context so she knows what's
// pending/confirmed and can record outcomes from the conversation.
export async function viewingsForAgent(db, agentId) {
  if (agentId == null) return [];
  const rows = await sbGet(db,
    `viewings?agent_id=eq.${agentId}&status=in.(requested,confirmed)&select=id,rental_slug,property_name,requested_window,scheduled_at,status,contact_name&order=created_at.desc&limit=5`);
  return rows || [];
}

// Same, plus recently-passed confirmed viewings awaiting an outcome.
export async function viewingsAwaitingOutcome(db, agentId) {
  if (agentId == null) return [];
  const rows = await sbGet(db,
    `viewings?agent_id=eq.${agentId}&status=eq.confirmed&scheduled_at=lt.${iso()}&select=id,property_name,scheduled_at&limit=3`);
  return rows || [];
}

// One compact prompt block, or '' when there is nothing to know.
export function viewingsPromptBlock(active, past) {
  if (!active?.length && !past?.length) return '';
  const line = (v) => `- viewing #${v.id}: ${v.property_name || v.rental_slug} — ${v.status}${v.scheduled_at ? ` for ${v.scheduled_at.slice(0, 16).replace('T', ' ')}` : v.requested_window ? ` (asked: ${v.requested_window})` : ''}${v.contact_name ? ` · contact ${v.contact_name}` : ''}`;
  const parts = [];
  if (active?.length) parts.push(`THIS AGENT'S VIEWINGS (live state — never contradict it):\n${active.map(line).join('\n')}`);
  if (past?.length) parts.push(`PAST CONFIRMED VIEWINGS AWAITING AN OUTCOME — if the moment is natural, ask how it went, then record it via crm_actions update_viewing (completed / no_show / cancelled + a short note):\n${past.map(v => `- viewing #${v.id}: ${v.property_name} on ${String(v.scheduled_at).slice(0, 10)}`).join('\n')}`);
  return parts.join('\n') + '\n';
}

// ── "Samba Visits" calendar ─────────────────────────────────────────────
// The viewings table is the single source of truth; the calendar is a VIEW of
// it, never a second system (no dual-write drift). Two shapes, same data:
//   · a subscribable feed (?ics=<token>) Ikiel/Era add to Google Calendar once
//   · a per-event file (?event=<id>&sig=<hmac>) linked in WhatsApp invites
// Auth: the feed needs the full token; per-event links carry an HMAC of the id
// so a shared link exposes exactly one event, nothing else. All times go out
// as UTC instants — every phone renders them in its own timezone correctly.

const ICS_DUR_MIN = 45;                      // assumed viewing length
const icsToken = () => process.env.VIEWINGS_ICS_TOKEN || '';

export function eventSig(id) {
  return crypto.createHmac('sha256', icsToken()).update(String(id)).digest('hex').slice(0, 16);
}
const sigOk = (id, sig) => {
  const want = eventSig(id);
  return typeof sig === 'string' && sig.length === want.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
};

const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
const icsDt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function vevent(v, nowMs) {
  const start = Date.parse(v.scheduled_at);
  if (!Number.isFinite(start)) return '';
  const dead = ['cancelled', 'declined', 'expired'].includes(v.status);
  // SEQUENCE grows with every update so a re-sent file replaces the old event.
  const seq = v.updated_at ? Math.floor(Date.parse(v.updated_at) / 60000) % 99999999 : 0;
  const desc = [
    `Agent: ${v.agent_name || 'TBC'}`,
    `Villa contact: ${v.contact_name || 'TBC'}`,
    `Status: ${v.status}`,
    v.outcome_note ? `Note: ${v.outcome_note}` : '',
    'Coordinated by Maya (Samba Rentals) — reply to her on WhatsApp to reschedule.',
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:samba-viewing-${v.id}@sambarentals.com`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${icsDt(nowMs)}`,
    `DTSTART:${icsDt(start)}`,
    `DTEND:${icsDt(start + ICS_DUR_MIN * 60e3)}`,
    `SUMMARY:${icsEsc(`Viewing — ${v.property_name || v.rental_slug || 'villa'}${v.status === 'no_show' ? ' (no-show)' : dead ? ' (cancelled)' : ''}`)}`,
    `STATUS:${dead ? 'CANCELLED' : 'CONFIRMED'}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    'END:VEVENT',
  ].join('\r\n');
}

function icsWrap(body, { method } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Samba Rentals//Visits//EN',
    ...(method ? [`METHOD:${method}`] : []),
    'X-WR-CALNAME:Samba Visits',
    'X-WR-TIMEZONE:Asia/Makassar',
    'X-PUBLISHED-TTL:PT1H',
    body,
    'END:VCALENDAR',
  ].join('\r\n');
}

// GET handler folded into api/supabase.js (Hobby 12-function cap).
export async function handleIcsGet(req, res, db) {
  const q = req.query || {};
  const nowMs = Date.now();
  if (q.event != null) {
    const id = parseInt(q.event, 10);
    if (!Number.isFinite(id) || !sigOk(id, q.sig)) return res.status(401).send('Unauthorized');
    const rows = await sbGet(db, `viewings?id=eq.${id}&select=*&limit=1`);
    const v = rows?.[0];
    if (!v || !v.scheduled_at) return res.status(404).send('Not found');
    const dead = ['cancelled', 'declined', 'expired'].includes(v.status);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="samba-viewing-${id}.ics"`);
    return res.status(200).send(icsWrap(vevent(v, nowMs), { method: dead ? 'CANCEL' : 'REQUEST' }));
  }
  const tok = icsToken();
  if (!tok || q.ics !== tok) return res.status(401).send('Unauthorized');
  const since = new Date(nowMs - 90 * 86400e3).toISOString();
  const rows = await sbGet(db,
    `viewings?scheduled_at=gte.${since}&status=in.(confirmed,completed,no_show)&select=*&order=scheduled_at.asc&limit=500`) || [];
  const body = rows.map(v => vevent(v, nowMs)).filter(Boolean).join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  return res.status(200).send(icsWrap(body));
}

// One-tap "add to calendar" links. Google's template link is the primary
// (opens the Calendar app directly on most phones here — no download); the
// .ics link covers Apple/other calendars. WhatsApp's Cloud API doesn't
// support text/calendar documents, so links beat a document send.
function inviteLinks(v) {
  const start = Date.parse(v.scheduled_at);
  const dates = `${icsDt(start)}/${icsDt(start + ICS_DUR_MIN * 60e3)}`;
  const title = `Viewing — ${v.property_name || v.rental_slug || 'villa'}`;
  const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(title)}&dates=${dates}`
    + `&details=${encodeURIComponent('Coordinated by Maya (Samba Rentals) — reply to her on WhatsApp to reschedule.')}`
    + '&ctz=Asia/Makassar';
  const ics = `https://kaya-agent-crm.vercel.app/api/supabase?event=${v.id}&sig=${eventSig(v.id)}`;
  return { gcal, ics, title };
}

async function waSend(wa, to, text) {
  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    const d = await r.json().catch(() => ({}));
    return d?.messages?.[0]?.id || null;
  } catch { return null; }
}

// Send calendar invites (or a cancellation) to both parties, mirrored into
// their console threads. Free text — meant for the moment of confirmation,
// when both windows are open by definition (they both just replied).
export async function sendViewingInvites(db, wa, v, { cancelled = false } = {}) {
  if (!v?.scheduled_at || !wa?.phoneId || !wa?.token) return { sent: 0 };
  const { gcal, ics, title } = inviteLinks(v);
  const when = new Date(Date.parse(v.scheduled_at) + 8 * 3600e3);
  const label = `${when.toISOString().slice(0, 10)} at ${when.toISOString().slice(11, 16)} WITA`;
  const body = cancelled
    ? `This viewing was cancelled — ${title}, was ${label}. If you added it to your calendar, tap to update: ${ics}`
    : `📅 ${title} — ${label}\nAdd it to your calendar: ${gcal}\n(Apple/other calendars: ${ics})`;
  let sent = 0;
  for (const [to, side] of [[v.agent_wa, 'agent'], [v.contact_wa, 'contact']]) {
    const num = String(to || '').replace(/\D/g, '');
    if (!num) continue;
    const mid = await waSend(wa, num, body);
    if (!mid) continue;
    sent++;
    const link = side === 'agent'
      ? { agent_id: v.agent_id ?? null }
      : { owner_id: await ownerIdByWa(db, num).catch(() => null) };
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: db.sbHeaders,
      body: JSON.stringify({
        ...link, wa_num: num, direction: 'outbound', wa_message_id: mid,
        content: `[Calendar ${cancelled ? 'cancellation' : 'invite'} — ${title}, ${label}]`,
        timestamp: iso(), source: 'viewing',
      }),
    }).catch(() => {});
  }
  return { sent };
}

// Resolve an agent's free-text window ("Wednesday 27 Aug, 2pm") to a concrete
// UTC instant, for when the contact taps Confirm — a button tap carries no
// prose for the answer-matcher, so the slot comes from the original request.
// Null when the window names no single concrete time ("sometime this week").
export async function resolveWindowToIso(apiKey, windowText) {
  const w = String(windowText || '').trim();
  if (!apiKey || !w) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100,
        system: `Convert a viewing time request (Bali, UTC+08:00) into one ISO 8601 datetime with the +08:00 offset. Today is ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)} (Bali). Resolve relative days forward. If a RANGE is given, use its start. If no single concrete day+time can be named, reply null. Reply with ONLY the ISO string or null.`,
        messages: [{ role: 'user', content: w.slice(0, 200) }],
      }),
    });
    const d = await r.json();
    const t = (d.content?.[0]?.text || '').trim().replace(/^"|"$/g, '');
    return (t && t !== 'null' && !Number.isNaN(Date.parse(t))) ? new Date(t).toISOString() : null;
  } catch { return null; }
}

// ── Daily cron pass ─────────────────────────────────────────────────────
// 1. requested viewings whose relay expired → expired (the relay machinery
//    already told the agent honestly).
// 2. confirmed viewings happening today (WITA) → one reminder to agent AND
//    contact (free text; a shut window just skips — the reminder is a nicety).
// 3. confirmed viewings >12h past with no outcome ask → one gentle ask to the
//    agent; the answer flows through Maya, who records it via update_viewing.
export async function runViewingsCron(db, wa, { now = new Date(), sendText } = {}) {
  const summary = { expired: 0, reminded: 0, outcome_asks: 0 };
  const rows = await sbGet(db, `viewings?status=in.(requested,confirmed)&select=*`);
  if (!rows) { summary.skipped = 'viewings table not migrated yet'; return summary; }

  const witaNow = new Date(now.getTime() + 8 * 3600e3);
  const witaDay = witaNow.toISOString().slice(0, 10);

  for (const v of rows) {
    try {
      if (v.status === 'requested' && v.relay_id != null) {
        const rel = await sbGet(db, `relays?id=eq.${v.relay_id}&select=status&limit=1`);
        const rs = rel?.[0]?.status;
        if (rs === 'expired' || rs === 'failed') {
          await updateViewing(db, v.id, { status: 'expired' });
          summary.expired++;
        }
        continue;
      }
      if (v.status !== 'confirmed' || !v.scheduled_at) continue;
      const schedWita = new Date(Date.parse(v.scheduled_at) + 8 * 3600e3);
      const schedDay = schedWita.toISOString().slice(0, 10);
      const timeLabel = `${schedWita.toISOString().slice(11, 16)} WITA`;

      if (!v.reminded_at && schedDay === witaDay && Date.parse(v.scheduled_at) > now.getTime()) {
        if (v.agent_wa) await sendText(v.agent_wa, `Reminder — your viewing at ${v.property_name} is today at ${timeLabel}. ${v.contact_name ? `${v.contact_name} is expecting you.` : ''}`.trim()).catch(() => {});
        if (v.contact_wa) await sendText(v.contact_wa, `Reminder — ${v.agent_name || 'the agent'} is viewing ${v.property_name} today at ${timeLabel}.`).catch(() => {});
        await updateViewing(db, v.id, { reminded_at: iso() });
        summary.reminded++;
        continue;
      }
      if (!v.outcome_asked_at && Date.parse(v.scheduled_at) < now.getTime() - 12 * 3600e3) {
        // One ask only; a shut agent window means the send silently fails and
        // Maya's prompt block picks it up in their next conversation instead.
        if (v.agent_wa) await sendText(v.agent_wa, `Quick one — how did the viewing at ${v.property_name} go? Even a one-liner helps me help you follow up.`).catch(() => {});
        await updateViewing(db, v.id, { outcome_asked_at: iso() });
        summary.outcome_asks++;
      }
    } catch { /* per-row best effort */ }
  }
  return summary;
}
