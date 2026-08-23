// Unanswered-inbound SLA. The audit (22 Aug 2026) found 73 agent messages
// that were never answered and 10% that waited more than a day — almost all
// of them escalated drafts nobody got to. Nothing in the system told the
// agent they'd been heard, and nothing told Ikiel with any urgency.
//
// Hourly (from the relay sweep cron): for every agent whose latest message
// is a substantive inbound with no reply for HOLD_AFTER_MIN minutes and whose
// 24h window is still open, send ONE holding line in their language, and
// page Ikiel (push + Telegram) with the message. Once per inbound — recorded
// in settings.sla_holds. Drafts older than 24h are counted into the same
// page so they stop rotting unseen.

import { sendOwnerPush } from './push.js';
import { postToTelegram } from './telegram.js';

export const HOLD_AFTER_MIN = 30;
const GRAPH = 'https://graph.facebook.com/v24.0';

const ACK_RE = /^(ok(ay|e)?|oke|thanks?( you)?|thank you|noted|siap|sip|baik|great|perfect|nice|👍|🙏|👌|✅|sure|yes|ya|yep|no|nope|good|cool|alright|will do|hi|hello|halo|hai|pagi|siang|sore|malam|selamat .*)[\s!.🙏👍😊🙌]*$/i;
const AUTO_REPLY_RE = /thank you for (contacting|reaching out|your message)|terima kasih (telah|sudah) menghubungi|we will (get back|respond)|out of (the )?office|auto-?reply|currently unavailable|be with you in a minute|leave (us )?a message/i;
const MARKER_RE = /^\[(Sticker|Unknown|Tapped|Image|Voice|Audio|Document|Video|Contact card|Location)/i;

// Closers: short, no question, and a thank-you / sign-off / "I'll get back
// to you" — the agent is ending the exchange, not waiting on us.
const CLOSER_RE = /\b(all good|got it|sounds good|talk soon|have a (good|great|nice)|happy (weekend|holiday|sunday|monday)|let me (update|check|inform|get back|talk to|ask)|i('ll| will) (update|inform|get back|let you know|check|share|forward|pass)|will (update|inform|share|forward|pass|let you know)|thanks?|thank you|terima kasih|makasih|noted|siap|sip|mantap|oke?|sukses|semangat)\b/i;
function substantive(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 2) return false;
  if (MARKER_RE.test(t)) return false;
  if (ACK_RE.test(t)) return false;
  if (AUTO_REPLY_RE.test(t)) return false;
  if (!/\?/.test(t) && t.length <= 140 && CLOSER_RE.test(t)) return false;
  return true;
}
function isBahasa(text) {
  return /\b(yang|dan|untuk|dengan|bisa|ada|tidak|saya|kami|mau|sudah|belum|kak|pak|bu|harga|berapa|apakah|boleh|villa nya|nya)\b/i.test(String(text || ''));
}

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}
async function getSetting(db, key) {
  return (await sbGet(db, `settings?key=eq.${key}&select=value`))?.[0]?.value || {};
}
async function setSetting(db, key, value) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}
async function waText(wa, to, body) {
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? (j.messages?.[0]?.id || null) : null;
  } catch { return null; }
}

export async function sweepUnanswered(db, wa, { now = new Date() } = {}) {
  const out = { checked: 0, held: 0, paged: 0, stale_drafts: 0, skipped: [] };
  const windowOpenSince = new Date(now.getTime() - 24 * 3600e3).toISOString();
  const holdCut = new Date(now.getTime() - HOLD_AFTER_MIN * 60e3).toISOString();
  // Candidates: a real agent, window still open, last inbound older than the hold threshold.
  const agents = await sbGet(db,
    `agents?is_test=eq.false&wa_num=not.is.null&dead_number=not.is.true&last_inbound_at=gte.${windowOpenSince}&last_inbound_at=lte.${holdCut}&select=id,name,agency,wa_num,last_inbound_at,automation_override,suggested_reply&limit=200`);
  const holds = await getSetting(db, 'sla_holds');
  const pageLines = [];

  for (const a of Array.isArray(agents) ? agents : []) {
    out.checked++;
    if (a.automation_override === 'off') continue;
    // Latest non-broadcast message: if it's outbound, they've been answered.
    const last = (await sbGet(db,
      `wa_messages?agent_id=eq.${a.id}&or=(source.not.in.(cron,sla),source.is.null)&order=timestamp.desc&limit=1&select=direction,content,timestamp`))?.[0];
    if (!last || last.direction !== 'inbound') continue;
    if (Date.parse(last.timestamp) > Date.parse(holdCut)) continue;
    if (!substantive(last.content)) continue;
    const prev = holds[a.id];
    if (prev && Date.parse(prev) >= Date.parse(last.timestamp)) continue;   // already held for this message

    const body = isBahasa(last.content)
      ? `Maaf menunggu ya — pesan kakak sudah saya teruskan ke Ikiel dan akan segera dibalas 🙏`
      : `Sorry for the wait — I've passed your message to Ikiel and you'll hear back shortly.`;
    const mid = await waText(wa, a.wa_num, body);
    if (mid) {
      await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: db.sbHeaders,
        body: JSON.stringify({ agent_id: a.id, wa_num: a.wa_num, direction: 'outbound', content: body, wa_message_id: mid, timestamp: new Date().toISOString(), source: 'sla', category: 'holding_line', status: 'sent' }),
      }).catch(() => {});
      out.held++;
    }
    holds[a.id] = last.timestamp;
    const ageMin = Math.round((now.getTime() - Date.parse(last.timestamp)) / 60e3);
    pageLines.push(`• ${a.name || a.agency || '+' + a.wa_num} (${ageMin} min): "${String(last.content).replace(/\s+/g, ' ').slice(0, 90)}"`);
  }

  // Drafts older than 24h — the slow-rot problem. Counted into the page.
  const stale = await sbGet(db, `agents?is_test=eq.false&suggested_reply=not.is.null&suggested_reply=neq.&last_inbound_at=lte.${windowOpenSince}&select=id,name,agency,last_inbound_at,suggested_reply&limit=100`);
  const staleReal = (Array.isArray(stale) ? stale : []).filter(a => a.suggested_reply && !/^\[Maya/.test(a.suggested_reply));
  out.stale_drafts = staleReal.length;

  // Prune hold records older than 7 days.
  for (const k of Object.keys(holds)) if (Date.parse(holds[k]) < now.getTime() - 7 * 86400e3) delete holds[k];
  await setSetting(db, 'sla_holds', holds);

  if (pageLines.length) {
    const title = `${pageLines.length} agent${pageLines.length > 1 ? 's' : ''} waiting >${HOLD_AFTER_MIN} min`;
    const body = pageLines.join('\n') + (staleReal.length ? `\n\n${staleReal.length} draft${staleReal.length > 1 ? 's' : ''} older than 24h still pending.` : '');
    await sendOwnerPush({ SUPABASE_URL: db.SUPABASE_URL, headers: db.sbHeaders }, { title, body: pageLines[0].slice(0, 160), url: '/chat.html', tag: 'sla' }).catch(() => {});
    await postToTelegram(`⏱ ${title}\n${body}`).catch(() => {});
    out.paged = pageLines.length;
  }
  return out;
}
