// ── QUESTION RELAY ──────────────────────────────────────────────────────
// An agent asks something Maya can't answer from the KB ("does Unit 1 have a
// bathtub?"). Instead of dead-ending on a contact card, Maya asks the person
// who actually knows — the listing's "enquire with" contact — and carries the
// answer back to the agent herself.
//
// The hard part is WhatsApp's 24h session window, which can be shut on either
// leg. The pattern is the one notifyTeam already proved for team alerts: try
// free text first; if the window is shut the send fails, so fire an approved
// UTILITY template to re-open it and deliver the real content the moment they
// reply. Here that happens in BOTH directions, so a relay is a small state
// machine (see the status column in SCHEMA.sql) rather than a single send.
//
// Two rules this module enforces structurally, not by prompting:
//   1. The agent's client is never mentioned. Relays carry a question about a
//      PROPERTY. The contact is told "an agent asked" — never which agent,
//      never their client. Maya brokering it is the whole point.
//   2. Answers to durable questions are STAGED (kb_status='pending'), never
//      written live into the listing. One offhand owner reply should not
//      become a fact Maya quotes to the whole agent network.

const GRAPH = 'https://graph.facebook.com/v24.0';

export const OWNER_QUESTION_TEMPLATE = 'maya_owner_question';
export const ANSWER_READY_TEMPLATE = 'maya_answer_ready';
// Relays that Maya opens on her own to complete a listing (no agent waiting)
// carry this prefix in `question`; the wording to the contact changes and the
// "deliver to agent" leg is skipped. See lib/listing-info.js.
export const LISTING_INFO_PREFIX = '[Listing info] ';
export function isListingInfo(q) { return String(q || '').startsWith(LISTING_INFO_PREFIX); }
// One-way notices to an owner (e.g. "your listing is live") ride the same
// transport — template re-opener when the window is shut — but expect no
// answer: they are marked delivered as soon as the text goes out.
export const LISTING_LIVE_PREFIX = '[Listing live] ';
export function isListingLive(q) { return String(q || '').startsWith(LISTING_LIVE_PREFIX); }
// Viewing requests (lib/viewings.js) — same transport, their own framing: the
// contact is asked to confirm a slot, and the reply drives the viewings row.
export const VIEWING_PREFIX = '[Viewing] ';
export function isViewing(q) { return String(q || '').startsWith(VIEWING_PREFIX); }
function relayBody(contactName, prop, q, { followUp = false } = {}) {
  if (isListingLive(q)) {
    return `Hi ${greetName(contactName)}, ${q.slice(LISTING_LIVE_PREFIX.length)}`;
  }
  if (isListingInfo(q)) {
    // The question carries its own intro + bullet list (lib/listing-info.js).
    return `Hi ${greetName(contactName)}, ${q.slice(LISTING_INFO_PREFIX.length)}\n\n`
      + `Reply here in any format and I'll update the listings.`;
  }
  if (isViewing(q)) {
    return (followUp ? `Thanks ${greetName(contactName)} — here's the request.\n\n` : `Hi ${greetName(contactName)}, Maya here from Samba Realty.\n\n`)
      + `${q.slice(VIEWING_PREFIX.length)}\n\n`
      + `Reply here and I'll coordinate with the agent.`;
  }
  return (followUp ? `Thanks ${greetName(contactName)} — here's the question.\n\n` : `Hi ${greetName(contactName)}, Maya here from Samba Realty.\n\n`)
    + `An agent asked about ${prop}:\n"${q}"\n\n`
    + `Reply ${followUp ? 'with' : 'to this message with'} the answer and I'll pass it straight back to them.`;
}

// How long a question stays live before Maya gives up and tells the agent
// honestly, and how long she waits before one (and only one) nudge.
const RELAY_TTL_HOURS = 48;
const NUDGE_AFTER_HOURS = 8;
const MAX_NUDGES = 1;
// Don't re-ask the same contact the same thing twice in a day.
const DEDUPE_WINDOW_HOURS = 24;

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
// Placeholder "names" that must never be greeted or quoted as a person —
// "Hi the," and "— the confirmed:" both shipped before this guard
// (Casa Suhana's contact was literally named "the villa contact", 27 Aug 2026).
const isPlaceholderName = (n) =>
  /^(the|there|a|an|villa|owner|manager|contact|admin|info|office)$/i.test(String(firstName(n)));
const greetName = (n) => isPlaceholderName(n) ? 'there' : firstName(n);

// ── WhatsApp senders (self-contained so this module can be used from the
// webhook and the cron without importing either) ───────────────────────────
async function waText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token || !to) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    const d = await r.json().catch(() => ({}));
    return d?.messages?.[0]?.id || null;
  } catch (e) {
    console.warn('relay waText failed:', e.message);
    return null;
  }
}

// Free text with up to 3 native reply buttons. Viewing asks use this so the
// contact can approve the agent's slot with one tap — a structured button id
// comes back instead of prose for the answer-matcher to interpret. Falls back
// to plain text if Meta rejects the interactive shape (>1024 chars etc.).
// A native contact card, so the agent can tap to save and message.
async function waContact(wa, to, name, phone) {
  const num = String(phone || '').replace(/\D/g, '');
  if (!num) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'contacts',
        contacts: [{ name: { formatted_name: name || 'Villa contact', first_name: (name || 'Villa contact').split(' ')[0] }, phones: [{ phone: '+' + num, type: 'WORK', wa_id: num }] }] }),
    });
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || null;
  } catch { return null; }
}

// A hand-back is delivered through the same leg as an answer, so it gets
// the re-opener template when the agent's window has shut. The prefix tells
// deliverAnswers to phrase it honestly and attach the card.
export const HANDBACK_PREFIX = '[handback]';
export function handbackText(prop, contactName, contactWa) {
  const who = (contactName && !isPlaceholderName(contactName)) ? contactName : 'the villa contact';
  return `${HANDBACK_PREFIX}Still no answer from the villa side on ${prop}, sorry — I'll keep trying, but the quickest route now is ${who} directly on +${String(contactWa || '').replace(/\D/g, '')}. Sending the card again so it's to hand.`;
}

async function waTextButtons(wa, to, body, buttons) {
  if (!wa?.phoneId || !wa?.token || !to) return null;
  const btns = (buttons || []).slice(0, 3)
    .map(b => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } }));
  if (!btns.length || String(body).length > 1024) return waText(wa, to, body);
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: { type: 'button', body: { text: body }, action: { buttons: btns } },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (d?.messages?.[0]?.id) return d.messages[0].id;
    return waText(wa, to, body);
  } catch { return waText(wa, to, body); }
}

const viewingButtons = (relayId) => [
  { id: `vwr:${relayId}:yes`,   title: 'Confirm ✓' },
  { id: `vwr:${relayId}:other`, title: 'Different time' },
  { id: `vwr:${relayId}:no`,    title: "Can't this time" },
];

async function waTemplate(wa, to, name, param) {
  return (await waTemplateResult(wa, to, name, param)).id;
}

// Same send, but keeps Meta's error code so a caller can tell "this template
// does not exist yet" apart from "this send was refused" — the difference
// between a fallback that is correct and one that just burns a second attempt.
async function waTemplateResult(wa, to, name, param) {
  if (!wa?.phoneId || !wa?.token || !to) return { id: null, code: null };
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name, language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: String(param).slice(0, 120) }] }],
        },
      }),
    });
    const d = await r.json().catch(() => ({}));
    return { id: d?.messages?.[0]?.id || null, code: d?.error?.code ?? null };
  } catch (e) {
    console.warn('relay waTemplate failed:', e.message);
    return { id: null, code: null };
  }
}

// The re-opener that tells a listing contact an agent is waiting on them.
//
// This is an operational message about the contact's own property, and the
// module has always described it as a UTILITY template — but it was registered
// at Meta as MARKETING, which put it under the per-user marketing throttle.
// On 30 Aug 2026 that threw 131049 at a villa contact at 05:00 while an agent
// had a client wanting to view within the hour; the contact never heard, and
// the viewing died. maya_owner_question_v2 is the same copy filed as UTILITY.
//
// Note Meta does NOT honour a requested category: it classifies from the body
// text. Resubmitting the v1 wording as UTILITY came straight back as MARKETING
// (maya_owner_question_v2). Only the v3 wording — which names a pending item on
// the recipient's own listing and promises nothing — classifies as UTILITY.
// Copy is the lever here, not the category field.
//
// Try newest first and fall through only when a name genuinely isn't usable yet
// (132001 = template does not exist / not approved), so the moment v3 clears
// review it takes over with no deploy. A refusal for any other reason — a
// throttle, a bad number — must NOT be retried on a marketing template: doing
// that is the exact behaviour this is meant to end.
const OWNER_QUESTION_TEMPLATES = [
  'maya_owner_question_v3',   // UTILITY — outside the marketing throttle
  'maya_owner_question',      // MARKETING — legacy fallback while v3 is in review
];
const TEMPLATE_MISSING_CODES = new Set([132001, 132000, 132005, 132007, 132012, 132015]);
async function sendOwnerQuestionTemplate(wa, to, prop) {
  for (const name of OWNER_QUESTION_TEMPLATES) {
    const r = await waTemplateResult(wa, to, name, prop);
    if (r.id) return r.id;
    // Fall through ONLY on "that template is not usable yet". A null code —
    // network failure, malformed response — is not that: retrying it on the
    // marketing template is the exact behaviour this walk exists to end, in
    // the one case where we cannot even see why the first send died.
    if (!TEMPLATE_MISSING_CODES.has(r.code)) return null;
  }
  return null;
}

// ── Supabase helpers ───────────────────────────────────────────────────────
async function sbGet(db, path) {
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function sbPatch(db, path, body) {
  try {
    await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
      method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
    });
    return true;
  } catch { return false; }
}

// Mirror a relay message into wa_messages so the inbox shows the full story:
// what Maya asked the owner, and what came back to the agent.
async function logMessage(db, { agentId, ownerId, waNum, content, waMessageId, direction = 'outbound' }) {
  try {
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: db.sbHeaders,
      body: JSON.stringify({
        agent_id: agentId ?? null, wa_num: waNum, direction, content,
        wa_message_id: waMessageId || null, timestamp: new Date().toISOString(),
        source: 'relay', ...(ownerId ? { owner_id: ownerId } : {}),
      }),
    });
  } catch { /* logging must never break a relay */ }
}

// The webhook mirrors its relay acks (thank-yous, confirm-nudges) through
// this so a contact's console thread shows both sides of the exchange.
export async function logRelayAck(db, { ownerId, waNum, content, waMessageId }) {
  if (ownerId == null) ownerId = await ownerIdByWa(db, waNum);
  return logMessage(db, { ownerId, waNum: String(waNum || '').replace(/\D/g, ''), content, waMessageId });
}

// ── Leg 1: ask the contact ─────────────────────────────────────────────────
// Returns { ok, status, reason }. `status` is 'asked' when the question was
// delivered outright, 'queued' when the contact's window was shut and the
// template went out instead.

// Has this number messaged us in the last 24 h? Meta only delivers free text
// inside that window; outside it the send is *accepted* (an id comes back)
// and then fails asynchronously with 131047 — so "got an id" is not "it
// arrived". Decide up front from our own inbound log.
export async function windowOpen(db, num) {
  const to = String(num || '').replace(/\D/g, '');
  if (!to) return false;
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const rows = await sbGet(db, `wa_messages?wa_num=eq.${to}&direction=eq.inbound&timestamp=gte.${since}&select=id&limit=1`);
  return rows.length > 0;
}

// A relay contact is often an owner in the CRM even when the caller doesn't
// know it (the listing-info chase only has the portal's waNumber). Resolve the
// owner row so every mirrored message lands in their console thread — rows
// logged with owner_id null are invisible there (Nindi, 26 Aug 2026).
export async function ownerIdByWa(db, num) {
  const to = String(num || '').replace(/\D/g, '');
  if (!to) return null;
  const rows = await sbGet(db, `owners?wa_num=eq.${to}&select=id&limit=1`);
  return rows?.[0]?.id ?? null;
}

export async function openRelay(db, wa, {
  agent, question, slug, propertyName, contactName, contactWa, ownerId = null,
}) {
  const q = String(question || '').trim();
  const to = String(contactWa || '').replace(/\D/g, '');
  if (!q || !to) return { ok: false, reason: 'missing question or contact' };
  if (ownerId == null) ownerId = await ownerIdByWa(db, to);
  // Never relay a question back to the person who asked it.
  if (to === String(agent?.wa_num || '').replace(/\D/g, '')) {
    return { ok: false, reason: 'contact is the agent' };
  }

  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600e3).toISOString();
  const open = await sbGet(db,
    `relays?contact_wa=eq.${to}&status=in.(queued,asked,answered)&asked_at=gte.${since}&select=id,question,rental_slug`);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (open.some(r => norm(r.question) === norm(q))) {
    return { ok: false, reason: 'already asked' };
  }
  // Exact-match dedup cannot catch a paraphrase, and model-worded questions
  // are never byte-identical: Villa Rice's contact got "Does Villa Rice have
  // an oven", "Does the villa have a washing machine and an oven available",
  // and "Does this villa have a washing machine and an oven" as three relays
  // inside 90 minutes. So a plain information question is blocked while ANY
  // plain information question about the same listing is already open — the
  // owner answers what is pending, and the agent's new detail rides the next
  // ask. Viewings and listing-live notes stay exempt: a viewing request must
  // never queue behind a fact question.
  if (!isViewing(q) && !isListingLive(q)) {
    const sameListing = open.find(r =>
      r.rental_slug && slug && r.rental_slug === slug
      && !isViewing(r.question) && !isListingLive(r.question));
    if (sameListing) {
      return { ok: false, reason: `a question about this listing is already with the contact (relay ${sameListing.id})` };
    }
  }

  let row = null, insertErr = null;
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/relays`, {
      method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_id: agent?.id ?? null,
        agent_wa: String(agent?.wa_num || '').replace(/\D/g, ''),
        agent_name: agent?.name || agent?.agency || null,
        rental_slug: slug || null,
        property_name: propertyName || null,
        question: q.slice(0, 2000),
        contact_name: contactName || null,
        contact_wa: to,
        owner_id: ownerId,
        status: 'asked',
      }),
    });
    const txt = await r.text();
    if (!r.ok) insertErr = `HTTP ${r.status} ${txt.slice(0, 200)}`;
    else row = JSON.parse(txt || '[]')?.[0];
  } catch (e) {
    insertErr = e.message;
    console.warn('openRelay insert failed:', e.message);
  }
  if (!row?.id) return { ok: false, reason: `insert failed: ${insertErr || 'no row returned'}` };

  const prop = propertyName || slug || 'one of your listings';
  // Deliberately anonymous: "an agent", never which one. The contact answers
  // the property question; the relationship stays Maya's to broker.
  const body = relayBody(contactName, prop, q);
  // Free text only inside an open window; otherwise straight to the template.
  // Viewing asks carry approve/decline buttons keyed to this relay's id.
  const mid = (await windowOpen(db, to))
    ? (isViewing(q) ? await waTextButtons(wa, to, body, viewingButtons(row.id)) : await waText(wa, to, body))
    : null;
  if (mid) {
    await logMessage(db, { ownerId, waNum: to, content: isListingLive(q) ? body : `[Relay → ${prop}] ${q}`, waMessageId: mid });
    if (isListingLive(q)) await sbPatch(db, `relays?id=eq.${row.id}`, { status: 'delivered', delivered_at: new Date().toISOString() });
    return { ok: true, status: isListingLive(q) ? 'delivered' : 'asked', relayId: row.id };
  }

  // Window shut — open it with the template. The question itself goes out the
  // moment they reply (flushRelayQuestions).
  // ONE re-opener per contact per 6h: their single reply flushes EVERY queued
  // question, so a second template buys nothing and reads as spam — Vira got
  // three in 46 minutes when Maya asked the same thing in different words
  // (27 Aug 2026). The relay parks as queued behind the earlier ping.
  const throttleSince = new Date(Date.now() - 6 * 3600e3).toISOString();
  const recentPing = await sbGet(db,
    `relays?contact_wa=eq.${to}&template_sent_at=gte.${throttleSince}&select=id&limit=1`);
  if (recentPing.length) {
    await sbPatch(db, `relays?id=eq.${row.id}`,
      { status: 'queued', template_sent_at: new Date().toISOString() });
    return { ok: true, status: 'queued', relayId: row.id, throttled: true };
  }
  const tid = await sendOwnerQuestionTemplate(wa, to, prop);
  if (!tid) {
    // The re-opener never left the building (template missing/unapproved, or
    // Meta rejected the send). Marking this 'queued' anyway is how every chase
    // round from 22-24 Aug 2026 silently went nowhere — fail loudly instead so
    // the caller doesn't burn its round and the cron summary shows the reason.
    await sbPatch(db, `relays?id=eq.${row.id}`, { status: 'failed' });
    return { ok: false, reason: `re-opener template ${OWNER_QUESTION_TEMPLATE} failed to send (unapproved or rejected)` };
  }
  await sbPatch(db, `relays?id=eq.${row.id}`,
    { status: 'queued', template_sent_at: new Date().toISOString() });
  await logMessage(db, {
    ownerId, waNum: to, waMessageId: tid,
    content: `[Relay template: question waiting about ${prop}]`,
  });
  return { ok: true, status: 'queued', relayId: row.id };
}

// The contact replied (usually "OK" to the template), so their window is open:
// deliver every question that was waiting on it. Returns how many went out.
export async function flushRelayQuestions(db, wa, fromNum) {
  const to = String(fromNum || '').replace(/\D/g, '');
  if (!to) return 0;
  const rows = await sbGet(db, `relays?contact_wa=eq.${to}&status=eq.queued&select=*`);
  let sent = 0;
  for (const r of rows) {
    const prop = r.property_name || r.rental_slug || 'your listing';
    const body = relayBody(r.contact_name, prop, r.question, { followUp: true });
    const mid = isViewing(r.question)
      ? await waTextButtons(wa, to, body, viewingButtons(r.id))
      : await waText(wa, to, body);
    if (!mid) continue;
    const live = isListingLive(r.question);
    await sbPatch(db, `relays?id=eq.${r.id}`, live ? { status: 'delivered', delivered_at: new Date().toISOString() } : { status: 'asked', asked_at: new Date().toISOString() });
    await logMessage(db, {
      ownerId: r.owner_id, waNum: to, waMessageId: mid,
      content: live ? body : `[Relay → ${prop}] ${r.question}`,
    });
    sent++;
  }
  return sent;
}

// Questions currently sitting with this contact — fed into Maya's owner-mode
// prompt so she recognises an answer when it arrives.
export async function openRelaysForContact(db, contactWa) {
  const to = String(contactWa || '').replace(/\D/g, '');
  if (!to) return [];
  return sbGet(db,
    `relays?contact_wa=eq.${to}&status=eq.asked&select=id,question,property_name,rental_slug,agent_wa,agent_id,owner_id,contact_name,asked_at&order=asked_at.asc`);
}

// ── Leg 2: read the contact's reply ────────────────────────────────────────
// A cheap, tightly-scoped extraction: which open question does this message
// answer, what IS the answer, and is it a durable fact worth keeping? Returns
// null when the message isn't an answer at all (they asked something back,
// changed the subject, sent a sticker).
// When Maya's most recent message to the contact was itself the DELIVERY of
// one of the open questions, a reply arriving now is almost certainly its
// answer. Without this, the disambiguation guard below turns self-defeating:
// "their reply is to Maya's last message, not to a listed question" is
// literally true — the last message WAS the listed question — and the model
// bails on the commonest timing there is (Villa Tiga, 31 Aug: a complete
// answer 60 seconds after the flush, matched to nothing, owner furious).
export function detectDeliveredRelay(lastOutbound, relays) {
  const lo = String(lastOutbound || '').toLowerCase().replace(/\s+/g, ' ');
  if (!lo) return null;
  for (const r of relays || []) {
    const q = String(r.question || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (q && lo.includes(q.slice(0, 80))) return r;
  }
  return null;
}

export async function captureRelayAnswer(apiKey, relays, message, { lastOutbound = null } = {}) {
  if (!apiKey || !relays?.length || !String(message || '').trim()) return null;
  const list = relays.map(r =>
    `- id ${r.id}: about ${r.property_name || r.rental_slug || 'a listing'} — "${r.question}"`).join('\n');
  const delivered = detectDeliveredRelay(lastOutbound, relays);
  const system = `You match a villa owner's WhatsApp reply to the open agent question it answers.

OPEN QUESTIONS:
${list}
${delivered ? `
CONTEXT — Maya's MOST RECENT message to this contact was the DELIVERY of question id ${delivered.id}. A reply arriving now most likely answers id ${delivered.id}; match it unless the reply is clearly about something else.` : lastOutbound ? `
CONTEXT — Maya's MOST RECENT message to this contact (their reply may be to THIS, not to any open question):
"${String(lastOutbound).slice(0, 400)}"
If the reply reads as a response to that message rather than to a listed question, return relay_id null. ("Tidak ada" right after Maya asked about a calendar is about the calendar — not an answer to an unrelated open question.)` : ''}

Return ONLY JSON:
{ "relay_id": <id or null>, "answer": "<their answer, rewritten as one clear sentence an agent can act on>", "durable_fact": "<a permanent fact about the property worth storing, or null>", "confident": true|false, "viewing": null | { "outcome": "confirmed" | "declined" | "unclear", "scheduled_at": "<ISO 8601 datetime with +08:00 offset when they confirmed a concrete slot, else null>" } }

Rules:
- relay_id null when the message does not answer any open question (a question back, small talk, an unrelated remark, a sticker). Do not force a match.
- relay_id null when the message is frustration or a complaint — about being asked repeatedly ("sudah saya bilang", "jangan tanya lagi", "stop asking", "I already told you"), or any angry tone. Anger about repetition is NEVER an answer, even when its words could fit a question. Forcing a match here fabricates a quote in the owner's name.
- relay_id null when their message asks a clarifying question back ("what kind of pets?", "which dates?") — that needs a human reply, not a recorded answer.
- "answer" stays faithful to what they said. Never add detail they did not give, never soften a no.
- "durable_fact" ONLY for things that stay true (a bathtub, an oven, a generator, the pet policy, parking). Null for anything about a specific date, a specific guest, a price, or availability — those go stale.
- "confident" false if their reply is vague or partial ("maybe", "I think so", "let me check") — Maya will ask them to confirm rather than pass a guess to an agent.
- "viewing" ONLY when the matched question is a VIEWING request (it asks to confirm a visit slot): "confirmed" when they accept a time (set scheduled_at to the concrete slot when one is nameable — resolve relative days against today, Bali time +08:00), "declined" when they refuse the viewing outright, "unclear" when they propose alternatives without settling. For any non-viewing question, viewing is null.
Today's date: ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)} (Bali, +08:00).`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400, system,
        messages: [{ role: 'user', content: `Their reply: "${String(message).slice(0, 1500)}"` }],
      }),
    });
    const d = await r.json();
    if (!r.ok || d.type === 'error') return null;
    const m = (d.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    if (!p.relay_id || !String(p.answer || '').trim()) return null;
    const relay = relays.find(x => String(x.id) === String(p.relay_id));
    if (!relay) return null;
    return {
      relay,
      answer: String(p.answer).slice(0, 800),
      durableFact: p.durable_fact ? String(p.durable_fact).slice(0, 300) : null,
      confident: p.confident !== false,
      viewing: (p.viewing && typeof p.viewing === 'object' && p.viewing.outcome)
        ? { outcome: String(p.viewing.outcome), scheduledAt: p.viewing.scheduled_at && !Number.isNaN(Date.parse(p.viewing.scheduled_at)) ? new Date(p.viewing.scheduled_at).toISOString() : null }
        : null,
    };
  } catch (e) {
    console.warn('captureRelayAnswer failed:', e.message);
    return null;
  }
}

// Store the answer. The durable fact is STAGED, not applied — Ikiel approves
// it before Maya starts quoting it to the network.
export async function recordAnswer(db, relayId, { answer, durableFact }) {
  return sbPatch(db, `relays?id=eq.${relayId}`, {
    status: 'answered',
    answer: String(answer).slice(0, 800),
    answered_at: new Date().toISOString(),
    ...(durableFact ? { kb_fact: durableFact, kb_status: 'pending' } : {}),
  });
}

// ── Leg 3: carry the answer back to the agent ──────────────────────────────
// Try free text; if the agent's window has shut, fire maya_answer_ready and
// leave the relay 'answered' so it flushes the moment they reply.
export async function deliverAnswers(db, wa, agentWa) {
  const to = String(agentWa || '').replace(/\D/g, '');
  if (!to) return 0;
  const rows = await sbGet(db, `relays?agent_wa=eq.${to}&status=eq.answered&select=*&order=answered_at.asc`);
  let delivered = 0;
  for (const r of rows) {
    const prop = r.property_name || r.rental_slug || 'that property';
    const isHandback = String(r.answer || '').startsWith(HANDBACK_PREFIX);
    const who = (r.contact_name && !isPlaceholderName(r.contact_name)) ? ` ${firstName(r.contact_name)} confirmed:` : ' They confirmed:';
    const body = isHandback ? String(r.answer).slice(HANDBACK_PREFIX.length) : `Good news on ${prop} —${who} ${r.answer}`;
    const mid = await waText(wa, to, body);
    if (mid) {
      if (isHandback) {
        const cmid = await waContact(wa, to, r.contact_name, r.contact_wa);
        if (cmid) await logMessage(db, { agentId: r.agent_id, waNum: to, content: `[Contact card: ${r.contact_name || 'Villa contact'} — +${r.contact_wa}]`, waMessageId: cmid });
      }
      await sbPatch(db, `relays?id=eq.${r.id}`, isHandback
        ? { status: 'expired', delivered_at: new Date().toISOString() }
        : { status: 'delivered', delivered_at: new Date().toISOString() });
      await logMessage(db, { agentId: r.agent_id, waNum: to, content: body, waMessageId: mid });
      delivered++;
      continue;
    }
    // Window shut. Send the re-opener, then let the answer wait in the row.
    // answer_template_at is this leg's own clock — template_sent_at belongs to
    // the contact leg, and sharing it would let one leg silence the other.
    // One reminder a day at most if the agent never comes back for it.
    const lastPing = r.answer_template_at ? Date.parse(r.answer_template_at) : 0;
    if (Date.now() - lastPing > 24 * 3600e3) {
      const tid = await waTemplate(wa, to, ANSWER_READY_TEMPLATE, prop);
      await sbPatch(db, `relays?id=eq.${r.id}`, { answer_template_at: new Date().toISOString() });
      await logMessage(db, {
        agentId: r.agent_id, waNum: to, waMessageId: tid,
        content: `[Relay template: answer ready about ${prop}]`,
      });
    }
  }
  return delivered;
}

// ── Sweep: nudge, expire, and never leave a promise hanging ────────────────
// Run from the cron. A question nobody answered is not allowed to just vanish:
// the agent was told Maya would come back to them, so she does — even when the
// answer is "the owner hasn't come back to me".
export async function sweepRelays(db, wa) {
  const now = Date.now();
  const out = { nudged: 0, expired: 0, retried: 0, repaired: 0 };

  // Repair: an 'asked' relay whose free-text question was later reported
  // failed by Meta (131047, window shut). Send the re-opener template and
  // park the relay as 'queued' so the question goes out when they reply.
  const asked = await sbGet(db, `relays?status=eq.asked&template_sent_at=is.null&select=id,contact_wa,contact_name,property_name,rental_slug,owner_id,asked_at`);
  for (const r of asked) {
    const since = new Date(Date.parse(r.asked_at) - 60e3).toISOString();
    const failed = await sbGet(db, `wa_messages?wa_num=eq.${r.contact_wa}&direction=eq.outbound&status=eq.failed&timestamp=gte.${since}&content=like.*Relay*&select=id&limit=1`);
    if (!failed.length) continue;
    const prop = r.property_name || r.rental_slug || 'your listing';
    const tid = await sendOwnerQuestionTemplate(wa, r.contact_wa, prop);
    await sbPatch(db, `relays?id=eq.${r.id}`, { status: 'queued', template_sent_at: new Date().toISOString() });
    await logMessage(db, { ownerId: r.owner_id, waNum: r.contact_wa, waMessageId: tid, content: `[Relay template: question waiting about ${prop}]` });
    out.repaired++;
  }

  const nudgeCut = new Date(now - NUDGE_AFTER_HOURS * 3600e3).toISOString();
  const stale = await sbGet(db,
    `relays?status=in.(queued,asked)&asked_at=lte.${nudgeCut}&nudges=lt.${MAX_NUDGES + 1}&select=*`);
  for (const r of stale) {
    const ageH = (now - Date.parse(r.asked_at || r.created_at)) / 3600e3;

    if (ageH >= RELAY_TTL_HOURS) {
      // Expired: hand the agent the contact outright (not "I can put you in
      // touch"), through the answer leg so a shut window still gets the
      // re-opener template and the card follows when they reply. The relay
      // itself stays open for the Monday re-ask (see reaskExpired).
      const prop = r.property_name || r.rental_slug || 'that villa';
      const hasAgent = r.agent_wa && !isListingInfo(r.question) && !isListingLive(r.question);
      await sbPatch(db, `relays?id=eq.${r.id}`, hasAgent
        ? { status: 'answered', answer: handbackText(prop, r.contact_name, r.contact_wa), answered_at: new Date().toISOString() }
        : { status: 'expired' });
      out.expired++;
      continue;
    }

    if ((r.nudges || 0) >= MAX_NUDGES) continue;
    const prop = r.property_name || r.rental_slug || 'your listing';
    const body = `Hi ${firstName(r.contact_name)}, just a gentle nudge on the agent question about ${prop}:\n`
      + `"${r.question}"\n\nWhenever you have a moment — I'll pass your answer straight on.`;
    const mid = await waText(wa, r.contact_wa, body);
    if (mid) {
      await sbPatch(db, `relays?id=eq.${r.id}`,
        { nudges: (r.nudges || 0) + 1, last_nudge_at: new Date().toISOString(), status: 'asked' });
      out.nudged++;
    }
  }

  try { out.reask = await reaskExpired(db, wa); } catch (e) { out.reask = { error: e.message }; }

  // Listing-info relays have no agent to carry the answer to: the staged fact
  // (Ikiel's approval queue) IS the outcome. Close them as delivered.
  const orphan = await sbGet(db, `relays?status=eq.answered&or=(agent_wa.is.null,agent_wa.eq.)&select=id`);
  for (const o of orphan) await sbPatch(db, `relays?id=eq.${o.id}`, { status: 'delivered', delivered_at: new Date().toISOString() });
  // Answers still sitting undelivered (agent never replied to the re-opener).
  const pending = await sbGet(db, `relays?status=eq.answered&agent_wa=not.is.null&agent_wa=neq.&select=agent_wa`);
  for (const wanum of [...new Set(pending.map(p => p.agent_wa))]) {
    out.retried += await deliverAnswers(db, wa, wanum);
  }
  return out;
}

// ── Monday: one message per contact with everything still unanswered ─────────
// 33 of 46 relays expired unanswered (3 Sep 2026). A question that died on a
// Tuesday is still worth an answer the following week, but as ONE grouped
// note per contact, not a fresh chase per relay. Expired plain-information
// relays from the last 30 days are re-queued and the contact gets the
// re-opener template (or the questions directly if their window is open);
// their reply flushes the queue through the normal path. Each relay is
// re-asked once (nudges is parked at REASK_MARK).
const REASK_MARK = 5;
export async function reaskExpired(db, wa, { now = new Date() } = {}) {
  const out = { contacts: 0, relays: 0, skipped: 0 };
  const wita = new Date(now.getTime() + 8 * 3600e3);
  if (wita.getUTCDay() !== 1) return { ...out, skipped: 'not Monday' };
  const stampKey = 'relay_reask_week', week = wita.toISOString().slice(0, 10);
  const stamp = await sbGet(db, `settings?key=eq.${stampKey}&select=value`);
  if (stamp?.[0]?.value === week) return { ...out, skipped: 'already ran' };
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: stampKey, value: week }) }).catch(() => {});

  const since = new Date(now.getTime() - 30 * 86400e3).toISOString();
  const rows = await sbGet(db, `relays?status=eq.expired&nudges=lt.${REASK_MARK}&created_at=gte.${since}&select=*&order=contact_wa.asc,created_at.asc`);
  const byContact = {};
  for (const r of rows) {
    if (isViewing(r.question) || isListingLive(r.question) || !r.contact_wa) continue;
    (byContact[r.contact_wa] ||= []).push(r);
  }
  for (const [to, list] of Object.entries(byContact)) {
    // Re-queue, one relay per distinct question, newest wording wins.
    const seen = new Set(); const keep = [];
    for (const r of [...list].reverse()) { const k = String(r.question).toLowerCase().replace(/[^a-z0-9 ]/g, ''); if (seen.has(k)) continue; seen.add(k); keep.push(r); }
    for (const r of keep) await sbPatch(db, `relays?id=eq.${r.id}`, { status: 'queued', nudges: REASK_MARK, asked_at: now.toISOString(), template_sent_at: now.toISOString() });
    const prop = keep[0].property_name || keep[0].rental_slug || 'your listing';
    if (await windowOpen(db, to)) {
      await flushRelayQuestions(db, wa, to);
    } else {
      const tid = await sendOwnerQuestionTemplate(wa, to, keep.length > 1 ? `${prop} (+${keep.length - 1} more)` : prop);
      await logMessage(db, { ownerId: keep[0].owner_id, waNum: to, waMessageId: tid, content: `[Relay template: ${keep.length} question${keep.length > 1 ? 's' : ''} still waiting about ${prop}]` });
    }
    out.contacts++; out.relays += keep.length;
  }
  return out;
}

// ── Staged KB facts (Ikiel's approval queue) ───────────────────────────────
export async function listPendingFacts(db, limit = 25) {
  return sbGet(db,
    `relays?kb_status=eq.pending&select=id,rental_slug,property_name,question,answer,kb_fact,contact_name,answered_at&order=answered_at.desc&limit=${limit}`);
}

// Approve → append the fact to that listing's extended_info (the field Maya
// already quotes from), reject → drop it. Either way the relay itself is
// untouched: the agent got their answer at the time regardless.
export async function resolveFact(db, relayId, approve) {
  const rows = await sbGet(db, `relays?id=eq.${relayId}&select=*`);
  const r = rows?.[0];
  if (!r) return { ok: false, error: 'relay not found' };
  if (r.kb_status !== 'pending') return { ok: false, error: `fact is already ${r.kb_status || 'unset'}` };

  if (!approve) {
    await sbPatch(db, `relays?id=eq.${relayId}`, { kb_status: 'rejected' });
    return { ok: true, applied: false };
  }
  if (!r.rental_slug) {
    await sbPatch(db, `relays?id=eq.${relayId}`, { kb_status: 'rejected' });
    return { ok: false, error: 'no listing slug on this relay — nothing to update' };
  }

  const listing = (await sbGet(db, `rentals?slug=eq.${r.rental_slug}&select=id,extended_info`))?.[0];
  if (!listing) return { ok: false, error: `listing "${r.rental_slug}" not found` };
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `${r.kb_fact} (confirmed by ${r.contact_name || 'the villa contact'}, ${stamp})`;
  const merged = [listing.extended_info, line].filter(Boolean).join('\n');
  await sbPatch(db, `rentals?id=eq.${listing.id}`, { extended_info: merged, updated_at: new Date().toISOString() });
  await sbPatch(db, `relays?id=eq.${relayId}`, { kb_status: 'approved' });
  return { ok: true, applied: true, slug: r.rental_slug, fact: line };
}
