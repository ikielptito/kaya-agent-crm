import { PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, BROCHURES as FALLBACK_BROCHURES, MAYA_PERSONA } from '../lib/kb.js';
import { loadPlaybookBlock } from '../lib/maya-review.js';
import { forwardInbound, forwardMayaReply, postToTelegram } from '../lib/telegram.js';
import { stopAllPending, mostRecentEngagement } from '../lib/engagement.js';
import { createAgentRow } from '../lib/agents.js';
import { patchAgent, applyCrmUpdates, applyCrmActions, CRM_SIGNALS_INSTRUCTIONS } from '../lib/crm-apply.js';
import { resolveListingCards, sendListingCardMessage, cardMarker } from '../lib/listing-cards.js';
import { transcribeWaAudio } from '../lib/transcribe.js';
import { isProspect, isOptOut, buildOnboardingPitch, fetchAgentReach, ONBOARD_MEDIA, sendOwnerImage } from '../lib/owner-onboarding.js';
import { driveConfigured, createOwnerFolder, folderLink, uploadWaImageToDrive } from '../lib/drive-upload.js';
import { openRelay, flushRelayQuestions, openRelaysForContact, captureRelayAnswer, recordAnswer, deliverAnswers } from '../lib/relay.js';
import webpush from 'web-push';
import { AUTO_REPLY_RE } from '../lib/sla.js';
import crypto from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v24.0';

// ── Team alerts (Maya → Ikiel / Era on WhatsApp) ───────────────────────
// When Maya promises "I'll check with Ikiel" or needs villa manager Era on a
// guest issue, she must actually ping them — immediately, whatever the hour.
// Free text goes out directly when their 24h session is open; otherwise the
// approved utility template (TEAM_ALERT_TEMPLATE) opens the conversation and
// the queued detail flushes when they reply (see flushTeamAlerts).
const ERA_WA_NUM = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
const OWNER_NUM = String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
const TEAM_NUMS = new Set([ERA_WA_NUM, OWNER_NUM].filter(Boolean));
const TEAM_ALERT_TEMPLATE = 'maya_team_alert';

async function sendTeamTemplate(phoneId, token, to, param) {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: TEAM_ALERT_TEMPLATE, language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: String(param).slice(0, 120) }] }],
        },
      }),
    });
    const data = await r.json();
    return data.messages?.[0]?.id || null;
  } catch (_) { return null; }
}

async function readTeamAlertQueue(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.team_alerts&select=value`, { headers });
    const v = (await r.json())?.[0]?.value;
    return (v && typeof v === 'object') ? v : {};
  } catch (_) { return {}; }
}

async function writeTeamAlertQueue(url, headers, value) {
  await fetch(`${url}/rest/v1/settings`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'team_alerts', value }),
  }).catch(() => {});
}

// Send one alert to Ikiel or Era. Direct free text first (works whenever their
// 24h window is open); on failure, queue the detail and open the window with
// the approved template. Always fire-and-forget from the caller's perspective.
async function notifyTeam(url, headers, phoneId, token, { to, summary, shareContact }, agent) {
  const num = to === 'era' ? ERA_WA_NUM : OWNER_NUM;
  if (!num || !phoneId || !token) return false;
  const who = agent?.name || (agent?.wa_num ? '+' + agent.wa_num : 'unknown contact');
  const detail = `Maya team alert — ${who}:\n${summary}${agent?.wa_num ? `\nTheir number: +${agent.wa_num}` : ''}`;
  const mid = await sendText(phoneId, token, num, detail);
  if (mid) {
    if (shareContact && agent?.wa_num) await sendContactCard(phoneId, token, num, who, agent.wa_num);
    return true;
  }
  const q = await readTeamAlertQueue(url, headers);
  const list = Array.isArray(q[num]) ? q[num] : [];
  list.push({ summary: String(summary).slice(0, 500), agent_name: who, agent_num: agent?.wa_num || null, share_contact: !!shareContact, ts: new Date().toISOString() });
  q[num] = list.slice(-10);
  await writeTeamAlertQueue(url, headers, q);
  await sendTeamTemplate(phoneId, token, num, who);
  return true;
}

// Deliver every queued alert for a team member the moment they message in
// (their reply opens the 24h window). Returns true when anything was flushed.
async function flushTeamAlerts(url, headers, phoneId, token, fromNum) {
  const q = await readTeamAlertQueue(url, headers);
  const list = Array.isArray(q[fromNum]) ? q[fromNum] : [];
  if (!list.length) return false;
  for (const item of list) {
    const detail = `Maya team alert — ${item.agent_name}:\n${item.summary}${item.agent_num ? `\nTheir number: +${item.agent_num}` : ''}`;
    await sendText(phoneId, token, fromNum, detail);
    if (item.share_contact && item.agent_num) await sendContactCard(phoneId, token, fromNum, item.agent_name, item.agent_num);
  }
  delete q[fromNum];
  await writeTeamAlertQueue(url, headers, q);
  return true;
}

// ── Question relay (agent ⇄ villa contact, brokered by Maya) ───────────
// Anyone who is a listing's "enquire with" contact — Era for our own villas,
// the owner or manager for theirs — may have open agent questions sitting with
// them. Their inbound message is checked against those questions BEFORE normal
// handling: an answer gets recorded and carried back to the agent, and nothing
// else about their thread changes. Returns true when the message was consumed
// as a relay answer, false when it's ordinary conversation.
// "OK" / "ya" / "thanks" — a message whose only content is that they showed
// up, which is exactly what a re-opener template asks for. It tells the relay
// legs when a delivery IS the whole turn, and when there's a real message
// underneath that still deserves a normal reply.
const isBareAck = (s) =>
  /^(ok(ay|e)?|ya|yes|yep|yup|sure|siap|noted|thanks?|thank you|terima kasih|👍|🙏)[\s.!]*$/i
    .test(String(s || '').trim());

async function handleRelayReply({ db, wa, fromNum, text, apiKey }) {
  const open = await openRelaysForContact(db, fromNum);
  if (!open.length) return false;
  const captured = await captureRelayAnswer(apiKey, open, text);
  if (!captured) return false;

  const prop = captured.relay.property_name || captured.relay.rental_slug || 'the villa';

  // A hedge ("maybe", "I think so") is not an answer an agent can quote to
  // their client. Ask once for a straight yes/no rather than passing a guess.
  if (!captured.confident) {
    await sendText(wa.phoneId, wa.token, fromNum,
      `Thanks! Just so I give the agent something solid on ${prop} — can you confirm either way?`);
    return true;
  }

  await recordAnswer(db, captured.relay.id, { answer: captured.answer, durableFact: captured.durableFact });
  await sendText(wa.phoneId, wa.token, fromNum,
    `Perfect, thank you — passing that straight back to the agent now.`);
  await deliverAnswers(db, wa, captured.relay.agent_wa);
  return true;
}

// ── Web Push to the Maya chat PWA ──────────────────────────────────────
// Fan out a notification to every subscribed device when an agent messages
// in. Subscriptions live in settings.push_subscriptions (saved by chat.html
// via /api/supabase save_push_subscription). Dead endpoints (410/404) are
// pruned. Fire-and-forget — never blocks or fails the webhook.
let _vapidReady = false;
function ensureVapid() {
  if (_vapidReady) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:ikielptito@gmail.com', pub, priv);
  _vapidReady = true;
  return true;
}

async function sendPushNotifications(supabaseUrl, sbHeaders, { title, body, agentId, badgeCount }) {
  if (!ensureVapid()) return;
  let list = [];
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/settings?key=eq.push_subscriptions&select=value`, { headers: sbHeaders });
    const row = (await r.json())?.[0];
    list = Array.isArray(row?.value) ? row.value : [];
  } catch (_) { return; }
  if (!list.length) return;

  // agentId ?? null (not `|| null`): agent id 0 is a real contact ("Oniriq") —
  // `0 || null` would drop it, breaking deep-link-to-thread on the push.
  const json = JSON.stringify({ title, body, agentId: agentId ?? null, url: '/chat.html', badge_count: badgeCount });
  const dead = [];
  await Promise.all(list.map(async sub => {
    try {
      await webpush.sendNotification(sub, json);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }));

  if (dead.length) {
    const alive = list.filter(s => !dead.includes(s.endpoint));
    fetch(`${supabaseUrl}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'push_subscriptions', value: alive })
    }).catch(() => {});
  }
}

// ── Loud generation-failure alert ──────────────────────────────────────
// When the Claude call itself errors (credit exhaustion, auth, overload),
// the failure must never be silent (the 21 Jul 2026 credit outage: every
// reply dissolved into an empty draft with no alert). The caller writes a
// loud marker into suggested_reply; this helper fires push + Telegram,
// throttled to one alert per 15 min across invocations so an outage doesn't
// spam once per inbound message. Alerting must never crash the webhook.
const FAILURE_ALERT_THROTTLE_MS = 15 * 60 * 1000;
async function alertGenerationFailure(supabaseUrl, sbHeaders, agent, errMsg) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/settings?key=eq.maya_failure_alert_at&select=value`, { headers: sbHeaders });
    const lastAt = (await r.json())?.[0]?.value?.at;
    if (lastAt && (Date.now() - new Date(lastAt).getTime()) < FAILURE_ALERT_THROTTLE_MS) return;
    await fetch(`${supabaseUrl}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'maya_failure_alert_at', value: { at: new Date().toISOString() } }),
    }).catch(() => {});
    const who = agent?.name || `agent #${agent?.id}`;
    await sendPushNotifications(supabaseUrl, sbHeaders, {
      title: '🚨 Maya is failing — replies not going out',
      body: `${who}: ${errMsg}`,
      agentId: agent?.id,
    }).catch(() => {});
    const safeErr = String(errMsg).replace(/[<>&]/g, '');
    await postToTelegram(
      `🚨 <b>Maya failed to reply</b> (${who})\n\n${safeErr}\n\nDraft slots are marked [Maya failed: …]. Fix the API/billing, then run resume-unanswered to catch up.`
    ).catch(() => {});
  } catch (_) { /* never block or fail the webhook on alerting */ }
}

// In-memory cache for projects (warm container only). 60s TTL.
let _projectsCache = null;
let _projectsCacheAt = 0;
const PROJECTS_CACHE_TTL_MS = 60 * 1000;
let _rentalsCache = null;
let _rentalsCacheAt = 0;

// Live availability digest from the Samba portal (warm-container cache, 5 min).
const PORTAL_BASE = 'https://sambarentals.com';
let _digestCache = null;
let _digestCacheAt = 0;
const DIGEST_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadDigest() {
  const now = Date.now();
  if (_digestCache && (now - _digestCacheAt) < DIGEST_CACHE_TTL_MS) return _digestCache;
  const secret = process.env.DIGEST_SHARED_SECRET;
  if (!secret) return _digestCache;  // not configured -> no live availability
  try {
    const r = await fetch(`${PORTAL_BASE}/api/digest`, { headers: { Authorization: `Bearer ${secret}` } });
    if (!r.ok) return _digestCache;  // keep stale data on a transient failure
    const data = await r.json();
    if (data && Array.isArray(data.properties)) {
      _digestCache = data;
      _digestCacheAt = now;
      return data;
    }
  } catch (e) {
    console.warn('loadDigest failed:', e.message);
  }
  return _digestCache;
}

// Per-property availability summary block for Maya's system prompt.
function buildAvailabilityContext(digest) {
  if (!digest || !Array.isArray(digest.properties) || digest.properties.length === 0) return '';
  const today = new Date().toISOString().slice(0, 10);
  let asOf = 'just now';
  try {
    asOf = new Date(digest.asOf).toLocaleString('en-GB', { timeZone: 'Asia/Makassar', dateStyle: 'medium', timeStyle: 'short' });
  } catch { /* keep default */ }
  const lines = digest.properties.map(p => {
    const a = p.availability || {};
    const nowState = a.availableToday ? 'available now' : 'occupied now';
    const next = a.nextAvailableFrom ? `next free from ${a.nextAvailableFrom}` : 'no free day in horizon';
    const longw = a.nextLongWindowFrom
      ? `long-term stay window from ${a.nextLongWindowFrom} (${a.longWindowDays} days open)`
      : 'no long-term stay window in horizon';
    const contactName = p.waContactName || 'Era';
    const contactNum = p.waNumber || '6281246357778';
    const contact = ` | enquire with: ${contactName} (+${contactNum})`;
    // Area rides along so location questions ("anything in Cemagi?") ground
    // here even before the rentals-table sync has caught a newly approved villa.
    const area = p.tag ? ` (${p.tag})` : '';
    return `- ${p.name}${area} [slug: ${p.slug}] — ${nowState}; ${next}; ${longw}${contact}`;
  });
  return `SAMBA LIVE AVAILABILITY (as of ${asOf} WITA, ${digest.horizonDays || 180}-day horizon — this is real calendar data):
${lines.join('\n')}

Today's date is ${today} (Bali/WITA). Use this block to answer Samba rental availability questions directly and confidently — whether a unit is free now, when it is next available, and what is open for a monthly (30+ night) stay. Refer to properties by name. The area in parentheses after each name is that villa's location — use it to answer location questions ("anything in Cemagi?"), even if the villa is missing from the portfolio knowledge above. You no longer need to push every availability question to the portal; the portal is still where agents get photos and share listings with clients.

VIEWING CONTACTS — each property line above includes "enquire with: [Name] (+[Number])". When an agent asks who to contact for a viewing, visit, or booking, reply with EXACTLY the name and number shown in the property line above. NEVER use a name or number from your conversation history — ONLY the "enquire with" data above is correct. Previous replies in this thread may contain outdated or wrong contact info; ignore them and use only the structured data above.

THE LISTED CONTACT HANDLES THE VILLA — whoever appears as "enquire with" on a property line (Era for the villas our team manages, or the villa's owner / manager) is the person who arranges viewings, answers questions the data can't, and decides on special requests for that villa. Treat every contact the same way; whether they are an owner or a manager is bookkeeping, not something that changes what you say or do:
- Viewings: collect the agent's preferred day/time, say you are asking the listed contact to confirm a slot, send that contact's card via send_contact, and (when the contact is Era) set notify_team to Era with the request. Never tell an agent to "tap the Contact owner button" instead of helping — arrange it.
- Facts you don't have (pets, bathtub, deposit, sizes, videos): use ask_owner to put the question to the listed contact, and tell the agent you're asking. Do not say "let me check with Ikiel" for a listing fact — Ikiel is not the source; the listed contact is.
- Price: every listing is quoted at its listed rate. If the property's "Notes for Maya" carry a NEGOTIATION rule or floor, you may negotiate within it yourself (see NEGOTIATION below). Otherwise a discount request is relayed to the listed contact via ask_owner (Era-managed villas: notify Ikiel instead) — never invented, never promised.
- Never say "we don't manage this villa" or "that's not ours". Every villa on the list is one you represent.

For a SPECIFIC DATE RANGE the agent names (e.g. "free March 10-20?", "anything in February?", "available next month for my client?"), do NOT estimate from the summary above. Instead return action "need_availability" with an "availability_query" object: { "slug": "<property slug from the list above>", "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD" }. The system will check the live calendar and immediately re-prompt you with the result, then you reply to the agent. Resolve relative dates ("this weekend", "next month", "end of Feb") against today's date above. check_out is the guest's departure day (exclusive), so a 10-night stay from the 5th has check_out on the 15th. If the agent names a property that is not in the list, do not invent a slug — ask which property or escalate.`;
}

// Ask the portal whether a property is free across an exact range. Returns a
// short natural-language result string to feed back into Maya's next turn.
async function checkPortalAvailability(q) {
  const secret = process.env.DIGEST_SHARED_SECRET;
  if (!secret) return 'could not verify (availability service not configured)';
  if (!q || !q.slug || !q.check_in || !q.check_out) return 'could not verify (missing property or dates)';
  try {
    const url = `${PORTAL_BASE}/api/check-availability?slug=${encodeURIComponent(q.slug)}`
      + `&check_in=${encodeURIComponent(q.check_in)}&check_out=${encodeURIComponent(q.check_out)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!r.ok) {
      if (r.status === 404) return `could not verify: "${q.slug}" is not a recognised property slug.`;
      return `could not verify (calendar returned ${r.status}).`;
    }
    const j = await r.json();
    const label = j.name || q.slug;
    if (j.available) {
      return `${label} is AVAILABLE for the full range ${q.check_in} to ${q.check_out} (${j.nights} nights).`;
    }
    const booked = (j.bookedDates || []);
    const detail = booked.length ? ` Booked/blocked dates in that range: ${booked.join(', ')}.` : '';
    return `${label} is NOT fully available for ${q.check_in} to ${q.check_out}.${detail}`;
  } catch (e) {
    return 'could not verify (network error reaching the calendar).';
  }
}

async function loadRentals(supabaseUrl, sbHeaders) {
  const now = Date.now();
  if (_rentalsCache && (now - _rentalsCacheAt) < PROJECTS_CACHE_TTL_MS) {
    return _rentalsCache;
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rentals?select=*&active=eq.true&order=display_order.asc`, { headers: sbHeaders });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      _rentalsCache = data;
      _rentalsCacheAt = now;
      return data;
    }
  } catch (e) {
    console.warn('loadRentals failed:', e.message);
  }
  return null;
}

function buildRentalsContext(rentals) {
  if (!rentals || rentals.length === 0) {
    return `SAMBA REALTY RENTAL PORTFOLIO:
Samba Realty manages a portfolio of monthly rental properties across Canggu, Pererenan, and Seminyak. Agent commission is 10%. Live availability is at sambarentals.com. For specific properties or live calendars, refer agents to the portal.`;
  }
  const blocks = rentals.map((p, i) => {
    // Samba rentals are long-term — quote monthly IDR only. Nightly fields exist
    // in the schema for short-term Airbnb scenarios but are NOT surfaced to Maya
    // by default to prevent her quoting them when agents expect monthly.
    const rate = p.monthly_rate_idr
      ? `IDR ${(p.monthly_rate_idr / 1e6).toFixed(0)}M/month` + (p.yearly_rate_idr ? ` (or IDR ${(p.yearly_rate_idr / 1e6).toFixed(0)}M/year)` : '')
      : 'rate TBC — say "let me check with Ikiel"';
    // Manual marketing badge from the portal admin ("Price drop", "New") —
    // a live selling point Maya should mention when pitching this villa.
    const badge = p.badge ? ` [${String(p.badge).toUpperCase()}]` : '';

    const capacity = [p.beds && `${p.beds} bed`, p.baths && `${p.baths} bath`, p.max_guests && `sleeps ${p.max_guests}`].filter(Boolean).join(', ');
    const occ = p.occupancy_pct ? `${p.occupancy_pct}% recent occupancy` : null;
    const actualRev = p.monthly_revenue_idr ? `~IDR ${(p.monthly_revenue_idr / 1e6).toFixed(1)}M/mo actual revenue` : null;
    const photoLink = p.photos_url ? `photos: ${p.photos_url}` : null;
    const mapsLink = p.maps_url ? `map: ${p.maps_url}` : null;
    const portalLink = p.portal_url ? `portal: ${p.portal_url}` : null;
    const links = [photoLink, mapsLink, portalLink].filter(Boolean).join(' · ');
    const lines = [
      `${i + 1}. ${p.name.toUpperCase()}${badge}${p.area ? ' -- ' + p.area : ''}${p.full_location ? ' (' + p.full_location + ')' : ''}`,
      p.slug ? `   Slug: ${p.slug}` : null,
      p.property_type ? `   Type: ${p.property_type}${capacity ? ', ' + capacity : ''}${p.sqm ? ', ' + p.sqm + ' sqm' : ''}` : null,
      `   Rate: ${rate}${p.min_stay_nights > 1 ? `, min ${p.min_stay_nights} nights` : ''}`,
      occ || actualRev ? `   Performance: ${[occ, actualRev].filter(Boolean).join(', ')}` : null,
      p.amenities ? `   Amenities: ${p.amenities}` : null,
      p.features ? `   Features: ${p.features}` : null,
      p.extended_info ? `   Details:\n${p.extended_info.split('\n').map(l => '     ' + l).join('\n')}` : null,
      links ? `   Links: ${links}` : null,
      p.maya_notes ? `   Notes for Maya: ${p.maya_notes}` : null,
      p.commission_pct ? `   Agent commission: ${p.commission_pct}%` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
  return `SAMBA REALTY RENTAL PORTFOLIO (current, live from DB):\n\n${blocks.join('\n\n')}\n\nSAMBA RENTAL HARD RULES (zero exceptions):
1. ALWAYS quote MONTHLY IDR rates. Never quote nightly USD or nightly IDR rates unless the agent explicitly asks for short-term/Airbnb pricing.
2. NEVER invent prices, bedroom counts, locations, property types, or amenities. Every fact you state must be present in the data block above.
3. If an agent asks about a property and a field isn't in the DB, do not guess: ask the listed contact via ask_owner and tell the agent you are checking with the villa (see THE LISTED CONTACT HANDLES THE VILLA).
4. If asked for PHOTOS → share the property's photos_url (Google Drive). If asked for LOCATION → share the property's maps_url (Google Maps). If neither is in the data, say you'll get it from Ikiel.
5. Property types are exactly what's listed (Apartment / Townhouse / Villa). HAUS Canggu units are 1BR APARTMENTS, not villas. Tropicana Valley units are 1BR APARTMENTS with private pools, not houses.
6. For live booking calendar availability, use the SAMBA LIVE AVAILABILITY data and need_availability — never send the agent to the portal to find out.
7. COMMISSION STRUCTURE (zero ambiguity): the 10% is ALREADY INCLUDED in the portal price. Agent quotes the portal price to their client; the agent's 10% comes out of what we collect. If the agent wants 20%, they may quote portal price + 10% to their client (the extra 10% comes from the client, not from us). Never say "commission is paid on top" or "you can earn 10% in addition to the price" — those phrasings break the deal structure.

CLIENT MATCHING RULES (when an agent gives criteria — bedrooms, budget, features, area, dates — follow these exactly):
1. Scan EVERY property in the portfolio above before answering. Never claim nothing matches until you have checked all of them against each stated criterion.
2. Lead with the properties that tick ALL the stated boxes. The closest full match ALWAYS comes first in your reply — this is the agent's actual request; alternatives never displace it.
3. BUDGET IS A CEILING, never a floor. "40-45M", "up to 45M", "max 45M", "around 40M", "budget 45jt" all mean: anything priced AT OR BELOW the top number qualifies. A cheaper property is a BETTER match, not a worse one — a client with a 45M ceiling is delighted by a 35M villa. NEVER exclude, demote, or apologise for a property because it is "under budget", and never label a price as "under budget" / "below the range" — just state the monthly rate; the agent can see it is within their ceiling. Only a price ABOVE the ceiling is a budget miss; if it is within ~15% over, you may add it AFTER the in-budget options as a clearly-framed near-miss ("a bit above budget at 49jt, but..."). Rates are often negotiable, so near-budget options are worth surfacing — but only after the in-budget matches, never instead of them.
4. BEDROOMS: "N bedrooms minimum" / "at least N" / "N+" / "N or more" means N AND larger all qualify — list exact-N first, then larger sizes, each labeled with its actual count. A plain "N bedrooms" means list every exact-N property FIRST (rule 1 scan — do not skip any; a 2BR request must surface every 2BR in the portfolio), and only after those (or when none exist, saying so plainly) offer other sizes, always labeled. Bedroom count is a hard criterion; bathroom count, when stated, works the same way.
5. PROPERTY TYPE is hard: "villa" excludes apartments and townhouses unless you say so explicitly ("not a villa, but..."). Never relabel an apartment as a villa.
6. AREA: match on the area/location fields in the data. If the agent names a micro-zone (specific streets, "south of Raya Canggu", "walking distance to X beach"), you can only confirm the neighbourhood (Pererenan, Canggu, Berawa, Buduk...), not the street — say "in Pererenan" and share the map pin rather than claiming a villa sits inside their exact pocket. If nothing is in the named area, offer the nearest neighbourhoods and say plainly that they are outside the requested zone.
   NEIGHBOURHOOD GUIDE (west to east along the coast): Cemagi — Pererenan — Canggu (its beach-side pockets are Padang Linjong, Batu Bolong, Nelayan/Echo Beach) — Berawa — Umalas / Kerobokan — Seminyak. Buduk and Tumbak Bayuh are inland, roughly 5-10 minutes north of Pererenan. "Kuta Utara" is the district name that covers Canggu, Berawa and Umalas — an area listed only as "Kuta Utara" is somewhere in that district, so treat it as a possible match and point to the map pin. A request for "Pererenan / Canggu" is satisfied by Pererenan or any Canggu pocket; Buduk and Umalas are nearby alternatives, not the same area.
7. FEATURES & POLICIES (pool, AC, enclosed/air-conditioned living room, garden, BBQ space, pets, parking, workspace...): check the data. A feature that IS in the data and contradicts the brief is a miss; a feature the data simply does not mention is UNKNOWN, not a miss — the property still counts. For the single most decision-critical unknown (pets is the classic), use ask_owner on your best candidate in the same reply and tell the agent you are checking; for the rest, say which features you can confirm and which you're confirming.
8. AVAILABILITY: if the agent did NOT name dates, a property that fits still counts as a match even if it is occupied now or booked soon — recommend it and note when it is next free (from the live availability data). When the agent DID give dates: run need_availability on your single best candidate (one per reply), and for the other candidates use the live summary (next free / long-term window) and say you will confirm exact dates. For a long lease, a property that frees up within ~2 weeks of the requested start date is still worth offering — say the date and let the agent decide; do not silently drop it.
9. OPEN-ENDED OR VAGUE BRIEFS ("any villa available?", "looking for something for a client", a long wish-list pasted in, a brief with no budget): the agent wants RECOMMENDATIONS, not a questionnaire. Never answer with only a question, and never with "nothing matches". Always: (a) lead with your best 1-3 candidates with the facts that matter (type, beds, area, monthly rate, next free), attached as cards; (b) state honestly, in one line, what in the brief you could NOT match; (c) at most ONE clarifying question, and only if it would genuinely change the shortlist (e.g. no area or no budget given). Treat a wish-list as "as many of these as possible" — nothing has to tick every box to be worth showing.
10. HONEST NO-MATCH: when nothing fits the hard criteria (type, bedrooms, budget ceiling), say so in one plain sentence, then give the one or two closest options with exactly what differs ("3BR in Padang Linjong at 35jt — in budget, but Canggu rather than Pererenan"), and ask which of the constraints has the most give.
11. Budget phrasing like "27 mil" / "27jt" / "27 juta" means IDR 27,000,000 per month.`;
}

async function loadProjects(supabaseUrl, sbHeaders) {
  const now = Date.now();
  if (_projectsCache && (now - _projectsCacheAt) < PROJECTS_CACHE_TTL_MS) {
    return _projectsCache;
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers: sbHeaders });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      _projectsCache = data;
      _projectsCacheAt = now;
      return data;
    }
  } catch (e) {
    console.warn('loadProjects failed:', e.message);
  }
  return null;
}

// Build PORTFOLIO_CONTEXT string dynamically from the projects DB rows.
// Falls back to the hardcoded version if DB is empty/unavailable.
function buildPortfolioContext(projects) {
  if (!projects || projects.length === 0) return FALLBACK_PORTFOLIO;
  const blocks = projects.map((p, i) => {
    const unitLines = (p.units || []).map(u => {
      const price = u.price_usd ? `$${(u.price_usd / 1000).toFixed(0)}K USD` : (u.price_idr ? `IDR ${(u.price_idr / 1e9).toFixed(2)}B` : 'TBC');
      const sqm = u.sqm ? `${u.sqm} sqm` : '';
      const layout = [u.beds && `${u.beds} bed`, u.baths && `${u.baths} bath`].filter(Boolean).join(', ');
      const status = u.availability && u.availability !== 'Available' ? ` -- ${u.availability.toUpperCase()}` : '';
      const notes = u.notes ? ` (${u.notes})` : '';
      return `   - ${u.code}: ${layout}${sqm ? ', ' + sqm : ''}${u.floor ? ', ' + u.floor : ''} -- ${price}${status}${notes}`;
    }).join('\n');
    const lines = [
      `${i + 1}. ${p.name.toUpperCase()}${p.area ? ' -- ' + p.area : ''}${p.full_location ? ' (' + p.full_location + ')' : ''}`,
      p.tagline ? `   ${p.tagline}` : null,
      p.property_type || p.tenure ? `   Type: ${[p.property_type, p.tenure_details || p.tenure, p.furnished].filter(Boolean).join(', ')}` : null,
      unitLines ? `   Units:\n${unitLines}` : null,
      p.construction_status || p.delivery_date ? `   Status: ${[p.construction_status, p.delivery_date].filter(Boolean).join(' -- ')}` : null,
      p.payment_plan ? `   Payment plan: ${p.payment_plan}` : null,
      p.features ? `   Features: ${p.features}` : null,
      p.roi_projections ? `   ROI: ${p.roi_projections}` : null,
      p.rental_performance ? `   Rental performance: ${p.rental_performance}` : null,
      p.distances ? `   Location: ${p.distances}` : null,
      p.maya_notes ? `   Notes for Maya: ${p.maya_notes}` : null,
      p.commission_pct ? `   Commission: ${p.commission_pct}%` : null,
      p.extended_info ? `   Extended details (from brochure):\n${p.extended_info.split('\n').map(l => '     ' + l).join('\n')}` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
  return `KAYA portfolio (current, live from DB):\n\n${blocks.join('\n\n')}`;
}

// Valid slugs Maya may reference in send_cards — every active rental.
function buildRentalSlugs(rentals) {
  return (rentals || []).map(r => r.slug).filter(Boolean);
}

// Build brochure map from projects: { slug: { url, filename, label } }
function buildBrochures(projects) {
  if (!projects || projects.length === 0) return FALLBACK_BROCHURES;
  const map = {};
  for (const p of projects) {
    if (p.brochure_url) {
      map[p.slug] = {
        url: p.brochure_url,
        filename: p.brochure_filename || `${p.name}.pdf`,
        label: p.name
      };
    }
  }
  return Object.keys(map).length > 0 ? map : FALLBACK_BROCHURES;
}

// Maya operational windows (WITA = UTC+8)
const ACTIVE_HOUR_START = 9;  // 9am WITA
const ACTIVE_HOUR_END = 21;   // 9pm WITA (inclusive of 9:xx, exclusive of 10pm)
// Spend is charged from ACTUAL token usage returned by the Anthropic API (see
// generateReply / costOfUsage), not a flat estimate, so this cap tracks real
// dollars. At ~1.5–2¢ per real reply, $2.00 leaves room for ~100+ replies/day.
// (Was briefly 0.75 while the flat estimate over-charged ~4×; raised to 2.00
// once accurate costing landed.)
const DAILY_SPEND_CAP_USD = 2.00;

// claude-sonnet-4-6 pricing (USD per token): $3/M input, $15/M output.
// Cache read ≈ $0.30/M (0.1×), cache write ≈ $3.75/M (1.25×) — both 0 today
// since Maya's calls don't set cache_control, but included so the number stays
// correct if caching is added later.
// Per-token USD rates by model: input / output / cache-read / cache-write(5m).
// Used so the daily spend cap reflects the ACTUAL model that answered — a Haiku
// reply must be charged at Haiku rates, or the cap wouldn't move even though the
// spend dropped.
const MODEL_RATES = {
  'claude-sonnet-4-6': { in: 3 / 1e6,  out: 15 / 1e6, cr: 0.30 / 1e6, cw: 3.75 / 1e6 },
  'claude-haiku-4-5':  { in: 1 / 1e6,  out: 5 / 1e6,  cr: 0.10 / 1e6, cw: 1.25 / 1e6 },
  'claude-opus-5':     { in: 5 / 1e6,  out: 25 / 1e6, cr: 0.50 / 1e6, cw: 6.25 / 1e6 },
};

// Maya's reply models. Sonnet is the default/safe choice; Haiku handles the
// clearly-trivial traffic (~3x cheaper) when MAYA_HAIKU_ROUTING is enabled.
const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5';

// Output cap for one reply hop. With the response constrained to the JSON
// contract below, a hop is just the object itself — 4000 is headroom, not a
// target. It replaces the old 800, which Maya hit on 22 Aug 2026 when she
// narrated her property-matching reasoning before the JSON: the output was cut
// mid-object, the no-JSON fallback shipped the whole monologue as the draft.
const REPLY_MAX_TOKENS = 4000;

// Burst settle: how long an inbound waits before the supersede check, so two
// messages that land seconds apart (or a run of photos, or a button tap plus
// a line of text) see each other's rows and only the newest one replies.
// Without it both invocations passed the check before either had stored its
// row — the source of every double/triple reply in the logs (22 Aug 2026).
const BURST_SETTLE_MS = 12_000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// JSON Schema for Maya's agent-reply contract, enforced server-side via
// output_config.format (structured outputs). This makes "prose before the
// JSON" impossible — the API only emits the object — so the regex-and-pray
// parse below is now a belt-and-braces check, not the primary defence.
// Every object needs additionalProperties:false and a full `required` list;
// optional fields are expressed as anyOf [null, …]. Keep in sync with the
// contract text in generateReply's systemRest and with what
// lib/crm-apply.js reads (field/value/reason; type/name/wa_num/reason/
// service_type/replace).
const nullable = (schema) => ({ anyOf: [{ type: 'null' }, schema] });
const strObj = (props, required = Object.keys(props)) => ({ type: 'object', properties: props, required, additionalProperties: false });
const MAYA_REPLY_SCHEMA = strObj({
  // Filled BEFORE reply (schema order = generation order): when the agent gave
  // client criteria, one entry per Samba rental with a fit verdict. Forces the
  // "scan every property" rule to actually happen — in free text Maya skipped
  // in-budget villas she never got round to considering (22 Aug 2026).
  match_scan: { type: 'array', items: strObj({
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['fit', 'near_miss', 'out'] },
    why: { type: 'string' },
  }) },
  action: { type: 'string', enum: ['auto', 'escalate', 'need_availability'] },
  reply: { type: 'string' },
  availability_query: nullable(strObj({ slug: { type: 'string' }, check_in: { type: 'string' }, check_out: { type: 'string' } })),
  send_doc: nullable({ type: 'string' }),
  send_cards: { type: 'array', items: { type: 'string' } },
  send_contact: nullable(strObj({ name: { type: 'string' }, phone: { type: 'string' } })),
  reply_buttons: { type: 'array', items: { type: 'string' } },
  notify_team: nullable(strObj({ to: { type: 'string', enum: ['era', 'ikiel'] }, summary: { type: 'string' }, share_agent_contact: { type: 'boolean' } })),
  ask_owner: nullable(strObj({ slug: { type: 'string' }, question: { type: 'string' } })),
  crm_updates: { type: 'array', items: strObj({
    field: { type: 'string' },
    value: { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }] },
    reason: { type: 'string' },
  }) },
  crm_actions: { type: 'array', items: strObj({
    type: { type: 'string' },
    name: { type: 'string' },
    wa_num: { type: 'string' },
    reason: { type: 'string' },
    service_type: { type: 'string' },
    replace: { type: 'boolean' },
  }) },
});
const MAYA_REPLY_FORMAT = { type: 'json_schema', schema: MAYA_REPLY_SCHEMA };

// Pull the JSON object out of a model turn. Returns { parsed } on success or
// { error } describing why there is nothing usable — a truncated output
// (stop_reason max_tokens), no object at all, or an object that won't parse.
// Callers MUST treat `error` as a generation failure (loud draft marker +
// alert), never fall back to shipping the raw text: that is exactly how a
// 700-word internal monologue once landed in an agent's draft box.
function parseReplyJson(data) {
  const raw = (data.content?.[0]?.text || '').trim();
  if (data.stop_reason === 'max_tokens') {
    return { error: `output truncated at max_tokens (${raw.length} chars)`, raw };
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: `no JSON object in output: "${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}"`, raw };
  try {
    return { parsed: JSON.parse(m[0]), raw };
  } catch (e) {
    return { error: `malformed JSON (${e.message})`, raw };
  }
}

// Conservative router: default to Sonnet, drop to Haiku ONLY for short,
// single-intent, low-stakes messages (greetings/acks, commission questions,
// brochure requests, photo/card requests). Anything with a hint of substance —
// availability/dates, recommendations, contact/viewing requests, negotiation,
// complaints, an image, a first-ever message, or length/multi-question — stays
// on Sonnet. Off unless MAYA_HAIKU_ROUTING === '1', so rollout is opt-in and the
// weekly Opus review (which audits the split) has data before we trust it.
function pickReplyModel(text, { hasImage = false, firstContact = false } = {}) {
  if (process.env.MAYA_HAIKU_ROUTING !== '1') return SONNET_MODEL;
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (hasImage || firstContact) return SONNET_MODEL;
  if (t.length > 120) return SONNET_MODEL;                    // detailed / multi-part
  if ((t.match(/\?/g) || []).length > 1) return SONNET_MODEL; // more than one question
  const forceSonnet = /(availab|free\b|dates?|check.?in|check.?out|\bwhen\b|next (week|month)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\b\d{1,2}[\/\-.]\d{1,2}|recommend|suggest|looking for|options|what.*(have|do you)|who (do i|to|should i)|contact|arrange|viewing|visit|\bbook|negoti|discount|lower|cheaper|complain|refund|deposit|legal|contract|talk to|speak to|ikiel)/i;
  if (forceSonnet.test(low)) return SONNET_MODEL;
  const haikuOk =
    /^(hi|hey|hello|halo|hai|gm|good (morning|afternoon|evening)|thanks?|thank you|ok(ay)?|noted|got it|sure|great|cheers|bye|👍|🙏|selamat|makasih|terima kasih)\b/i.test(low)
    || /commission|your cut|the split|how much do you (take|charge)/i.test(low)
    || /brochure|pdf|info ?pack|catalogue?|documents?/i.test(low)
    || /photos?|pictures?|images?|foto/i.test(low);
  return haikuOk ? HAIKU_MODEL : SONNET_MODEL;
}

// Fallback per-reply charge if the API response carries no usage block (e.g.
// an HTTP error before token accounting). Deliberately conservative.
const FALLBACK_COST_PER_REPLY_USD = 0.02;

// Real dollar cost of one Anthropic `usage` object.
function costOfUsage(u, model = SONNET_MODEL) {
  if (!u) return 0;
  const r = MODEL_RATES[model] || MODEL_RATES[SONNET_MODEL];
  return (u.input_tokens || 0) * r.in
    + (u.output_tokens || 0) * r.out
    + (u.cache_read_input_tokens || 0) * r.cr
    + (u.cache_creation_input_tokens || 0) * r.cw;
}

// Raw body for signature verification. Vercel's Node helper parses JSON
// bodies before we see them; with the parser disabled (config below) we read
// the stream ourselves. If a runtime still hands us a parsed body, fall back
// to it — the signature check is then skipped with a warning rather than
// breaking inbound delivery.
// The raw request bytes come from the Web-standard adapter at the bottom of
// this file (request.text()). Vercel's Node helpers buffer and parse the body
// before a (req, res) handler runs, so there is no other way to get the
// exact bytes Meta signed.
async function readRawBody(req) {
  return req.rawBody != null ? Buffer.from(req.rawBody) : null;
}
function signatureValid(raw, header, secret) {
  const sig = String(header || '');
  if (!sig.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sig.slice(7)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function nodeHandler(req, res) {
  const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const WA_TOKEN = process.env.META_WA_TOKEN;
  const WA_PHONE_ID = process.env.META_WA_PHONE_ID;

  // GET — Meta webhook verification handshake
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Optional hardening: when WEBHOOK_SHARED_SECRET is set, inbound POSTs must
  // carry ?token=<secret> (configure the webhook URL in Meta Business Manager
  // as .../api/whatsapp-webhook?token=...). Unset = no check, so deploys stay
  // backward compatible until the env var + Meta URL are updated together.
  const WEBHOOK_SECRET = process.env.WEBHOOK_SHARED_SECRET;
  if (WEBHOOK_SECRET && req.query?.token !== WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Meta signs every delivery with X-Hub-Signature-256 (HMAC-SHA256 of the
  // raw body with the app secret). With META_APP_SECRET set, anything that
  // doesn't verify is dropped — a forged POST could otherwise make Maya
  // reply to a real agent, ping Era, and spend the Claude budget.
  let body;
  try {
    const raw = await readRawBody(req);
    const APP_SECRET = process.env.META_APP_SECRET;
    if (APP_SECRET) {
      if (!raw) console.warn('webhook: raw body unavailable, signature check skipped');
      else if (!signatureValid(raw, req.headers['x-hub-signature-256'], APP_SECRET)) {
        return res.status(403).json({ error: 'Bad signature' });
      }
    }
    body = raw ? JSON.parse(raw.toString('utf8') || '{}') : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Bad body: ' + e.message });
  }

  try {
    if (body.object !== 'whatsapp_business_account') return res.status(200).end();

    const value = body.entry?.[0]?.changes?.[0]?.value;

    // ── Delivery/read status events ───────────────────────────────
    // Meta sends these (separate from messages) as outbound messages are
    // sent → delivered → read. We PATCH the matching wa_messages row's
    // status so the inbox can show ✓ / ✓✓ / blue ticks. Status only ever
    // advances (sent < delivered < read), never regresses.
    if (Array.isArray(value?.statuses) && value.statuses.length) {
      if (SUPABASE_URL && SUPABASE_KEY) {
        const sh = {
          'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        };
        const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
        await Promise.all(value.statuses.map(async st => {
          if (!st.id || !st.status) return;
          // Only advance forward — fetch current, compare rank.
          try {
            const cur = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(st.id)}&select=status`, { headers: sh });
            const curStatus = (await cur.json())?.[0]?.status;
            if (curStatus && curStatus !== 'failed' && (RANK[st.status] || 0) <= (RANK[curStatus] || 0)) return;
          } catch (_) {}
          // Keep Meta's failure reason — without it every failed broadcast is
          // undiagnosable after the fact (Jul 2026: 172 failures, zero codes).
          const errInfo = st.status === 'failed' && Array.isArray(st.errors) && st.errors.length
            ? st.errors.map(e => [e.code, e.title || e.message, e.error_data?.details].filter(Boolean).join(' — ')).join('; ').slice(0, 400)
            : null;
          await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(st.id)}`, {
            method: 'PATCH', headers: sh, body: JSON.stringify({ status: st.status, ...(errInfo ? { error: errInfo } : {}) })
          }).catch(() => {});
          // 131026 = recipient is not a valid WhatsApp user. If this contact has
          // never once had a message delivered, the number is dead — flag it so
          // every broadcast loop skips it from now on (an inbound message from
          // the number clears the flag automatically in the main handler).
          if (errInfo && /\b131026\b/.test(errInfo) && st.recipient_id) {
            try {
              const num = String(st.recipient_id).replace(/\D/g, '');
              const okRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_num=eq.${num}&status=in.(delivered,read)&select=id&limit=1`, { headers: sh });
              const neverDelivered = !((await okRes.json())?.length);
              // …or the number HAS delivered before but the last two sends both
              // failed undeliverable — a contact that went dead later (one
              // agent took eleven consecutive failures before anyone noticed).
              let twoInARow = false;
              if (!neverDelivered) {
                const lastRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_num=eq.${num}&direction=eq.outbound&status=not.is.null&order=timestamp.desc&limit=2&select=status,error`, { headers: sh });
                const last = await lastRes.json();
                twoInARow = Array.isArray(last) && last.length === 2 && last.every(m => m.status === 'failed' && /\b131026\b/.test(m.error || ''));
              }
              if (neverDelivered || twoInARow) {
                await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${num}`, {
                  method: 'PATCH', headers: sh, body: JSON.stringify({ dead_number: true })
                }).catch(() => {});
              }
            } catch (_) {}
          }
          // 131049 = Meta's per-user marketing cap: this person doesn't engage
          // with marketing templates and Meta is throttling us. Retrying within
          // 24h can get us blocked for another 24h, so back off: record a cap
          // until tomorrow (settings.marketing_caps, read by every broadcast
          // loop). A third cap in a row drops them to a monthly digest.
          if (errInfo && /\b131049\b/.test(errInfo) && st.recipient_id) {
            try {
              const num = String(st.recipient_id).replace(/\D/g, '');
              const capRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.marketing_caps&select=value`, { headers: sh });
              const caps = (await capRes.json())?.[0]?.value || {};
              const prev = caps[num] || { count: 0 };
              caps[num] = { until: new Date(Date.now() + 24 * 3600e3).toISOString(), count: (prev.count || 0) + 1, last: new Date().toISOString() };
              // Prune entries older than 30 days so the blob stays small.
              const cutoff = Date.now() - 30 * 86400e3;
              for (const k of Object.keys(caps)) if (Date.parse(caps[k].last || 0) < cutoff) delete caps[k];
              await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
                method: 'POST', headers: { ...sh, Prefer: 'resolution=merge-duplicates,return=minimal' },
                body: JSON.stringify({ key: 'marketing_caps', value: caps })
              }).catch(() => {});
              if (caps[num].count >= 3) {
                await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${num}&or=(contact_frequency.is.null,contact_frequency.eq.,contact_frequency.eq.weekly)`, {
                  method: 'PATCH', headers: sh, body: JSON.stringify({ contact_frequency: 'monthly' })
                }).catch(() => {});
              }
            } catch (_) {}
          }
        }));
      }
      return res.status(200).end();
    }

    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).end(); // not a message or status we handle

    const fromNum = msg.from;
    const waMessageId = msg.id;
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

    // ── Extract content from ANY message type ─────────────────────
    // WhatsApp delivers text, image, document, audio, video, sticker,
    // location, contact, and reaction messages. We extract a readable
    // content string + a media reference (if applicable) so the inbox
    // shows the actual message instead of a blank row.
    const extracted = extractInboundContent(msg);
    // Repair broken emoji (unpaired UTF-16 surrogates) right at ingestion so
    // bad characters never reach the DB or the model.
    let text = wellFormedStr(extracted.textForClaude);   // what Maya sees as the inbound prompt
    let dbContent = wellFormedStr(extracted.dbContent);  // what gets stored in wa_messages.content
    const mediaType = extracted.mediaType;    // 'image' | 'document' | 'audio' | etc, or null
    const mediaId = extracted.mediaId;        // WhatsApp media id, fetched on demand by /api/wa-media
    const reactionTarget = extracted.reactionTarget; // for reactions, the original message_id
    const reactionEmoji = extracted.reactionEmoji;

    // Mark the inbound as read + show typing indicator immediately. This gives
    // the agent the "blue ticks" + a brief "Maya is typing..." while we
    // generate the reply, making the auto-response feel attentive rather than
    // robotic. Fire-and-forget so it never blocks the rest of the webhook.
    if (WA_TOKEN && WA_PHONE_ID && waMessageId) {
      markAsReadWithTyping(WA_PHONE_ID, WA_TOKEN, waMessageId).catch(() => {});
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).end();

    const sbHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };

    // ── REDELIVERY GUARD ──────────────────────────────────────────
    // Meta delivers webhooks at-least-once: when we don't 200 fast enough
    // (reply generation runs ~20s before this handler returns), the SAME
    // message is redelivered with the SAME wamid — without this check it
    // gets stored and answered again (up to 7× observed). The supersede
    // checks can't catch it: they only tie-break between DIFFERENT wamids.
    // If this wamid is already stored, a previous invocation owns it.
    if (waMessageId) {
      try {
        const dupRes = await fetch(
          `${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}&select=id&limit=1`,
          { headers: sbHeaders }
        );
        if ((await dupRes.json())?.length) return res.status(200).end();
      } catch (_) {} // guard is best-effort — never block a real message
    }

    // ── TEAM ALERT FLUSH ──────────────────────────────────────────
    // When Ikiel or Era replies (typically "OK" to the maya_team_alert
    // template), deliver every queued alert detail — full summary plus the
    // agent/guest contact card — inside the now-open 24h window. Their
    // message is consumed by the flush; normal agent handling is skipped
    // for this turn so Maya never chats back at her own team ping.
    // Shared handles for the relay module (same Supabase + WhatsApp creds).
    const relayDb = { SUPABASE_URL, sbHeaders };
    const relayWa = { phoneId: WA_PHONE_ID, token: WA_TOKEN };

    if (TEAM_NUMS.has(fromNum)) {
      const flushed = await flushTeamAlerts(SUPABASE_URL, sbHeaders, WA_PHONE_ID, WA_TOKEN, fromNum);
      // Era is the "enquire with" contact for our directly-managed villas, so
      // she gets relayed agent questions like any owner: her reply opens the
      // window (delivering anything queued) and may itself be an answer.
      const asked = await flushRelayQuestions(relayDb, relayWa, fromNum);
      const answered = await handleRelayReply({
        db: relayDb, wa: relayWa, fromNum, text, apiKey: ANTHROPIC_KEY,
      });
      if (flushed || answered || (asked && isBareAck(text))) return res.status(200).end();
      // Anything else from a team number is logged and left for a human. Era
      // is never an agent lead and never an owner — the portal's owner sync
      // can put her number on an owners row (Hostex overrides list her as
      // the contact), and without this guard her free-text replies would be
      // answered by owner-mode Maya as if she were listing a villa.
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({ agent_id: null, wa_num: fromNum, direction: 'inbound', content: text, wa_message_id: waMessageId, timestamp: new Date().toISOString(), source: 'webhook' }),
      }).catch(() => {});
      return res.status(200).end();
    }

    // Find matching agent
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${fromNum}&select=*`,
      { headers: sbHeaders }
    );
    let agent = (await agentRes.json())?.[0];

    // Find matching owner (villa owner/manager, by listing WhatsApp contact).
    // Gated by OWNERS_ENABLED so this stays a no-op until the owners-table
    // migration has been applied — tagging a column that doesn't exist yet
    // would break message storage on the live line. When on, we only TAG the
    // message with owner_id; agent routing and creation are unchanged (the
    // behavioural owner-mode split rides on the owner inbox, built next).
    let owner = null;
    if (process.env.OWNERS_ENABLED === '1') {
      try {
        const ownerRes = await fetch(
          `${SUPABASE_URL}/rest/v1/owners?wa_num=eq.${fromNum}&select=*&limit=1`,
          { headers: sbHeaders }
        );
        owner = (await ownerRes.json())?.[0] || null;
      } catch { owner = null; }
    }

    // Handle reactions inline — they're not standalone messages, they
    // annotate a previous outbound. Patch the original row's reactions
    // field instead of storing a new message.
    if (reactionTarget && reactionEmoji !== undefined) {
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(reactionTarget)}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ reaction: reactionEmoji || null }),
      }).catch(() => {});
      return res.status(200).end();
    }

    // VOICE NOTES — transcribe (Groq/OpenAI/Gemini, whichever key is configured)
    // so Maya answers the actual question and the inbox shows what was said.
    // No key or a failed transcription keeps the graceful "could you send that
    // as text?" fallback prompt from extractInboundContent.
    if (mediaType === 'audio' && mediaId && WA_TOKEN) {
      const transcript = await transcribeWaAudio(mediaId, WA_TOKEN).catch(() => null);
      if (transcript) {
        dbContent = `[Voice note] "${transcript.slice(0, 1500)}"`;
        text = `[The agent sent a voice note; its transcript follows — reply to its content normally.] "${transcript.slice(0, 1500)}"`;
      }
    }

    // Archive inbound documents to our own storage so they stay openable past
    // Meta's ~30-day media window (agreements, PDFs, etc.). On success we store
    // the permanent public URL in media_id; the inbox renders a URL media_id
    // directly, and falls back to the Meta-id proxy if archiving failed.
    let storedMediaId = mediaId;
    if (mediaType === 'document' && mediaId) {
      const docName = (String(dbContent || '').match(/^\[Document:\s*([^\]]+)\]/) || [])[1] || 'document';
      const archived = await archiveInboundDoc(SUPABASE_URL, SUPABASE_KEY, mediaId, docName, WA_TOKEN);
      if (archived) storedMediaId = archived;
    }

    // Store inbound message — content is human-readable summary, media
    // identifiers go in dedicated columns for the inbox to render inline.
    await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent ? agent.id : null, wa_num: fromNum, direction: 'inbound',
        content: dbContent, wa_message_id: waMessageId, timestamp, source: 'webhook',
        media_type: mediaType || null, media_id: storedMediaId || null,
        reply_to: msg.context?.id || null,   // id of the message this one quotes, if any
        ...(owner ? { owner_id: owner.id } : {}),  // tag owner threads (no-op unless OWNERS_ENABLED)
      })
    });

    // Push a notification to the Maya chat PWA (fire-and-forget).
    sendPushNotifications(SUPABASE_URL, sbHeaders, {
      title: agent?.name || agent?.agency || (owner?.name ? `${owner.name} (owner)` : '+' + fromNum),
      body: (dbContent || text || 'New message').slice(0, 160),
      agentId: agent ? agent.id : null,
      badgeCount: (agent?.unread_count || 0) + 1,
    }).catch(() => {});

    // ── RELAY: THE SENDER IS ANSWERING ───────────────────────────────
    // Any "enquire with" contact — an owner, a manager, anyone holding an open
    // question — gets their reply matched against it first. Their inbound also
    // opens their 24h window, so anything that was waiting on a template goes
    // out now. A captured answer consumes the message: no chat reply follows,
    // because the thank-you and the hand-back to the agent already happened.
    {
      const asked = await flushRelayQuestions(relayDb, relayWa, fromNum);
      const answered = await handleRelayReply({
        db: relayDb, wa: relayWa, fromNum, text, apiKey: ANTHROPIC_KEY,
      });
      if (answered) {
        if (owner) {
          await fetch(`${SUPABASE_URL}/rest/v1/owners?id=eq.${owner.id}`, {
            method: 'PATCH', headers: sbHeaders,
            body: JSON.stringify({ last_inbound_at: timestamp }),
          }).catch(() => {});
        }
        return res.status(200).end();
      }
      // A bare "OK" was just the window opening, so the question we sent is
      // the whole turn. Anything more substantial is a real message — let it
      // through to normal handling so their own request still gets answered.
      if (asked && isBareAck(text)) return res.status(200).end();
    }

    // ── RELAY: THE SENDER IS OWED AN ANSWER ──────────────────────────
    // An agent whose question came back while their window was shut got the
    // maya_answer_ready template; this message re-opens the window, so the
    // answer goes out now. When that message is nothing but the "OK" the
    // template asked for, the answer IS the reply — Maya doesn't chat on top.
    if (agent) {
      const delivered = await deliverAnswers(relayDb, relayWa, fromNum);
      if (delivered && isBareAck(text)) {
        await patchAgent(SUPABASE_URL, sbHeaders, agent.id, {
          last_inbound_at: timestamp, unread_count: 0, dead_number: false,
        });
        return res.status(200).end();
      }
    }

    // ── OWNER-MODE BRANCH ────────────────────────────────────────────
    // A villa owner/manager (matched by their listing's WhatsApp contact) who
    // is NOT also an agent: Maya handles this in owner-mode and we return,
    // leaving the entire agent pipeline below untouched. Someone who is both an
    // agent and an owner stays in the agent flow (zero regression) — dual-role
    // routing is refined later. `owner` is only ever set when OWNERS_ENABLED is
    // on, so this whole branch is dormant until then.
    // Owner mode for numbers with no agent row — or an agent row that turned
    // out to be an owner (crm action convert_to_owner sets role 'owner').
    if (owner && (!agent || agent.campaign_engagement?.role === 'owner')) {
      try {
        await handleOwnerConversation({
          SUPABASE_URL, sbHeaders, owner, fromNum,
          inbound: text, timestamp, waMessageId, WA_TOKEN, WA_PHONE_ID, ANTHROPIC_KEY,
          mediaType, mediaId,
        });
      } catch (e) {
        console.error('owner-mode error:', e.message);
      }
      return res.status(200).end();
    }

    if (!agent) {
      // Unknown sender whose FIRST message is the portal's "List with Maya"
      // prefill (or an obvious listing-intent line): this is a villa OWNER,
      // not an agent lead. Create an owners row and hand the conversation to
      // owner-mode onboarding — otherwise they'd be auto-created as an agent
      // and get the agent welcome, a hard-to-recover misroute.
      if (process.env.OWNERS_ENABLED === '1'
          && /list (?:my|our) (?:villa|property|home)|memasarkan villa saya|listing villa saya/i.test(text || '')) {
        try {
          const oRes = await fetch(`${SUPABASE_URL}/rest/v1/owners`, {
            method: 'POST', headers: { ...sbHeaders, Prefer: 'return=representation' },
            body: JSON.stringify({
              wa_num: fromNum, name: null, opt_in: true,
              onboarding_status: 'in_conversation',
              consent_note: 'Self-initiated via the portal "List with Maya" WhatsApp button',
              promo_code: 'FOUNDING25',
            }),
          });
          const newOwner = (await oRes.json().catch(() => []))?.[0];
          if (newOwner && newOwner.id != null) {
            if (waMessageId) {
              await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}`, {
                method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ owner_id: newOwner.id }),
              }).catch(() => {});
            }
            await handleOwnerConversation({
              SUPABASE_URL, sbHeaders, owner: newOwner, fromNum,
              inbound: text, timestamp, WA_TOKEN, WA_PHONE_ID, ANTHROPIC_KEY,
              mediaType, mediaId,
            });
            return res.status(200).end();
          }
        } catch (e) {
          console.error('owner self-signup routing failed, falling through to agent flow:', e.message);
        }
      }
      // Unknown sender = a brand-new agent's very first message. This used to
      // be a dead end (message logged with no agent_id, so invisible in the
      // inbox, and no reply). Instead: create a lead record so the thread
      // appears in the inbox, attach the message we just stored, and — when
      // Maya auto-replies are on — send a one-time capability intro so new
      // agents immediately learn what she can do.
      try {
        const firstDateStr = new Date(timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
        // Use the self-healing createAgentRow (reads the live schema, fills any
        // NOT-NULL column we didn't set) instead of a raw insert. A raw insert
        // that hit an unanticipated NOT-NULL column used to fail silently here,
        // leaving the just-stored inbound message orphaned (agent_id null →
        // invisible in the inbox) even though a push had already fired. That is
        // exactly how non-Indonesian guests' booking messages went missing.
        const createRes = await createAgentRow(SUPABASE_URL, sbHeaders, {
          name: '+' + fromNum, wa_num: fromNum,
          unread_count: 1, last_inbound_at: timestamp,
          conversation_summary: `[${firstDateStr}] New contact (self-introduced via WhatsApp): ${(text || dbContent || '').slice(0, 120)}`,
          conversation_history: { first_contact: firstDateStr, last_contact: firstDateStr, total_messages: 1 },
        });
        if (!createRes.ok) console.warn('new-contact create failed:', createRes.error);
        const newAgent = createRes.row;
        if (newAgent && newAgent.id != null) {
          if (waMessageId) {
            await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}`, {
              method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ agent_id: newAgent.id }),
            }).catch(() => {});
          }
          // A substantive first message (a real question or request, not just
          // "hi") flows into the full Maya pipeline below so the sender gets an
          // actual answer. The static capability intro used to swallow real
          // asks — e.g. an urgent Monday-availability question answered with a
          // generic welcome (1 Aug 2026). Trivial openers keep the intro.
          const isSubstantive = ((text || '').trim().length >= 25 || /\?/.test(text || ''))
            && mediaType !== 'audio'; // untranscribed voice keeps the old flow
          if (isSubstantive) {
            // The creation row already counted this message as unread=1; zero it
            // here so the standard +1 patch below lands back on 1, not 2.
            agent = { ...newAgent, unread_count: 0 };
          } else {
            let welcomeMode = 'draft';
            try {
              const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
              welcomeMode = (await sRes.json())?.[0]?.value?.mode || 'draft';
            } catch (e) { /* stay conservative: no auto-welcome */ }
            // No hours gate: this fires only when an agent messages Maya first, and
            // agent-initiated contact is answered any time (night owls included).
            if (welcomeMode === 'autopilot' || welcomeMode === 'hybrid') {
              const welcome = "Hi! I'm Maya, listings coordinator for KAYA Developments and Samba Realty. I can send project info and brochures, check live villa availability for your clients, and walk you through commissions — 5% on KAYA sales, 10% on Samba monthly rentals (already built into the portal price you quote). Ikiel sees every message and jumps in personally when needed. What can I help you with?";
              const welcomeMid = await sendText(WA_PHONE_ID, WA_TOKEN, fromNum, welcome);
              await logOutbound(SUPABASE_URL, sbHeaders, newAgent.id, fromNum, welcome, welcomeMid);
            }
          }
        }
      } catch (e) { console.warn('new-agent welcome failed:', e.message); }
      if (!agent) return res.status(200).end();
    }

    // Update conversation summary, history, inbox state
    const dateStr = new Date(timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const newLine = `\n[${dateStr}] ${agent.name || 'Agent'}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
    const updatedSummary = ((agent.conversation_summary || '') + newLine).slice(-4000);
    const updatedHistory = {
      ...(agent.conversation_history || {}),
      last_contact: dateStr,
      total_messages: ((agent.conversation_history || {}).total_messages || 0) + 1,
      first_contact: (agent.conversation_history || {}).first_contact || dateStr
    };

    // Determine automation mode (per-agent override beats global)
    // Special override value 'paused' = Ikiel is handling this thread manually, Maya stays silent.
    let globalMode = 'draft';
    try {
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
      const sRow = (await sRes.json())?.[0];
      if (sRow?.value?.mode) globalMode = sRow.value.mode;
    } catch (e) { /* default */ }

    const override = agent.automation_override;
    const mode = override === 'paused' ? 'paused' : (override || globalMode);

    // Forward to Telegram (fire and forget — never block the webhook on it)
    forwardInbound(agent, text, mode).catch(() => {});

    const patch = {
      conversation_summary: updatedSummary,
      conversation_history: updatedHistory,
      last_inbound_at: timestamp,
      unread_count: (agent.unread_count || 0) + 1
    };

    // A message FROM a number proves it's alive — clear any dead-number flag
    // (set by the 131026 auto-marker or the Jul 2026 cleanup) so broadcasts
    // resume for this agent.
    if (agent.dead_number) patch.dead_number = false;


    // STOP CAMPAIGN SEQUENCES — any inbound message stops ALL active sequences
    // for this agent (across both KAYA and Samba pipelines). The conversation
    // is now live; proactive follow-ups should pause regardless of pipeline.
    const stopResult = stopAllPending(agent.campaign_engagement, timestamp);
    if (stopResult.changed) {
      patch.campaign_engagement = stopResult.value;
    }

    // Cold contact answering their first-contact intro → real opt-in. The
    // intro sweep leaves them at 'intro_sent', which deliberately keeps them
    // out of the daily availability stream; a reply is the signal that they
    // want it. Must run AFTER stopAllPending, which rebuilds
    // campaign_engagement from the stored row and would otherwise discard
    // this. An explicit STOP is caught immediately below and overwrites it
    // with 'unsubscribed', so a "stop" can never be read as consent.
    const introStatus = String(agent.campaign_engagement?.samba?.status || '').toLowerCase().trim();
    // An agency's auto-responder ("Thank you for contacting BAM…") is not a
    // person saying yes — it used to promote the contact to opted_in and
    // start the daily stream on the strength of a bot reply.
    if (introStatus === 'intro_sent' && !AUTO_REPLY_RE.test(String(text || ''))) {
      const base = patch.campaign_engagement || agent.campaign_engagement || {};
      patch.campaign_engagement = {
        ...base,
        samba: {
          ...(base.samba || agent.campaign_engagement.samba || {}),
          status: 'opted_in',
          opted_in_at: timestamp,
          opted_in_via: 'intro_reply',
        },
      };
    }

    // OPT-OUT DETECTION — intercept stop/unsubscribe before Maya sees the message.
    // Sets samba_alerts_opt_out, marks samba engagement as 'unsubscribed', sends
    // a brief confirmation, and short-circuits (no Claude call).
    // Exact keywords, plus the natural-language refusals the logs showed being
    // ignored for weeks ("Not interested bye" → 27 more broadcasts; "please
    // dont send me daily updates … or i will block this number" → 3 more).
    // Natural-language matches only count on short messages, so "not
    // interested in Saturno, but do you have a 2BR?" still reaches Maya.
    const OPT_OUT_RE = /^(stop|unsubscribe|please stop|remove me|don'?t contact|opt out|berhenti)$/i;
    const OPT_OUT_NL_RE = /\b(not interested|no thanks?|no thank you|don'?t (send|message|text|contact)|stop (sending|messaging|texting)|please stop|remove (me|us|my (number|contact))|unsubscribe|take me off|leave me alone|wrong (person|number)|block (this|your) number|tidak tertarik|ga tertarik|gak tertarik|jangan (kirim|hubungi)|hapus (nomor|kontak)|salah (nomor|orang)|berhenti kirim)\b/i;
    const trimmed = String(text || '').trim();
    // A refusal that continues into a question or a "but" is a conversation,
    // not an opt-out — leave it to Maya.
    const OPT_OUT_NOT_RE = /\?|\b(but|tapi|however|do you have|ada (villa|unit|yang)|looking for|cari|instead)\b/i;
    const optOutHit = trimmed && (OPT_OUT_RE.test(trimmed) || (trimmed.length <= 160 && OPT_OUT_NL_RE.test(trimmed) && !OPT_OUT_NOT_RE.test(trimmed)));
    if (optOutHit) {
      patch.samba_alerts_opt_out = true;
      const eng = { ...(agent.campaign_engagement || {}) };
      if (eng.samba) {
        eng.samba = { ...eng.samba, status: 'unsubscribed', status_updated_at: timestamp };
      }
      patch.campaign_engagement = eng;
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);

      const bahasa = /\b(tidak|ga|gak|jangan|hapus|salah|berhenti|nomor)\b/i.test(trimmed);
      const confirmText = bahasa
        ? 'Siap, noted — nomor ini sudah saya hapus dari update Samba. Kalau suatu saat mau menerima info lagi, tinggal kabari saya ya 🙏'
        : 'Noted — you\'ve been removed from availability updates. If you ever want to re-subscribe, just let me know.';
      if (WA_TOKEN && WA_PHONE_ID) {
        const confirmMid = await sendText(WA_PHONE_ID, WA_TOKEN, fromNum, confirmText);
        await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, confirmText, confirmMid);
      }

      // Audit trail in maya_updates
      await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agent.id,
          field: 'samba_alerts_opt_out',
          new_value: 'true',
          reason: OPT_OUT_RE.test(trimmed) ? 'Agent sent opt-out keyword' : 'Agent declined in natural language',
          evidence: text.trim().slice(0, 200),
          by_maya: false,
          created_at: new Date().toISOString(),
        })
      }).catch(e => console.warn('maya_updates opt-out log failed:', e.message));

      return res.status(200).end();
    }

    // PREFERENCE BUTTONS — one-tap cadence control from a template quick-reply.
    // Maps the button payload straight to contact_frequency so agents self-serve
    // fewer messages instead of blocking. Acks + short-circuits (no Claude call).
    const PREF_MAP = {
      PREF_WEEKLY:  { freq: 'weekly',  ack: 'Perfect — I\'ll send just the weekly availability summary from now on. Reply anytime if you want more.' },
      PREF_MONTHLY: { freq: 'monthly', ack: 'Done — I\'ll keep it to a monthly summary. Reply anytime to change that.' },
      PREF_PAUSE:   { freq: 'paused',  ack: 'No problem — I\'ve paused availability updates. Just message me whenever you\'d like them back on.' },
    };
    // Match the explicit payload first; fall back to the visible label ONLY for
    // template quick-replies (whose payload defaults to the button text). Maya's
    // in-conversation buttons carry MAYA_QR_* ids — their labels must never be
    // pattern-matched into a frequency change ("Check other dates" ≠ weekly!);
    // they flow to Maya as a normal inbound message instead.
    const btnLabel = (extracted.textForClaude || '').toLowerCase();
    const isTemplateDefaultPayload = extracted.buttonPayload === extracted.textForClaude;
    const pref = (extracted.buttonPayload && PREF_MAP[extracted.buttonPayload])
      || (isTemplateDefaultPayload && (/week/.test(btnLabel) ? PREF_MAP.PREF_WEEKLY
        : /month/.test(btnLabel) ? PREF_MAP.PREF_MONTHLY
        : /pause|less|fewer/.test(btnLabel) ? PREF_MAP.PREF_PAUSE : null));
    if (pref) {
      patch.contact_frequency = pref.freq;
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      if (WA_TOKEN && WA_PHONE_ID) {
        const prefMid = await sendText(WA_PHONE_ID, WA_TOKEN, fromNum, pref.ack);
        await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, pref.ack, prefMid);
      }
      await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agent.id, field: 'contact_frequency', new_value: pref.freq,
          reason: 'Agent tapped a preference button', evidence: extracted.buttonPayload,
          by_maya: false, created_at: new Date().toISOString(),
        })
      }).catch(e => console.warn('maya_updates preference log failed:', e.message));
      return res.status(200).end();
    }

    // PAUSED — Ikiel is handling this thread, Maya stays silent. Just log + mark unread.
    if (mode === 'paused') {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // OFF — log only
    if (mode === 'off' || !ANTHROPIC_KEY) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // TEST CONTACTS — bypass hours gate and spend cap so iteration works any time.
    // Real agents still get the production guardrails.
    const isTestContact = agent.is_test === true;

    // NO HOURS GATE ON INBOUND — agent-initiated messages are answered any time
    // of day (night owls send real questions late; silence loses them). The
    // 9am-9pm WITA window only governs Maya-INITIATED outreach: the onboarding
    // welcome (deferred in quick_add_agent) and the scheduled follow-ups/broadcast
    // in cron-followups. Inbound now flows straight to the normal mode-based
    // handling below (autopilot sends, draft/hybrid still just drafts), with the
    // spend cap and all other guardrails intact.

    // SPEND CAP CHECK — pause Maya for the day if over $2 daily Claude spend
    if (!isTestContact) {
      const todaySpend = await getTodaySpend(SUPABASE_URL, sbHeaders);
      if (todaySpend >= DAILY_SPEND_CAP_USD) {
        // Over cap: log + escalate as draft (no Claude call)
        patch.suggested_reply = '[Maya is paused: daily spend cap reached. Please reply manually.]';
        await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
        return res.status(200).end();
      }
    }

    // SUPERSEDE CHECK #1 (pre-generation) — if the agent already sent a NEWER
    // message (rapid-fire double text), skip this one entirely: the invocation
    // handling the newest message sees the full thread and replies once.
    // Fixes the duplicate-reply bug (e.g. Maya answering the same question
    // twice when an agent sends two messages seconds apart). Also saves the
    // Claude call for the superseded message.
    await sleep(BURST_SETTLE_MS);
    if (await hasNewerInbound(SUPABASE_URL, sbHeaders, agent.id, timestamp, waMessageId)) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // Generate a reply with Claude — load live project + rental data from DB first
    const { liveContext, liveBrochures, rentalsContext, availabilityContext, rentalSlugs, recentThread, campaignContext, playbookBlock, digest }
      = await assembleAgentReplyContext(SUPABASE_URL, sbHeaders, agent);
    // Vision: when the agent sent an image, fetch its bytes so Maya can
    // actually look at it (listing screenshots, property photos, documents
    // photographed by agents). Falls back to the "couldn't open it" prompt.
    let inboundText = text, inboundImage = null;
    if (mediaType === 'image' && mediaId) {
      inboundImage = await fetchWaMediaBase64(mediaId, WA_TOKEN).catch(() => null);
      if (inboundImage) {
        inboundText = (extracted.caption ? `Caption from the agent: "${extracted.caption}". ` : '')
          + '[The agent sent the attached image — look at it and respond helpfully. If it shows a property, listing screenshot, or document, address its content directly; if it is unrelated small talk (memes, greetings), respond naturally and briefly.]';
      }
    }
    const aiResult = await generateReply(ANTHROPIC_KEY, agent, inboundText, mode, liveContext, liveBrochures, recentThread, rentalsContext, campaignContext, rentalSlugs, availabilityContext, inboundImage, playbookBlock);

    // Increment today's spend by the ACTUAL token cost of the Claude call(s),
    // computed from the Anthropic usage block (a date-range availability lookup
    // adds an extra turn, already summed into cost_usd). Falls back to a flat
    // per-call charge only if usage accounting was unavailable.
    const spendDelta = typeof aiResult.cost_usd === 'number'
      ? aiResult.cost_usd
      : FALLBACK_COST_PER_REPLY_USD * (aiResult.llm_calls || 1);
    await incrementTodaySpend(SUPABASE_URL, sbHeaders, spendDelta);

    // GENERATION FAILURE — the Claude call itself errored (credits, auth,
    // overload). Never let this dissolve into a silent empty draft (the
    // 21 Jul 2026 credit-exhaustion outage): store a loud marker where the
    // draft would be and alert Ikiel (push + Telegram, throttled), then stop.
    if (aiResult.error) {
      patch.suggested_reply = `[Maya failed: ${aiResult.error} — reply manually.]`;
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      await alertGenerationFailure(SUPABASE_URL, sbHeaders, agent, aiResult.error);
      return res.status(200).end();
    }

    // Apply any CRM updates Maya suggested (status changes, tags)
    // Each update is logged with evidence and a "by_maya: true" flag
    if (Array.isArray(aiResult.crm_updates) && aiResult.crm_updates.length > 0) {
      await applyCrmUpdates(SUPABASE_URL, sbHeaders, agent, aiResult.crm_updates, text);
    }
    if (Array.isArray(aiResult.crm_actions) && aiResult.crm_actions.length > 0) {
      await applyCrmActions(SUPABASE_URL, sbHeaders, agent, aiResult.crm_actions, text);
    }

    // SUPERSEDE CHECK #2 (post-generation) — a newer message may have landed
    // while Claude was generating (the common rapid-fire window). Drop this
    // reply/draft; the newer invocation covers both messages in one answer.
    // CRM updates above still applied — they were valid signals either way.
    if (await hasNewerInbound(SUPABASE_URL, sbHeaders, agent.id, timestamp, waMessageId)) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // Listing cards Maya attached to this reply. On drafts they ride along as a
    // [[send-cards:...]] suffix that the inbox strips into an attachment chip
    // and sends (via /api/whatsapp-send action 'cards') when the draft goes out.
    const cardSlugs = Array.isArray(aiResult.send_cards) ? aiResult.send_cards.filter(Boolean).slice(0, 4) : [];
    // Drafts carry their side effects as a trailing marker the consoles strip
    // into a chip and whatsapp-send executes on approval (see
    // executeReplySideEffects). Cards keep their legacy marker for older UI.
    const sideFx = {};
    if (aiResult.send_contact) sideFx.send_contact = aiResult.send_contact;
    if (aiResult.notify_team) sideFx.notify_team = aiResult.notify_team;
    if (aiResult.ask_owner) sideFx.ask_owner = aiResult.ask_owner;
    if (aiResult.send_doc) sideFx.send_doc = aiResult.send_doc;
    if (Array.isArray(aiResult.reply_buttons) && aiResult.reply_buttons.length) sideFx.reply_buttons = aiResult.reply_buttons;
    const draftCardsSuffix = (cardSlugs.length ? `\n[[send-cards:${cardSlugs.join(',')}]]` : '')
      + (Object.keys(sideFx).length ? `\n[[actions:${Buffer.from(JSON.stringify(sideFx)).toString('base64url')}]]` : '');

    if (mode === 'draft') {
      patch.suggested_reply = (aiResult.reply || '') && (aiResult.reply + draftCardsSuffix);
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID — auto-send only confident FAQ answers, else escalate
    if (mode === 'hybrid' && aiResult.action === 'escalate') {
      patch.suggested_reply = (aiResult.reply || '') && (aiResult.reply + draftCardsSuffix);
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID(auto) or AUTOPILOT — send the reply
    // Edge case: if Claude returned action: "escalate" with an empty reply (e.g. spam/harassment),
    // skip the send entirely.
    if (aiResult.action === 'escalate' && !aiResult.reply) {
      patch.suggested_reply = '[Maya escalated silently. Likely spam/harassment.]';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    if (aiResult.reply && WA_TOKEN && WA_PHONE_ID) {
      // Quick-reply buttons ride on the reply bubble when Maya offered any
      // (interactive message; falls back to plain text on any Meta rejection).
      const buttons = Array.isArray(aiResult.reply_buttons) ? aiResult.reply_buttons : [];
      // Never send the same words twice within ten minutes (a retry or a
      // second invocation that slipped past the supersede checks).
      if (await sentRecently(SUPABASE_URL, sbHeaders, fromNum, aiResult.reply, 10)) {
        console.log('duplicate reply suppressed for', fromNum);
        patch.suggested_reply = ''; patch.unread_count = 0;
        await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
        return res.status(200).end();
      }
      const replyMid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, aiResult.reply, buttons);
      const buttonsNote = buttons.length ? `\n[Buttons: ${buttons.join(' | ')}]` : '';
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, aiResult.reply + buttonsNote, replyMid, null, aiResult.model);
      // Mirror Maya's reply to Telegram so Ikiel sees the full conversation
      forwardMayaReply(agent, aiResult.reply).catch(() => {});

      await executeReplySideEffects({ SUPABASE_URL, sbHeaders, WA_PHONE_ID, WA_TOKEN, agent, toNum: fromNum, actions: aiResult, evidence: text, brochures: liveBrochures, digest });
      // Auto-sent: clear suggestion, don't mark unread
      patch.suggested_reply = '';
      patch.unread_count = 0;
    } else {
      patch.suggested_reply = (aiResult.reply || '') && (aiResult.reply + draftCardsSuffix);
    }

    await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
    return res.status(200).end();

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).end();
  }
}

// ── Helpers ──────────────────────────────────────────────

// Returns true if current time is between 9am and 9pm WITA (UTC+8).
// Extract a readable summary + media reference from any inbound WhatsApp
// message type. Returns:
//   { textForClaude, dbContent, mediaType, mediaId, reactionTarget, reactionEmoji }
// textForClaude is what we feed Maya as the inbound prompt (she shouldn't
// reply to silent reactions); dbContent is the human-readable inbox row.
function extractInboundContent(msg) {
  const out = {
    textForClaude: '', dbContent: '', mediaType: null, mediaId: null,
    reactionTarget: null, reactionEmoji: undefined,
  };
  if (msg.text?.body) {
    out.textForClaude = msg.text.body;
    out.dbContent = msg.text.body;
    return out;
  }
  if (msg.image) {
    out.mediaType = 'image';
    out.mediaId = msg.image.id || null;
    out.caption = msg.image.caption || '';
    const cap = msg.image.caption ? ` "${msg.image.caption}"` : '';
    out.dbContent = `[Image]${cap}`;
    // Fallback prompt — used only if the image bytes can't be fetched; when
    // they can, the webhook swaps in a vision prompt with the image attached.
    out.textForClaude = msg.image.caption || '[Agent sent an image — say briefly that you could not open it and offer to have Ikiel review it.]';
    return out;
  }
  if (msg.document) {
    out.mediaType = 'document';
    out.mediaId = msg.document.id || null;
    const name = msg.document.filename || 'document';
    const cap = msg.document.caption ? ` "${msg.document.caption}"` : '';
    out.dbContent = `[Document: ${name}]${cap}`;
    out.textForClaude = msg.document.caption || `[Agent sent a document: ${name}. Briefly acknowledge receipt and say you will pass it to Ikiel.]`;
    return out;
  }
  if (msg.audio || msg.voice) {
    const a = msg.audio || msg.voice;
    out.mediaType = 'audio';
    out.mediaId = a.id || null;
    out.dbContent = '[Voice note]';
    out.textForClaude = '[Agent sent a voice note. Say briefly that you cannot listen to voice notes yet and ask them to send the question as text, or offer to have Ikiel listen and reply — if they seem to prefer that, use action "escalate" so Ikiel is notified.]';
    return out;
  }
  if (msg.video) {
    out.mediaType = 'video';
    out.mediaId = msg.video.id || null;
    const cap = msg.video.caption ? ` "${msg.video.caption}"` : '';
    out.dbContent = `[Video]${cap}`;
    out.textForClaude = msg.video.caption || '[Agent sent a video. Acknowledge briefly and offer to have Ikiel review it.]';
    return out;
  }
  if (msg.sticker) {
    out.mediaType = 'sticker';
    out.mediaId = msg.sticker.id || null;
    out.dbContent = '[Sticker]';
    out.textForClaude = '[Agent sent a sticker — no need to reply unless context demands it.]';
    return out;
  }
  if (msg.location) {
    const lat = msg.location.latitude;
    const lng = msg.location.longitude;
    const nm = msg.location.name ? ` ${msg.location.name}` : '';
    out.mediaType = 'location';
    out.mediaId = `${lat},${lng}`;
    out.dbContent = `[Location${nm}: ${lat}, ${lng}]`;
    out.textForClaude = `[Agent shared a location${nm}. Acknowledge briefly.]`;
    return out;
  }
  if (msg.contacts && Array.isArray(msg.contacts)) {
    // Keep the phone numbers — before this fix only the name was stored and
    // the number was unrecoverable (see ERINA/Hikam, 3 Jul 2026).
    const cards = msg.contacts.map(c => {
      const nm = c.name?.formatted_name || 'contact';
      const phones = (c.phones || [])
        .map(p => String(p.wa_id || p.phone || '').replace(/[^\d]/g, ''))
        .filter(Boolean);
      return { nm, phones };
    });
    const label = cards.map(c => c.nm + (c.phones.length ? ' — +' + c.phones.join(', +') : ' (no number)')).join(' | ');
    out.mediaType = 'contacts';
    out.dbContent = `[Contact card: ${label}]`;
    out.textForClaude = `[Agent shared a WhatsApp contact card: ${label}. If they want this person added to updates or contacted instead of them, use the create_agent action with the exact number shown.]`;
    return out;
  }
  if (msg.reaction) {
    out.reactionTarget = msg.reaction.message_id;
    out.reactionEmoji = msg.reaction.emoji || '';
    out.dbContent = `[Reacted ${msg.reaction.emoji || '(removed)'}]`;
    return out;
  }
  // Quick-reply button tap (from a template) or interactive button reply. The
  // payload drives one-tap preference changes; text is the visible label.
  if (msg.button || msg.interactive?.button_reply) {
    const payload = msg.button?.payload || msg.interactive?.button_reply?.id || '';
    const label = msg.button?.text || msg.interactive?.button_reply?.title || payload;
    out.buttonPayload = payload;
    out.textForClaude = label;
    out.dbContent = `[Tapped: ${label}]`;
    return out;
  }
  out.dbContent = `[Unknown message type: ${msg.type}]`;
  return out;
}

function isWithinOperationalHours() {
  const nowUtc = new Date();
  // WITA = UTC+8. Convert hour by adding 8.
  const witaHour = (nowUtc.getUTCHours() + 8) % 24;
  return witaHour >= ACTIVE_HOUR_START && witaHour < ACTIVE_HOUR_END;
}

// Returns the YYYY-MM-DD date string in WITA time zone (for daily spend tracking).
function getTodayWitaDateStr() {
  const nowUtc = new Date();
  const witaTime = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
  return witaTime.toISOString().slice(0, 10);
}

async function getTodaySpend(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    const today = getTodayWitaDateStr();
    return usage[today] || 0;
  } catch (e) {
    return 0;
  }
}

async function incrementTodaySpend(url, headers, costUsd) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    const today = getTodayWitaDateStr();
    usage[today] = (usage[today] || 0) + costUsd;
    // Trim old days (keep last 30)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    Object.keys(usage).forEach(k => { if (k < cutoff) delete usage[k]; });
    await fetch(`${url}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'daily_usage', value: usage })
    });
  } catch (e) {
    console.warn('incrementTodaySpend failed:', e.message);
  }
}

// True when a DIFFERENT inbound message with a later timestamp already exists
// for this agent — i.e. the one we're processing has been superseded. On equal
// timestamps the wa_message_id string breaks the tie so exactly ONE of two
// concurrent invocations proceeds (both skipping would mean no reply at all).
async function hasNewerInbound(url, headers, agentId, ownTimestamp, ownWaMessageId) {
  try {
    const r = await fetch(`${url}/rest/v1/wa_messages?agent_id=eq.${agentId}&direction=eq.inbound&order=timestamp.desc,wa_message_id.desc&limit=1&select=wa_message_id,timestamp`, { headers });
    const latest = (await r.json())?.[0];
    if (!latest || !latest.wa_message_id || latest.wa_message_id === ownWaMessageId) return false;
    // Compare as epoch ms — Supabase serialises timestamptz as "+00:00" while
    // ours are "Z"-suffixed, so string comparison would misorder them. WhatsApp
    // timestamps are second-precision, so exact ties are common in bursts.
    const latestT = new Date(latest.timestamp).getTime();
    const ownT = new Date(ownTimestamp).getTime();
    if (latestT > ownT) return true;
    return latestT === ownT && String(latest.wa_message_id) > String(ownWaMessageId);
  } catch (_) { return false; }
}

// True if an identical outbound text went to this number in the last N
// minutes. Compares on a whitespace-normalised prefix so a trailing
// "[Buttons: …]" note doesn't hide a repeat.
async function sentRecently(url, headers, waNum, text, minutes = 10) {
  try {
    const since = new Date(Date.now() - minutes * 60e3).toISOString();
    const r = await fetch(`${url}/rest/v1/wa_messages?wa_num=eq.${waNum}&direction=eq.outbound&timestamp=gte.${since}&select=content&limit=10`, { headers });
    const rows = await r.json();
    const norm = (t) => String(t || '').replace(/\n\[Buttons:.*$/s, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const mine = norm(text);
    return Array.isArray(rows) && rows.some(m => norm(m.content) === mine);
  } catch { return false; }
}

async function logOutbound(url, headers, agentId, waNum, content, waMessageId = null, category = null, model = null) {
  const ts = new Date().toISOString();
  const row = {
    agent_id: agentId, wa_num: waNum, direction: 'outbound',
    content, timestamp: ts, source: 'api',
    // category feeds comms_metrics' read-rate-by-format breakdown
    // (e.g. 'listing_card' vs free-text vs template sends).
    category,
    // Which Claude model wrote this reply (haiku/sonnet) — feeds the weekly
    // review's routing audit. Null for template/system sends.
    model,
    // Baseline status + the id so delivered/read events can be matched.
    status: 'sent', wa_message_id: waMessageId
  };
  const post = (body) => fetch(`${url}/rest/v1/wa_messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  try {
    const res = await post(row);
    // Self-heal if the `model` column migration hasn't run yet: retry without it
    // so a reply is never dropped from the inbox log over a schema lag.
    if (!res.ok && model != null) { const { model: _m, ...rest } = row; await post(rest); }
  } catch (e) { console.warn('logOutbound failed:', e.message); }

  // Also append outbound to the agent's conversation_summary so it's visible as context
  if (agentId) {
    try {
      const agentRes = await fetch(`${url}/rest/v1/agents?id=eq.${agentId}&select=conversation_summary`, { headers });
      const agentRow = (await agentRes.json())?.[0];
      const dateStr = new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      const readable = humanizeMarker(content);
      const snippet = readable.slice(0, 120) + (readable.length > 120 ? '...' : '');
      const newLine = `\n[${dateStr}] Maya: ${snippet}`;
      const updatedSummary = ((agentRow?.conversation_summary || '') + newLine).slice(-4000);
      await fetch(`${url}/rest/v1/agents?id=eq.${agentId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ conversation_summary: updatedSummary })
      });
    } catch (e) {
      console.warn('logOutbound summary update failed:', e.message);
    }
  }
}

// Fetch a WhatsApp media object as base64 for Claude vision. Returns
// { mime, data } or null (unsupported type, too large, or fetch failure) —
// callers fall back to the text-only "couldn't open it" prompt.
async function fetchWaMediaBase64(mediaId, token) {
  const MAX_BYTES = 4.5 * 1024 * 1024; // Claude rejects images >5MB base64
  const metaRes = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const mime = meta.mime_type || '';
  if (!meta.url || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
  if (meta.file_size && meta.file_size > MAX_BYTES) return null;
  const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!binRes.ok) return null;
  const buf = Buffer.from(await binRes.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  return { mime, data: buf.toString('base64') };
}

// Download an inbound WhatsApp document (PDF, agreement, etc.) and archive it to
// Supabase Storage so it stays openable forever — Meta deletes media after ~30
// days. Returns a permanent public URL, or null on any failure (the caller then
// falls back to the Meta media id, served through the short-lived proxy).
async function archiveInboundDoc(supabaseUrl, supabaseKey, mediaId, filename, token) {
  const MAX_BYTES = 25 * 1024 * 1024;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v24.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta.url) return null;
    if (meta.file_size && meta.file_size > MAX_BYTES) return null;
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binRes.ok) return null;
    const buf = Buffer.from(await binRes.arrayBuffer());
    if (buf.length > MAX_BYTES) return null;
    const safe = (String(filename || 'document').replace(/[^\w.\-]+/g, '_').replace(/^_+/, '').slice(-80)) || 'document';
    const path = `docs/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
    const up = await fetch(`${supabaseUrl}/storage/v1/object/brochures/${path}`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: 'Bearer ' + supabaseKey, 'Content-Type': meta.mime_type || 'application/octet-stream', 'x-upsert': 'true' },
      body: buf,
    });
    if (!up.ok) return null;
    return `${supabaseUrl}/storage/v1/object/public/brochures/${encodeURI(path)}`;
  } catch (e) {
    return null;
  }
}

// Sends a free-text WhatsApp message and returns Meta's wa_message_id (or null)
// so the caller can log it — without the id, delivery/read status can never be
// matched back to the row by the statuses webhook handler.
async function sendText(phoneId, token, to, text) {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
    const d = await r.json().catch(() => ({}));
    return d?.messages?.[0]?.id || null;
  } catch (e) { console.warn('sendText failed:', e.message); return null; }
}

// Free-text reply with up to 3 native quick-reply buttons attached (interactive
// 'button' message). Falls back to a plain text send when there are no valid
// buttons, the body exceeds Meta's 1024-char interactive limit, or Meta
// rejects the interactive shape — the reply itself must never be lost.
export async function sendTextWithButtons(phoneId, token, to, text, buttons) {
  const titles = (buttons || []).map(b => String(b).trim().slice(0, 20)).filter(Boolean).slice(0, 3);
  if (!titles.length || text.length > 1024) return sendText(phoneId, token, to, text);
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text },
          action: { buttons: titles.map((t, i) => ({ type: 'reply', reply: { id: 'MAYA_QR_' + i, title: t } })) }
        }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.messages?.[0]?.id) return d.messages[0].id;
  } catch (e) { console.warn('button send failed:', e.message); }
  return sendText(phoneId, token, to, text);
}

// Native WhatsApp contact card — the agent taps to save/chat. Returns the
// message id or null.
async function sendContactCard(phoneId, token, to, name, phoneDigits) {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'contacts',
        contacts: [{
          name: { formatted_name: name, first_name: String(name).split(/\s+/)[0] },
          phones: [{ phone: '+' + phoneDigits, wa_id: phoneDigits, type: 'CELL' }]
        }]
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn('contact card send failed:', d?.error?.message || r.status); return null; }
    return d.messages?.[0]?.id || null;
  } catch (e) { console.warn('contact card send failed:', e.message); return null; }
}

// Mark an inbound message as read AND show a typing indicator. The typing
// indicator runs for ~25 seconds OR until our next message lands, whichever is
// first — so by the time Maya's auto-reply sends, the indicator clears cleanly.
// Per Meta Cloud API (added Sep 2024): single call to /messages with status=read
// + typing_indicator { type: 'text' }.
async function markAsReadWithTyping(phoneId, token, messageId) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' }
    })
  });
}

// Returns true if a document with this filename was sent to this agent within
// the last `days` days. Used to prevent Maya re-sending a brochure that the
// campaign already attached.
async function wasDocRecentlySent(url, headers, agentId, filename, days) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${url}/rest/v1/wa_messages?agent_id=eq.${agentId}&direction=eq.outbound&timestamp=gte.${cutoff}&select=content&limit=200`,
      { headers }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    if (!Array.isArray(rows)) return false;
    return rows.some(m => (m.content || '').includes(`[Document: ${filename}]`));
  } catch (e) {
    return false;
  }
}

async function sendDocument(phoneId, token, to, link, filename) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'document', document: { link, filename } })
  });
}

// Rich [[card]] / [[carousel]] rows read as JSON gunk in Maya's own context —
// collapse them to a short human line for summaries and thread history.
// Repair unpaired UTF-16 surrogates (half-emoji from WhatsApp) so stored content
// and model payloads stay well-formed. Non-strings pass through untouched.
function wellFormedStr(s) {
  if (typeof s !== 'string') return s;
  return s.toWellFormed
    ? s.toWellFormed()
    : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

// Recursively repair lone surrogates through an arbitrary structure (system
// prompt strings + the messages array). Conversation history loaded from the DB
// can still carry broken emoji stored before ingestion sanitization existed, so
// every Anthropic request body must pass through this or the whole call fails
// with "no low surrogate in string".
function deepWellFormed(v) {
  if (typeof v === 'string') return wellFormedStr(v);
  if (Array.isArray(v)) return v.map(deepWellFormed);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = deepWellFormed(v[k]);
    return o;
  }
  return v;
}

function humanizeMarker(content) {
  const c = String(content || '');
  const m = c.match(/^\s*\[\[(card|carousel)\]\]([\s\S]+)$/);
  if (!m) return c;
  try {
    const data = JSON.parse(m[2]);
    if (m[1] === 'card') return `[Sent listing card: ${data.title || 'property'}]`;
    const names = (data.cards || []).map(x => x.title).filter(Boolean).join(', ');
    return `[Sent availability carousel${names ? ': ' + names : ''}]`;
  } catch (_) { return `[Sent listing ${m[1]}]`; }
}

// Fetch the last 30 messages (both directions) for an agent, ordered oldest→newest.
// Returns a formatted string like:
//   [09:44] KAYA: Hi jules, I'm reaching out from KAYA Developments...
//   [09:45] Agent: Yes please
async function fetchRecentThread(url, headers, agentId) {
  try {
    const r = await fetch(
      `${url}/rest/v1/wa_messages?agent_id=eq.${agentId}&order=timestamp.desc&limit=30`,
      { headers }
    );
    if (!r.ok) return '';
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return '';
    // Reverse so oldest first
    rows.reverse();
    return rows.map(m => {
      const t = new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
      const sender = m.direction === 'outbound' ? 'KAYA Listings (Maya)' : 'Agent';
      const content = humanizeMarker(m.content || '').slice(0, 200);
      return `[${t}] ${sender}: ${content}`;
    }).join('\n');
  } catch (e) {
    return '';
  }
}


// Everything a reply carries besides its text — brochure, listing cards,
// contact card, team alert, owner relay — executed the same way whether the
// reply was auto-sent by the webhook or approved from a draft in the console
// (api/whatsapp-send.js). Before this, drafts kept only the cards: approving
// a viewing request sent the words and dropped the Era ping and the card.
// `actions` = { send_doc, send_cards, send_contact, notify_team, ask_owner }.
export async function executeReplySideEffects({ SUPABASE_URL, sbHeaders, WA_PHONE_ID, WA_TOKEN, agent, toNum, actions, evidence = '', brochures = null, digest = null }) {
  if (!actions || !WA_TOKEN || !WA_PHONE_ID) return;
  if (!brochures) { try { brochures = buildBrochures(await loadProjects(SUPABASE_URL, sbHeaders)); } catch { brochures = FALLBACK_BROCHURES; } }
  if (!digest) { try { digest = await loadDigest(); } catch { digest = null; } }
  const cardSlugs = Array.isArray(actions.send_cards) ? actions.send_cards.filter(Boolean).slice(0, 4) : [];
  // Send brochure if Claude requested one (use live brochure map from DB)
  // Dedup: skip if the same filename was sent in the last 14 days (e.g. via campaign attachment).
  const doc = actions.send_doc && brochures[actions.send_doc];
  if (doc && doc.url) {
    const recentlySent = await wasDocRecentlySent(SUPABASE_URL, sbHeaders, agent.id, doc.filename, 14);
    if (!recentlySent) {
      await sendDocument(WA_PHONE_ID, WA_TOKEN, toNum, doc.url, doc.filename);
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, toNum, `[Document: ${doc.filename}]`);
    } else {
      console.log(`Skipping ${doc.filename} — already sent in last 14 days`);
    }
  }
  // Send rich listing cards for every property Maya referenced — cover
  // photo + native "View listing" button, one card per property.
  if (cardSlugs.length) {
    try {
      // One card per property per day to this number: the same four cards on
      // eight consecutive turns was the most visible spam in the logs.
      const fresh = [];
      for (const slug of cardSlugs) {
        const portalSlug = String(slug).replace(/_/g, '-');
        try {
          const since = new Date(Date.now() - 24 * 3600e3).toISOString();
          const r = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_num=eq.${toNum}&direction=eq.outbound&category=eq.listing_card&timestamp=gte.${since}&content=like.*property%3D${encodeURIComponent(portalSlug)}*&select=id&limit=1`, { headers: sbHeaders });
          if ((await r.json())?.length) continue;
        } catch { /* on doubt, send */ }
        fresh.push(slug);
      }
      const cards = fresh.length ? await resolveListingCards(fresh, 4) : [];
      for (const card of cards) {
        const sent = await sendListingCardMessage({ PHONE_ID: WA_PHONE_ID, TOKEN: WA_TOKEN }, toNum, card);
        if (sent.waMessageId) {
          await logOutbound(SUPABASE_URL, sbHeaders, agent.id, toNum, cardMarker(card), sent.waMessageId, 'listing_card');
        } else {
          console.warn('listing card send failed:', card.slug, sent.error);
        }
      }
    } catch (e) { console.warn('listing cards failed:', e.message); }
  }
  // Native contact card for viewing handoffs ("who do I contact?") —
  // tappable, saves straight to the agent's phone.
  const contact = actions.send_contact;
  if (contact && contact.phone && contact.phone.length >= 9 && contact.phone.length <= 15) {
    const contactMid = await sendContactCard(WA_PHONE_ID, WA_TOKEN, toNum, contact.name, contact.phone);
    if (contactMid) {
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, toNum, `[Contact card: ${contact.name} — +${contact.phone}]`, contactMid);
    }
  }
  // TEAM ALERT — Maya promised a follow-up she can't do herself, or a
  // guest issue needs Era. Ping the right person on WhatsApp NOW, mirror
  // to the PWA push, and leave an audit row so the promise is traceable.
  if (actions.notify_team) {
    const nt = actions.notify_team;
    try {
      await notifyTeam(SUPABASE_URL, sbHeaders, WA_PHONE_ID, WA_TOKEN, { to: nt.to, summary: nt.summary, shareContact: nt.share_contact }, agent);
      await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agent.id, field: 'team_alert', new_value: nt.to,
          reason: nt.summary.slice(0, 300), evidence: (evidence || '').slice(0, 200),
          by_maya: true, created_at: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch (e) { console.warn('notifyTeam failed:', e.message); }
    sendPushNotifications(SUPABASE_URL, sbHeaders, {
      title: `Maya → ${nt.to === 'era' ? 'Era' : 'Ikiel'}: ${agent.name || '+' + toNum}`,
      body: nt.summary.slice(0, 160), agentId: agent.id,
      badgeCount: (agent.unread_count || 0) + 1,
    }).catch(() => {});
  }
  // QUESTION RELAY — the agent asked something checkable that isn't in the
  // KB. Maya puts it to that listing's "enquire with" contact and carries
  // the answer back herself, instead of leaving the agent to chase it.
  if (actions.ask_owner) {
    const ao = actions.ask_owner;
    // Maya emits the CRM slug (villa_rice); the digest carries the portal
    // slug (villa-rice). Compare on the normalised form — the exact match
    // never hit, so every relay went to Era instead of the listed contact.
    const norm = (x) => String(x || '').toLowerCase().replace(/-/g, '_');
    const prop = (digest?.properties || []).find(p => norm(p.slug) === norm(ao.slug));
    const contactWa = String(prop?.waNumber || ERA_WA_NUM).replace(/\D/g, '');
    const contactName = prop?.waContactName || 'Era';
    try {
      // Thread it into the owner's inbox when we know them as an owner.
      let ownerId = null;
      try {
        const oRes = await fetch(`${SUPABASE_URL}/rest/v1/owners?wa_num=eq.${contactWa}&select=id&limit=1`, { headers: sbHeaders });
        ownerId = (await oRes.json())?.[0]?.id ?? null;
      } catch { /* owner link is a nicety, not a requirement */ }

      const r = await openRelay({ SUPABASE_URL, sbHeaders }, { phoneId: WA_PHONE_ID, token: WA_TOKEN }, {
        agent, question: ao.question, slug: ao.slug,
        propertyName: prop?.name || ao.slug, contactName, contactWa, ownerId,
      });
      if (r.ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
          method: 'POST', headers: sbHeaders,
          body: JSON.stringify({
            agent_id: agent.id, field: 'relay_opened', new_value: contactName,
            reason: `${prop?.name || ao.slug}: ${ao.question}`.slice(0, 300),
            evidence: (evidence || '').slice(0, 200), by_maya: true,
            created_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        sendPushNotifications(SUPABASE_URL, sbHeaders, {
          title: `Maya asked ${contactName}: ${prop?.name || ao.slug}`,
          body: ao.question.slice(0, 160), agentId: agent.id,
          badgeCount: (agent.unread_count || 0) + 1,
        }).catch(() => {});
      } else {
        console.log('relay not opened:', r.reason);
      }
    } catch (e) { console.warn('openRelay failed:', e.message); }
  }
}

// Everything generateReply needs that comes from the DB / portal, assembled
// the same way for a live inbound and for a console preview (previewAgentReply
// below) so the two never drift.
async function assembleAgentReplyContext(SUPABASE_URL, sbHeaders, agent) {
  const playbookBlock = await loadPlaybookBlock(SUPABASE_URL, sbHeaders).catch(() => '');
  const projects = await loadProjects(SUPABASE_URL, sbHeaders);
  const rentals = await loadRentals(SUPABASE_URL, sbHeaders);
  const digest = await loadDigest();
  const liveContext = buildPortfolioContext(projects);
  const rentalsContext = buildRentalsContext(rentals);
  const availabilityContext = buildAvailabilityContext(digest);
  const liveBrochures = buildBrochures(projects);
  const rentalSlugs = buildRentalSlugs(rentals);
  // Fetch the full recent thread (both inbound + outbound) so Maya has context of what she sent
  const recentThread = await fetchRecentThread(SUPABASE_URL, sbHeaders, agent.id);
  // If this agent is engaged in an active campaign, fetch the campaign's context
  // so Maya knows the specific focus / promo / framing for this batch. With two
  // possible engagements (KAYA + Samba), use the most-recently-active one.
  let campaignContext = null;
  const recentEng = mostRecentEngagement(agent.campaign_engagement);
  if (recentEng?.eng?.campaign_id) {
    try {
      const cRes = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?id=eq.${recentEng.eng.campaign_id}&select=name,context,purpose`, { headers: sbHeaders });
      const cRow = (await cRes.json())?.[0];
      if (cRow?.context) campaignContext = { name: cRow.name, context: cRow.context, purpose: cRow.purpose };
    } catch (e) { /* non-fatal */ }
  }
  // `digest` rides along: the handler's ask_owner branch resolves the listing's
  // "enquire with" contact from it (it went missing from handler scope when
  // this helper was extracted on 22 Aug 2026 — ReferenceError on every relay).
  return { liveContext, liveBrochures, rentalsContext, availabilityContext, rentalSlugs, recentThread, campaignContext, playbookBlock, digest };
}

// DRY RUN — run the full agent reply pipeline (live KB, availability, thread,
// playbook, model routing, the need_availability round trip) for one agent
// and return Maya's structured result. Nothing is saved, sent, alerted, or
// applied: no agent patch, no WhatsApp, no CRM updates, no spend counter.
// Used by the console's preview (api/supabase.js 'preview_reply') to see what
// Maya WOULD say to the agent's latest message — e.g. to check a prompt change
// against a real thread before it meets a real agent. `inbound` defaults to
// the agent's most recent inbound message.
export async function previewAgentReply({ SUPABASE_URL, sbHeaders, ANTHROPIC_KEY, agent, inbound, mode, debug = false }) {
  let text = inbound;
  if (!text) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?agent_id=eq.${agent.id}&direction=eq.inbound&order=timestamp.desc&limit=1&select=content`, { headers: sbHeaders });
    text = (await r.json())?.[0]?.content || '';
  }
  if (!text) return { error: 'no inbound message to reply to' };
  const ctx = await assembleAgentReplyContext(SUPABASE_URL, sbHeaders, agent);
  const result = await generateReply(ANTHROPIC_KEY, agent, text, mode || 'hybrid', ctx.liveContext, ctx.liveBrochures, ctx.recentThread, ctx.rentalsContext, ctx.campaignContext, ctx.rentalSlugs, ctx.availabilityContext, null, ctx.playbookBlock);
  // debug: also return the data blocks Maya was reasoning over, so a wrong
  // recommendation can be traced to the data vs the prompt.
  const extra = debug ? { context: { thread: ctx.recentThread, availability: ctx.availabilityContext, rentals: ctx.rentalsContext } } : {};
  return { inbound: text, ...result, ...extra };
}

async function generateReply(apiKey, agent, inbound, mode, portfolioContext, brochures, recentThread, rentalsContext, campaignContext, rentalSlugs = [], availabilityContext = '', inboundImage = null, playbookBlock = '') {
  const brochureMap = brochures || FALLBACK_BROCHURES;
  const portfolio = portfolioContext || FALLBACK_PORTFOLIO;
  const brochureKeys = Object.keys(brochureMap).join(', ');
  const isHybrid = mode === 'hybrid';

  // Pick Haiku vs Sonnet for this reply (no-op → Sonnet unless routing is on).
  // A first-ever message (no prior thread) always gets Sonnet — first impression.
  const replyModel = pickReplyModel(inbound, { hasImage: !!inboundImage, firstContact: !recentThread });

  const threadBlock = recentThread
    ? `Recent message thread (oldest → newest, both sides):\n${recentThread}`
    : `Prior notes:\n${(agent.conversation_summary || '(no prior history)').slice(-2500)}`;

  // Split the prompt so the large, byte-stable head (persona + portfolio KB +
  // rentals + availability + fixed rules) is a cacheable prefix. It only changes
  // when Ikiel edits projects/inventory, so across a burst of replies it's
  // served from cache at ~0.1x input cost. The volatile per-conversation tail
  // (agent name, thread, mode) stays uncached after the breakpoint.
  const systemHead = `${MAYA_PERSONA}
${playbookBlock ? `\n${playbookBlock}\n` : ''}
KAYA SALES PORTFOLIO (the single source of truth — Ikiel keeps this current via the Projects admin page):
${portfolio}

${rentalsContext || ''}

${availabilityContext || ''}

WHICH PORTFOLIO TO REFERENCE:
KAYA Sales = freehold/leasehold property SALES (Clay House, Tropical Townhouses, Palem Kembar, Sabit House, LaneHAUS). For agents looking to LIST properties for sale.
Samba Realty = monthly RENTALS (30-night minimum, properties in Canggu / Pererenan / Seminyak). For agents whose clients are looking for longer-stay accommodation. Agent commission is 10%.
Pick the right portfolio based on what the agent is asking about. If they're ambiguous, ask which side they're focused on (sales listings or rental referrals). Some agents do both.

NAME-DROPPING IKIEL (important for cold rental agents):
Many rental agents know Ikiel personally but may not recognize "Samba Realty" or "KAYA Developments" as brand names. To bridge that gap, mention Ikiel by name naturally in your first or second message when context permits:
- Samba flow (more important): "I'm Maya, working with Ikiel on the Samba Realty side..." or "Ikiel asked me to make sure our agent partners have the latest..." — make it sound like a normal introduction, not a name-drop. The goal is to trigger their "oh, Ikiel's bot" recognition.
- KAYA flow: less critical since KAYA Developments is more established as a brand. Still natural to mention Ikiel when appropriate (e.g. "I'll loop Ikiel in" for escalations).
- Don't overdo it — mention Ikiel ONCE per conversation, not in every message. After the agent has placed the context, drop back to "we" / "the team".
- Never claim to be Ikiel. You're Maya, who works WITH Ikiel.

NEVER GO AROUND THE AGENT (hard rule — re-read this before every reply to an agent):
The agent's client is the agent's. You never ask for that client's name, phone, WhatsApp, email or any other contact detail, and you never suggest that Era, Ikiel, or "the team" follow up with, call, or deal with their client directly. Their commission lives in that relationship; asking for it tells the agent we are trying to cut them out.
- Every answer, quote, viewing and follow-up goes BACK TO THE AGENT, who passes it to their client.
- When you cannot answer something yourself (a shorter-than-monthly stay, a rate that isn't fixed, a special arrangement), say you'll check and come back TO THE AGENT, and set notify_team in the same turn. Never turn "I need to check" into a request for their client's details.
  BAD: "Pricing for shorter stays isn't fixed, so I'll need to check with the team. Can I get your client's name and contact so Era can follow up directly?"
  GOOD: "Pricing for shorter stays isn't fixed, so let me confirm with the team and come straight back to you with a number."
- You MAY ask about the BOOKING (dates, guests, budget, area, bedrooms, pets). Never about the PERSON.
- If an agent volunteers their client's contact anyway, don't repeat it, don't ask for more, and never create a CRM contact from it — answer their actual question instead.
- send_contact sends OUR contact (Era, or the listed owner contact) TO the agent so the AGENT can arrange the viewing. It is never a swap for theirs.

DATA PRIORITY RULES (critical — read carefully):
1. The structured "Units:" list under each project is the AUTHORITATIVE record of what is available, sold, reserved, or coming soon. Trust the per-unit availability tag (-- SOLD, -- RESERVED, -- COMING SOON) over any other text.
2. When quoting prices: only quote prices from units that are NOT marked SOLD/RESERVED. Never quote a sold unit's price as if it's available.
3. When counting availability: count units WITHOUT a SOLD/RESERVED/COMING SOON tag. Do not parrot a number from "Notes for Maya" if it conflicts with the actual unit count.
4. The "Notes for Maya" line is supplementary context (tone, positioning, edge-case framing). It is NOT the source of truth for prices, availability counts, or unit specs. If notes conflict with structured fields, the structured fields win.
5. Brochure URLs, commission %, status, delivery date, payment plan — also authoritative as written in the structured fields.
6. The "Extended details (from brochure)" block is supplementary information pulled from the project's sales brochure. Use it for questions that aren't covered by structured fields (architects, builder/contractor, design philosophy, materials, construction methodology, amenity rationale, etc.). Quote it freely when relevant.
7. If a field is empty AND there's nothing in extended_info that covers the question, do not guess or fill in from memory. For a Samba rental, ask the listed contact (ask_owner); for a KAYA project, say you'll check with Ikiel and set notify_team.
8. Better still, GO AND GET THE ANSWER — see ASKING THE VILLA CONTACT below. "I don't have that" is a dead end; "let me find out for you" is the job.

ASKING THE VILLA CONTACT ("ask_owner") — how you answer what isn't in your data:
When an agent asks a CHECKABLE FACT about a specific Samba villa that is not in the data above — a bathtub, an oven, a bathtub vs shower, air-con in every room, a generator, whether the pet policy stretches to a dog, stroller access, a workspace, water pressure, staff, parking for two cars — do not stop at the contact card. Set "ask_owner": { "slug": "<that property's slug>", "question": "<the question in one clear sentence>" }. The system asks that listing's "enquire with" contact on WhatsApp, waits for their answer, and delivers it back to the agent for you — even days later, and even if either side's chat window has closed in the meantime.
- Tell the agent plainly what you're doing, in the same reply: "I don't have that on file for Villa Saturno — I'm asking the villa now and I'll come straight back to you." Then STOP. Never guess the answer, and never invent a timeframe like "within the hour".
- Also send the contact card as you normally would (the agent may want to arrange the viewing directly). Relaying the question and handing over the card are not alternatives — do both.
- The question you write goes to the contact VERBATIM, so make it a clean single question about the property. Never mention the agent's name, their agency, or their client. The contact is told only that "an agent asked" — you are the one brokering this.
- ONE relay per reply, and only for something the contact can actually decide or confirm. Do NOT relay: discounts on an Era-managed villa (notify Ikiel) or on a villa whose notes give you a negotiation floor (negotiate yourself), live availability (use need_availability), anything already answered in your data, or vague curiosity with no agent waiting on it.
- If the agent is asking about a KAYA SALES project rather than a Samba rental, leave ask_owner null — those go to Ikiel via notify_team.
- When a relay is already open with that contact for the same question, just tell the agent you're still waiting; the system will not double-ask.

TEMPLATE CONTEXT (what the approved outbound templates say, so you understand replies to them):
- [Template: kaya_intro] = "Hi {name}, I'm reaching out from KAYA Developments Listings Team to make sure agents have up-to-date info on our current projects and properties. Can I send you the latest info?"
- [Template: samba_intro] = "Hi {name}, I'm reaching out from Samba Realty Listings to make sure agents have up-to-date info on our current rentals. Can I send you the latest info?"

When an agent replies with a short affirmative (Yes / Yes please / Sure / Please / Go ahead / Ok) after one of these templates, they are saying yes to receiving the info. Respond IMMEDIATELY with the info — do NOT ask "which project?" or "what area?" first.

If they said yes to kaya_intro: send a concise overview of all active KAYA SALES projects — one short line each (name, location, price range, headline feature). Then invite them to go deeper on whichever interests them.

If they said yes to samba_intro: send a concise overview of the SAMBA RENTAL range — one short line each for the main property groups (HAUS Canggu, LaneHAUS, Villa Saturno, Tropicana Valley, plus the standalone villas), covering location, type, and headline rate. Keep it to a few tight lines: this is a taste of the range, not the full catalogue.
  ALWAYS attach native listing cards on this overview — set "send_cards" to up to 4 rental slugs (your best, most-available, most-representative picks; ideally spread across price/area so the agent sees the range). The system sends each as a rich WhatsApp card (cover photo, rate, native "View listing" button) right after your text — that IS how the agent sees the listings.
  Do NOT paste the sambarentals.com URL or any raw link in this message — the cards carry both the photos and the links. You may refer to "the portal" in words ("the rest are on the portal, and you can download photos there to share with clients"), and invite them to ask about any specific property so you can send its card. On subsequent Samba responses, just refer to "the portal" in words if relevant — never paste the bare URL as a stand-in for cards.`;

  const systemRest = `This conversation's context:
Agent name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}
${threadBlock}

CONTINUITY — this is ONE running conversation, not a series of first contacts. Read the thread above before writing:
- If you have already messaged this person in the thread, do not greet or introduce yourself again ("Hi Made --", "Saya Maya, asisten…"). Start with the substance. Introduce yourself only when the thread shows no message from you yet, or the person explicitly asks who they are talking to — and then in one clause, not a paragraph.
- Mention Ikiel by name only if "Ikiel" does not already appear in any of your previous messages in the thread.
- If your previous message asked a question that has not been answered, keep it alive: answer what they just said, then bring the open question back in one line. Never let a question you asked evaporate because the agent changed the subject.
- Match the language of their LAST message, and stay in it; when they switch to Bahasa, switch with them without commenting on it beyond a word.
- Never restate what you told them in your previous message; refer to it ("the list I sent above").
${campaignContext ? `

CAMPAIGN-SPECIFIC FOCUS (this agent was reached via the "${campaignContext.name}" campaign — use this as your North Star for the current conversation; weave it in naturally rather than reciting it):
${campaignContext.context}${campaignContext.purpose ? `\nCampaign purpose: ${campaignContext.purpose}` : ''}` : ''}

You can attach a project brochure PDF for KAYA SALES projects only. Available brochure keys: ${brochureKeys}.

IMPORTANT — SAMBA RENTALS HAVE NO PDF BROCHURES.
For Samba rental properties (HAUS Canggu, LaneHAUS rental units, Villa Saturno, Tropicana Valley monthly rentals) there are NO PDF brochures to send. All photos, availability calendars, and listing details live in the portal at https://sambarentals.com.
- If an agent asks for rental photos, the brochure, or "info to share with a client," direct them to the portal — agents can download photos there directly.
- Never offer to send a rental brochure. Never list "which property would you like a brochure for" for Samba rentals.
- For KAYA sales projects (Clay House, Sabit House, Palem Kembar, Tropical Townhouses-as-sales, LaneHAUS-as-sales), PDF brochures DO exist and can be attached via send_doc.

${CRM_SIGNALS_INSTRUCTIONS}

Respond with ONLY a JSON object (no markdown, no prose):
{
  "match_scan": [] | one entry per Samba rental when the agent has given client criteria, e.g. { "slug": "villa_saturno", "verdict": "fit", "why": "3BR villa, 35jt under 45jt ceiling, pool, Canggu; free 14 Sep" },
  "action": "auto" | "escalate" | "need_availability",
  "reply": "the message to send to the agent (1-4 sentences typical); leave "" when action is need_availability",
  "availability_query": null | { "slug": "<samba property slug>", "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD" },
  "send_doc": null | one of [${brochureKeys}],
  "send_cards": [] | up to 4 Samba rental slugs, e.g. ["villa_umah_astanine", "haus_4"] — valid slugs: [${rentalSlugs.join(', ') || '(none available)'}],
  "send_contact": null | { "name": "Era", "phone": "6281246357778" },
  "reply_buttons": [] | up to 3 short tap options (max 20 chars each), e.g. ["More options", "Download photos"],
  "notify_team": null | { "to": "era" | "ikiel", "summary": "1-2 sentences: property name + what's needed + any deadline", "share_agent_contact": true|false },
  "ask_owner": null | { "slug": "<samba rental slug from the list above>", "question": "one clear question about the property, sent verbatim to its enquire-with contact" },
  "crm_updates": [
    { "field": "projects.Sabit House.status", "value": "Listed", "reason": "agent confirmed listing" }
  ],
  "crm_actions": [
    { "type": "create_agent", "name": "Hikam", "wa_num": "6281234567890", "reason": "referred by this agent", "service_type": "rental", "replace": false }
  ]
}
NEGOTIATION — when an agent asks for a lower price:
- If the property's "Notes for Maya" contain a NEGOTIATION rule with a floor, you are authorised to negotiate that villa yourself: open at the listed rate, move only when the agent pushes back with a concrete number or reason, concede in small steps (never jump to the floor), never go below the floor, and never reveal the floor. When a figure is agreed, restate it plainly in the reply ("Agreed: 270jt for the year, starting 1 Oct") and set notify_team to Ikiel with the agreed number and the agent's name so he can issue the paperwork. Use "auto" for these turns — that is the point of the pilot.
- If there is no floor in the notes: Era-managed villa → say you'll take it to Ikiel and set notify_team to Ikiel; any other listed contact → relay the request with ask_owner and tell the agent you're asking the villa. Never invent a discount, and never imply the price is flexible when you have no floor.
MATCH SCAN ("match_scan") — fill this FIRST, before the reply, whenever the agent's latest message or the thread contains a client brief (any of: budget, bedrooms, area, dates, property type, features). One entry for EVERY Samba rental in the portfolio, no skipping: "fit" = meets every hard criterion (property type, bedroom minimum, price at or BELOW the budget ceiling — cheaper is still a fit — and, if dates were given, free or freeing up by the start date); "near_miss" = exactly one hard criterion missed by a little (price up to ~15% over the ceiling, one bedroom short, right neighbourhood but not the named street, or frees up within ~2 weeks after the requested start); "out" = clearly fails, with the reason. Unknown features are NOT a miss. Every "fit" MUST then appear in your reply and (up to 4) in send_cards — if more than 4 fit, card the best 4 and name the rest in the text. Near-misses come after the fits, clearly framed. Leave match_scan [] when there is no brief (greetings, commission questions, a single named property, KAYA sales talk).
Use "need_availability" ONLY to check a specific date range for a Samba rental, per the SAMBA LIVE AVAILABILITY instructions above — set "availability_query" and leave "reply" empty; the system handles the lookup and re-prompts you. For all other messages use "auto" or "escalate".
${isHybrid
  ? `Set "action" to "auto" ONLY if the message is a simple, factual question you can answer with full confidence from the portfolio knowledge (e.g. commission %, a single property's price, a single property's availability, sending a brochure). For complaints, commitments, legal questions, or ambiguity, set "action" to "escalate". Scheduling turns where you are only collecting a preferred time and asking the listed contact are "auto". Negotiation is "auto" ONLY when the villa's notes give you a floor (NEGOTIATION above); with no floor, "escalate" (Ikiel will review your draft before it sends). A CLIENT BRIEF — an agent giving criteria (budget, bedrooms, area, dates, features) and asking what you have — is ALWAYS "escalate": your shortlist, near-miss framing, and any over-budget or out-of-area suggestion get a human look before they reach the agent.`
  : `Set "action" to "auto" by default. Use "escalate" only when one of your escalation triggers fires (negotiation, complaint, legal questions, request to speak to Ikiel, low confidence, etc).`}
Set "send_doc" ONLY when the agent EXPLICITLY requests the brochure/PDF/document for a specific KAYA sales project. Examples that trigger send_doc: "send me the brochure", "do you have a PDF for Clay House", "can you share the documents", "send over the info pack". Do NOT set send_doc just because the agent mentioned a project name or asked a general question about it — describe the project in text first and let them ask for the brochure if they want it. The system also auto-dedupes: if a brochure was already sent in the last 14 days (e.g. via a campaign attachment), it will silently skip the re-send.
LISTING CARDS ("send_cards") — MANDATORY whenever you share Samba rentals:
Any time your reply pitches, recommends, or answers about one or more SPECIFIC Samba rental properties, put their slugs in "send_cards" (max 4, in the order they appear in your reply — best match first). The system sends each one as a rich WhatsApp card right after your text: cover photo, name, rate, and a native "View listing" button that opens the live listing. Because the cards carry the photo and the link:
- Do NOT paste listing URLs (sambarentals.com/?property=...), Google Drive photo links, or long links of any kind in your reply text when cards are going out — keep the text to the pitch and the facts, and let the cards do the visuals. A closing reference to "the portal" in words is fine.
- EXCEPTION: when the agent explicitly asks to DOWNLOAD photos (to share with a client), give the property's photos_url (Google Drive) in text; when they ask for the location/pin, give maps_url. Those direct links are still the right answer for download/location requests — send them alongside the card.
- "Can I see X" / "what does X look like" / "send a photo of X" → put X's slug in send_cards; the card includes the photo. If a property group has several units (e.g. Tropicana), pick the specific unit(s) you are recommending.
Set "send_cards" to [] only when no specific Samba property is being shared (greetings, commission questions, KAYA sales talk, etc).
CONTACT CARD ("send_contact"): when the agent asks WHO to contact for a viewing, visit, or booking of a Samba rental, set send_contact with the EXACT name and number from that property's "enquire with" line in the live availability data (never a number from conversation history). The system sends a native, tappable WhatsApp contact card the agent can save. Still mention the name briefly in your text reply ("I'm sending you Era's contact card -- she arranges the viewings for this villa."). Leave null otherwise.
QUICK-REPLY BUTTONS ("reply_buttons"): when there is an obvious next step, offer up to 3 tap options so the agent doesn't have to type — e.g. after recommending villas: ["More options", "Download photos", "Book a viewing"]; after an availability answer: ["Check other dates", "Send the listing"]. Each label max 20 characters, plain words, no emojis. When the agent taps one, you receive that label as their next message — so only offer buttons you can actually act on. Leave [] on closers ("thanks, bye"), escalations, and when no clear next step exists.
TEAM ALERTS ("notify_team") — a real promise, not a figure of speech:
Whenever your reply tells the person you'll check with / flag for / pass along to Ikiel, Era, or "the team" — or they need something you cannot complete yourself (a rate you don't have, a video that doesn't exist, a negotiation, a special arrangement) — you MUST set notify_team in the same turn. It sends a WhatsApp message to that team member immediately, whatever the hour. Never say "I'll check and come back to you" with notify_team left null: that is a broken promise.
- "to": "era" for anything operational about a specific villa or stay — viewings she coordinates, guest problems, keys and check-in, maintenance, cleaning, availability oddities — especially when Era is that property's "enquire with" contact. Era is the villa manager and the first port of call for operations.
- "to": "ikiel" for pricing and negotiation, non-standard commissions, business decisions, partnership offers, and anything that is not villa operations.
- When the property's listed contact is NOT Era, the operational question goes to that contact via ask_owner (and their contact card via send_contact), not to Era; notify_team to Ikiel still applies for pricing decisions outside a negotiation floor, complaints and business matters.
- "summary": 1-2 sentences a busy person can act on — property name, who is asking, what they need, any deadline.
- "share_agent_contact": true when the team member will need to contact this person directly (always true for guest issues). "This person" is the SENDER — the agent, owner, or guest you are talking to. It is never their client: you never hold, ask for, or pass on an agent's client's details (see NEVER GO AROUND THE AGENT).

GUEST SUPPORT & DISTRESS — when the sender is clearly a GUEST or someone with an urgent stay problem (locked out, something broken, complaint about cleanliness or service, urgent booking issue) rather than an agent:
1. Reply with genuine empathy and zero deflection. Tell them plainly: you are an AI assistant, but you are alerting Era — the villa manager and the right person to fix this — right now.
2. Attach Era's contact via send_contact so they can reach her directly.
3. Set notify_team {"to": "era", "summary": <the issue, the property if known, how urgent>, "share_agent_contact": true}.
Never leave a distressed message unanswered or answer it with a sales-style intro. Even when the stay isn't one of ours (e.g. an Airbnb mix-up), respond kindly, say so, and still alert Era if there's any chance it involves one of our properties.

WHEN NOT TO REPLY — set "reply" to "" with action "auto" (nothing is sent, no draft is left) for:
- stickers, emoji-only messages, and [Sticker] / [Unknown message type] markers
- automated out-of-office / auto-reply messages from a business line (wait for the human; never converse with an autoresponder)
- bare acknowledgments ("ok", "noted", "thanks", "🙏", "siap") when your PREVIOUS message already closed the loop — the conversation may end without you having the last word. One thank-you does not need three goodbyes.
When a short closer IS warranted, write a fresh one — never send the same closing line twice in a row to the same person, and keep closers to one sentence.

Set "crm_updates" to an empty array if no clear pipeline signals are present.
Set "crm_actions" to an empty array unless the TEAM HANDOFF rules above apply.
Set "notify_team" to null unless the TEAM ALERTS or GUEST SUPPORT rules above apply.`;

  // systemHead is the stable, cacheable prefix; systemRest carries the volatile
  // per-conversation context. Together they carry the same instructions as the
  // old single-string prompt, so Maya's behaviour is unchanged.
  const system = [
    { type: 'text', text: systemHead, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: systemRest },
  ];

  // Conversation turns for this reply. A date-range availability check appends
  // an assistant turn + the calendar result, then re-prompts once (max 2 calls).
  // When the agent sent an image, it rides along as a vision block.
  const firstTurn = inboundImage
    ? [{ type: 'image', source: { type: 'base64', media_type: inboundImage.mime, data: inboundImage.data } },
       { type: 'text', text: `The agent just sent: "${inbound}"` }]
    : `The agent just sent: "${inbound}"`;
  const messages = [{ role: 'user', content: firstTurn }];
  let llmCalls = 0;
  let costUsd = 0;
  const MAX_LLM_CALLS = 2;

  try {
    for (let hop = 0; hop < MAX_LLM_CALLS; hop++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(deepWellFormed({
          model: replyModel,
          max_tokens: REPLY_MAX_TOKENS,
          system,
          messages,
          // Constrain the turn to the contract object — no preamble, no
          // reasoning narration, no code fences (see MAYA_REPLY_SCHEMA).
          output_config: { format: MAYA_REPLY_FORMAT },
        }))
      });
      llmCalls++;
      const data = await res.json();
      // API-level failure (credit exhaustion, auth, rate limit, 5xx): the body
      // is an error envelope, not a message. Surface it as a distinct failure —
      // the handler turns aiResult.error into a loud draft marker + alert —
      // instead of dissolving into an empty escalate. Errored calls are not
      // billed, so no fallback cost is charged for this hop.
      if (!res.ok || data.type === 'error') {
        const errMsg = data?.error?.message || `HTTP ${res.status}`;
        console.warn('generateReply API error:', errMsg);
        return { action: 'escalate', reply: '', error: errMsg, send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls, cost_usd: costUsd };
      }
      // Charge actual token spend for this hop (falls back if usage is absent).
      costUsd += data.usage ? costOfUsage(data.usage, replyModel) : FALLBACK_COST_PER_REPLY_USD;
      // A truncated, missing, or malformed object is a GENERATION FAILURE, same
      // as an API error: loud marker in the draft box + alert. Never ship the
      // raw text as the reply — there is no reading of a non-JSON turn that is
      // safe to send to an agent.
      const { parsed, raw, error: parseErr } = parseReplyJson(data);
      if (parseErr) {
        console.warn('generateReply unusable output:', parseErr);
        return { action: 'escalate', reply: '', error: parseErr, send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls, cost_usd: costUsd, model: replyModel };
      }

      // Maya wants a live calendar check for a specific range — do it, then
      // feed the result back for a final reply. Only on the first hop.
      if (parsed.action === 'need_availability' && parsed.availability_query && hop < MAX_LLM_CALLS - 1) {
        const result = await checkPortalAvailability(parsed.availability_query);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Live calendar result: ${result}\n\nNow reply to the agent with a final JSON response (action "auto" or "escalate"). Quote the dates and be specific. If not available, mention the next free option if helpful.\n\nThis result covers ONLY the one property you checked. If the agent gave a client brief (budget, bedrooms, area, features), your reply must still follow the CLIENT MATCHING RULES in full: re-scan the whole portfolio, lead with EVERY candidate that fits the hard criteria — remember the budget is a ceiling, so cheaper properties are in, not out — using the live availability summary for the ones you did not calendar-check (say you'll confirm their exact dates), and only then add any over-budget near-miss, clearly framed. Do not let the property you happened to check crowd out better-fitting ones. Attach cards for every property you recommend.` });
        continue;
      }

      return {
        action: parsed.action === 'auto' ? 'auto' : 'escalate',
        reply: parsed.reply || '',
        // Maya's per-property fit verdicts (client briefs only). Not acted on
        // by the handler; surfaced by preview_reply so a recommendation can be
        // audited against what she actually considered.
        match_scan: Array.isArray(parsed.match_scan) ? parsed.match_scan : [],
        send_doc: parsed.send_doc || null,
        // send_photo is the legacy single-photo field — fold it into cards.
        send_cards: Array.isArray(parsed.send_cards) ? parsed.send_cards.slice(0, 4)
          : (parsed.send_photo ? [parsed.send_photo] : []),
        send_contact: (parsed.send_contact && parsed.send_contact.name && parsed.send_contact.phone)
          ? { name: String(parsed.send_contact.name).slice(0, 80), phone: String(parsed.send_contact.phone).replace(/\D/g, '') }
          : null,
        reply_buttons: Array.isArray(parsed.reply_buttons)
          ? parsed.reply_buttons.map(b => String(b).trim().slice(0, 20)).filter(Boolean).slice(0, 3)
          : [],
        crm_updates: Array.isArray(parsed.crm_updates) ? parsed.crm_updates : [],
        crm_actions: Array.isArray(parsed.crm_actions) ? parsed.crm_actions : [],
        notify_team: (parsed.notify_team && parsed.notify_team.to && parsed.notify_team.summary)
          ? {
              to: String(parsed.notify_team.to).toLowerCase() === 'era' ? 'era' : 'ikiel',
              summary: String(parsed.notify_team.summary).slice(0, 500),
              share_contact: !!parsed.notify_team.share_agent_contact,
            }
          : null,
        // Only relay against a slug that actually exists — an invented slug
        // would send a question about a villa nobody manages.
        ask_owner: (parsed.ask_owner && parsed.ask_owner.slug && parsed.ask_owner.question
                    && rentalSlugs.includes(String(parsed.ask_owner.slug)))
          ? {
              slug: String(parsed.ask_owner.slug),
              question: String(parsed.ask_owner.question).trim().slice(0, 500),
            }
          : null,
        llm_calls: llmCalls,
        cost_usd: costUsd,
        model: replyModel,
      };
    }
    // Exhausted hops without a terminal reply (e.g. Maya asked for availability
    // twice) — escalate so a human picks it up rather than sending nothing.
    return { action: 'escalate', reply: '', send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls, cost_usd: costUsd, model: replyModel };
  } catch (err) {
    console.warn('generateReply failed:', err.message);
    return { action: 'escalate', reply: '', error: err.message || 'generateReply threw', send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls || 1, cost_usd: costUsd, model: replyModel };
  }
}

// ══ OWNER-MODE (villa owners/managers, distinct from sales agents) ═════════
// A completely separate reply path from generateReply. Owners get a warm,
// non-salesy Maya who can (1) report on their listing's performance and (2)
// create/update a listing from a natural conversation. Everything routes
// through the portal's service-authed endpoints; drafts/sends mirror the agent
// flow but use the owners table + owner_id-tagged messages. (PORTAL_BASE is
// declared near the top of the file, shared with the availability helpers.)

async function handleOwnerConversation({ SUPABASE_URL, sbHeaders, owner, fromNum, inbound, timestamp, waMessageId, WA_TOKEN, WA_PHONE_ID, ANTHROPIC_KEY, mediaType, mediaId }) {
  // Automation mode: global setting, with a per-owner pause override.
  let globalMode = 'draft';
  try {
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
    const sRow = (await sRes.json())?.[0];
    if (sRow?.value?.mode) globalMode = sRow.value.mode;
  } catch { /* default draft */ }
  const mode = owner.paused ? 'paused' : globalMode;

  const patch = { last_inbound_at: timestamp, unread_count: (owner.unread_count || 0) + 1 };

  // ── Onboarding funnel bookkeeping (prospects only) ──
  if (isProspect(owner)) {
    // Hard opt-out: mark declined + paused, never contact again. A short
    // gracious goodbye goes out even in draft mode — leaving an opt-out
    // unanswered while a draft waits for review would be worse.
    if (isOptOut(inbound)) {
      patch.onboarding_status = 'declined';
      patch.paused = true;
      patch.suggested_reply = '';
      if (WA_TOKEN && WA_PHONE_ID) {
        const bye = owner.lang === 'id'
          ? 'Baik, tidak apa-apa — saya tidak akan menghubungi lagi. Kalau berubah pikiran, saya selalu ada di sini. 🙏'
          : 'No problem at all — I won’t message you about this again. If you ever change your mind, I’m right here. 🙏';
        const mid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, bye, []).catch(() => null);
        await logOutboundOwner(SUPABASE_URL, sbHeaders, owner.id, fromNum, bye, mid);
      }
      await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
      return;
    }
    // First reply after the intro template → they're in conversation.
    if (owner.onboarding_status === 'agreed' || owner.onboarding_status === 'contacted') {
      patch.onboarding_status = 'in_conversation';
      owner = { ...owner, onboarding_status: 'in_conversation' };
    }
  }

  // ── Inbound photos → the owner's Drive folder (their future gallery) ──
  // Any owner (prospect or listed) sending an image gets it archived; Maya
  // acknowledges with the running count. Failures degrade to a text note so
  // the conversation never breaks on a Drive hiccup.
  if (mediaType === 'image' && mediaId && WA_TOKEN) {
    if (driveConfigured()) {
      try {
        // claimOwnerDriveFolder is race-safe: a photo burst arrives as N
        // concurrent invocations that all read drive_folder_id as null, and
        // the old `if (!folderId) create` gave each one its OWN folder (14 of
        // them on 16 Aug 2026, scattering one owner's photos across all of
        // them). Exactly one invocation now creates; the rest wait for it.
        const folderId = await claimOwnerDriveFolder({
          url: SUPABASE_URL, headers: sbHeaders, owner,
          label: `${owner.name || fromNum} — villa photos`,
        });
        owner = { ...owner, drive_folder_id: folderId };
        const { count } = await uploadWaImageToDrive({ mediaId, waToken: WA_TOKEN, folderId });
        inbound = `[The owner sent a photo. It was saved automatically to their villa photo folder${count ? ` — ${count} photo${count === 1 ? '' : 's'} collected so far` : ''} (${folderLink(folderId)}). Acknowledge naturally; if you have enough details plus photos, consider moving to submit the listing with photosLink set to that folder link.]${inbound && !/^\[/.test(inbound) ? ` Caption: "${inbound}"` : ''}`;
      } catch (e) {
        console.error('drive upload failed:', e.message);
        inbound = `[The owner sent a photo but automatic saving failed (${e.message}). Acknowledge you received it and continue; Ikiel will collect the photos manually.]`;
      }
    } else {
      inbound = '[The owner sent a photo. Automatic photo saving is not configured yet — acknowledge you received it and continue; Ikiel will collect the photos manually.]';
    }
  }

  if (mode === 'paused' || mode === 'off' || !ANTHROPIC_KEY) {
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }

  // SUPERSEDE CHECK #1 (pre-generation) — the owner-side twin of the agent
  // pipeline's guard. Every inbound message is its own invocation, so without
  // this a 27-photo burst generates 27 replies: on 16 Aug 2026 one owner got
  // 24 contradictory "all set!" messages in 43 seconds. The photo upload above
  // still runs for every image; only the REPLY is left to the newest message,
  // which sees the whole burst in its thread.
  await sleep(BURST_SETTLE_MS);
  if (await hasNewerOwnerInbound(SUPABASE_URL, sbHeaders, owner.id, timestamp, waMessageId)) {
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }

  const thread = await fetchOwnerThread(SUPABASE_URL, sbHeaders, owner.id);
  const listingSlugs = Array.isArray(owner.listing_slugs) ? owner.listing_slugs : [];
  const ai = await generateOwnerReply(ANTHROPIC_KEY, owner, inbound, thread, listingSlugs, { SUPABASE_URL, sbHeaders, owner });

  // SUPERSEDE CHECK #2 (post-generation) — more of the burst can land during
  // the ~10s Claude call. Drop this reply; the newer invocation answers once.
  // Any listing intake inside generateOwnerReply has already been applied and
  // is idempotent on the portal side, so dropping the text is safe.
  if (await hasNewerOwnerInbound(SUPABASE_URL, sbHeaders, owner.id, timestamp, waMessageId)) {
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }

  // Count the token spend against the same daily budget as agent replies.
  if (typeof ai.cost_usd === 'number' && ai.cost_usd > 0) {
    await incrementTodaySpend(SUPABASE_URL, sbHeaders, ai.cost_usd).catch(() => {});
  }

  if (ai.error) {
    patch.suggested_reply = `[Maya (owner) failed: ${ai.error} — reply manually.]`;
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }
  // Prospect opted out via Maya's judgement (softer than the keyword guard).
  if (ai.action === 'optout' && isProspect(owner)) {
    patch.onboarding_status = 'declined';
    patch.paused = true;
  }
  // Draft mode (or hybrid escalation): stage the reply for review, don't send.
  // An image suggestion is staged as "[image:key]\ncaption" — owner_send in
  // api/supabase.js parses the marker back into a real WhatsApp image message.
  if (mode === 'draft' || (mode === 'hybrid' && ai.action === 'escalate')) {
    patch.suggested_reply = (ai.media_key && ONBOARD_MEDIA[ai.media_key])
      ? `[image:${ai.media_key}]\n${ai.reply || ONBOARD_MEDIA[ai.media_key].caption}`
      : (ai.reply || '');
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }
  if (ai.action === 'escalate' && !ai.reply) {
    patch.suggested_reply = '[Maya (owner) escalated silently.]';
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }
  // Autopilot / hybrid(auto): send it.
  if (ai.reply && WA_TOKEN && WA_PHONE_ID) {
    let mid = null;
    const media = ai.media_key && ONBOARD_MEDIA[ai.media_key];
    if (media) {
      mid = await sendOwnerImage(WA_PHONE_ID, WA_TOKEN, fromNum, media.url, ai.reply).catch(() => null);
      if (!mid) mid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, ai.reply, []); // image failed → at least send the text
      await logOutboundOwner(SUPABASE_URL, sbHeaders, owner.id, fromNum, media ? `[image:${ai.media_key}]\n${ai.reply}` : ai.reply, mid);
    } else {
      mid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, ai.reply, []);
      await logOutboundOwner(SUPABASE_URL, sbHeaders, owner.id, fromNum, ai.reply, mid);
    }
    forwardMayaReply({ name: owner.name || ('+' + owner.wa_num), agency: 'villa owner' }, ai.reply).catch(() => {});
    patch.suggested_reply = '';
    patch.unread_count = 0;
  } else {
    patch.suggested_reply = ai.reply || '';
  }
  await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
}

async function generateOwnerReply(apiKey, owner, inbound, thread, listingSlugs, db = null) {
  const secret = process.env.LISTING_SYNC_SECRET;
  const ownerName = owner.name || 'there';
  const listingsLine = listingSlugs.length ? listingSlugs.join(', ') : '(none yet — this owner has not listed a villa)';

  // Prospects get the onboarding pitch appended (value props, pricing, promo,
  // media + optout actions). The agent-reach figure is fetched live so Maya
  // never quotes a stale number.
  const prospect = isProspect(owner);
  let onboardingBlock = '';
  if (prospect && db) {
    const agentReach = await fetchAgentReach(db.SUPABASE_URL, db.sbHeaders);
    onboardingBlock = buildOnboardingPitch({ owner, agentReach });
  }

  const system = `You are Maya, listings coordinator for Samba Realty in Bali. You are messaging on WhatsApp with a villa OWNER / property manager — a partner and client, not a sales agent. Be warm, concise, first-name friendly, and never salesy.

Owner: ${ownerName}
Their current listing slugs: ${listingsLine}

Their portal account email: ${owner.email || '(not collected yet — see ACCOUNT LINKING)'}

WHAT YOU DO FOR OWNERS:
1. Answer questions about how their listing is performing — views, enquiries, agents reached, occupancy, this week vs last. NEVER quote numbers from memory: request a live report first (action "report" with report_slug).
2. Help them LIST a new villa or UPDATE one by gathering the details in conversation, then submitting (action "intake"). New/updated listings go to Ikiel for review before they appear publicly — always say so.
3. General help. Ikiel oversees everything and steps in when needed.

WHAT A GOOD LISTING NEEDS (gather these before the first intake):
  · name, area, bedrooms, bathrooms, monthly price
  · overview — 2–4 sentences an agent can read to their client: who the villa suits, what the space is like, what stands out. A listing with an empty overview looks abandoned next to the others.
  · features — 4+ concrete things: private pool, air conditioning, fast wifi, dedicated workspace, full kitchen, parking, garden, etc.
  · photos, an iCal calendar, and their portal email

If they send an Airbnb or Booking.com link for the villa, use action "import" FIRST (set import_url). It reads the public page and hands you the description, amenities and room counts, so you can ask two or three sharp follow-ups instead of interviewing them from scratch.

ACCOUNT LINKING — how an owner gets to see their own listing:
A listing is tied to a portal account by EMAIL. Ask for the Google address they want to sign in with, pass it as "ownerEmail" on the intake, and the listing links itself the first time they log in at sambarentals.com/portal with that exact address. Without it they simply cannot open their own listing, its stats, or its weekly report — so ask early, and once you have it tell them plainly: "Sign in at sambarentals.com/portal with <email> and your villa will be waiting there." If they sign in with a different address than the one you recorded, nothing links — flag it and Ikiel will re-point it.

RULES:
- To create/update a listing you need at least a villa name. Area, bedrooms/bathrooms, monthly price, a Google Drive photos link, and an iCal availability calendar make it far stronger — ask for what's missing, but don't demand everything in one go.
- NEVER invent an overview or a feature. Everything you write must come from the owner, or from an "import" of their own listing page. If you have neither, ask — two friendly questions ("what kind of guest does she suit best?", "what are the three things people always comment on?") get you a better overview than anything you could make up.
- Imported details FILL GAPS ONLY. Anything the owner told you directly wins over the scraped page: their villa name, their bedroom count, their area. If an import disagrees with the owner on a number, do NOT silently pick one — ask them which is right ("Airbnb has it as 2 bedrooms, you said 3 — which should agents see?").
- If photos were saved automatically to their villa photo folder (see thread), use that folder link as photosLink — never ask them for a Drive link they already effectively gave you by sending photos.
- Gather photos AND the availability calendar BEFORE the first "intake" wherever you can. Submitting the moment you have a price means the listing goes to Ikiel half-empty. If the owner still owes you photos or a calendar, ask for them first and submit once.
- CALENDAR (iCal) — you CANNOT derive one. A link to an Airbnb/Booking listing page is NOT a calendar, and you must NEVER construct, guess, or "pull" an .ics URL from a listing URL. Only ever pass an icalUrl the owner literally sent you. If they send a listing link, thank them, say it's useful for the description, and then ask for the export URL in their own words:
  · Airbnb: Calendar → Availability settings → Connect calendars → "Export calendar" → copy the link.
  · Booking.com: Rates & Availability → Sync calendars → "Export calendar" → copy the .ics link.
  · Hostex: Listings → your property → Calendar → iCal export.
  (These are the exact steps the owner portal gives — keep them identical so an owner is never told two different routes.)
  A valid link ends in .ics. If they have no channel calendar, that is fine: tell them to leave it and Ikiel can mark booked dates manually. Never invent a link to fill the field.
- Once a villa has a slug (see "their current listing slugs"), ALWAYS pass that slug when submitting a change to it. Submitting without the slug creates a duplicate listing.
- ENQUIRY CONTACT: agents tap "Visit" on a villa to reach whoever runs it and arrange a viewing, and by default that is the owner on the number they are messaging you from. Ask who the enquiry should go to and what to call them — "Who should agents speak to about viewings, and what name should I put on the listing?" — and pass it as "contactName". A listing that shows a bare number with no name looks unmanaged next to the others. If they want viewings handled by a manager on a different number, say Ikiel will set that up.
- PRICE format: "monthly" is the number in millions of rupiah with a "jt" suffix and nothing else — "40jt", "35.5jt". No "IDR", no "Rp", no "/month": the portal adds the period itself, so anything extra renders as "40jt/month /mo" on the live listing.
- For anything about money owed, payouts, billing, complaints, contracts, or legal: set action "escalate" (Ikiel handles those personally).
- Keep replies to 1–4 short sentences. This is WhatsApp.
${onboardingBlock}
Respond with ONLY a JSON object (no markdown, no prose):
{
  "action": "auto" | "escalate" | "report" | "import" | "intake"${prospect ? ' | "media" | "optout"' : ''},
  "reply": "message to the owner; leave \\"\\" when action is report, import or intake",
  "report_slug": null | "one of their listing slugs",
  "import_url": null | "the Airbnb/Booking.com URL the owner sent",${prospect ? `
  "media_key": null | "agent_portal" | "branded_share" | "villa_mobile" | "network",` : ''}
  "listing": null | { "slug": null | "existing-slug", "name": "", "area": "", "unitType": "", "bedrooms": 0, "bathrooms": 0, "monthly": "", "overview": "", "photosLink": "", "icalUrl": "", "ownerEmail": "", "contactName": "", "features": [] }
}
Use "report" to fetch real numbers before answering a performance question (set report_slug, leave reply ""). Use "import" to read an Airbnb/Booking.com page the owner linked (set import_url, leave reply ""). Use "intake" once you have enough to create or update a listing (set listing, leave reply ""). ${prospect ? 'Use "media" to send one curated image (set media_key AND a short caption in reply). Use "optout" if they clearly want to be left alone. ' : ''}Otherwise use "auto" (a normal reply) or "escalate".`;

  const messages = [{ role: 'user', content: `The owner just sent: "${inbound}"\n\nRecent thread (oldest → newest):\n${thread || '(no prior messages)'}` }];
  let llmCalls = 0, costUsd = 0;
  const MAX = 3;
  try {
    for (let hop = 0; hop < MAX; hop++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        // 2500 (was 700): intake turns carry a whole listing object, and a
        // truncated one is now a hard failure rather than a garbled draft.
        body: JSON.stringify(deepWellFormed({ model: 'claude-sonnet-4-6', max_tokens: 2500, system, messages })),
      });
      llmCalls++;
      const data = await res.json();
      if (!res.ok || data.type === 'error') {
        return { action: 'escalate', reply: '', error: data?.error?.message || `HTTP ${res.status}`, llm_calls: llmCalls, cost_usd: costUsd };
      }
      costUsd += data.usage ? costOfUsage(data.usage) : FALLBACK_COST_PER_REPLY_USD;
      // Truncated / non-JSON output is a generation failure (loud marker via
      // ai.error), never a draft — same rule as the agent path.
      const { parsed, raw, error: parseErr } = parseReplyJson(data);
      if (parseErr) {
        console.warn('owner generateReply unusable output:', parseErr);
        return { action: 'escalate', reply: '', error: parseErr, llm_calls: llmCalls, cost_usd: costUsd };
      }

      if (parsed.action === 'report' && parsed.report_slug && hop < MAX - 1) {
        const summary = await fetchOwnerReportSummary(parsed.report_slug, secret);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Performance data for ${parsed.report_slug}:\n${summary}\n\nNow reply to the owner in plain, friendly language with the key numbers (JSON, action "auto").` });
        continue;
      }
      if (parsed.action === 'import' && parsed.import_url && hop < MAX - 1) {
        const imported = await importOwnerListingPage(parsed.import_url, secret);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Imported from ${parsed.import_url}:\n${imported}\n\nUse this to FILL GAPS only — anything the owner told you directly wins. Where a number here disagrees with what they said, ask them which is right rather than choosing. Reply to the owner (JSON, action "auto"), or go straight to "intake" if you now have enough.` });
        continue;
      }
      if (parsed.action === 'intake' && parsed.listing && hop < MAX - 1) {
        // Reuse a slug we already know for this owner when Maya omits one —
        // otherwise a second intake creates a second listing.
        const listing = { ...parsed.listing };
        if (!listing.slug && listingSlugs.length === 1) listing.slug = listingSlugs[0];
        const result = await submitOwnerIntake(owner, listing, secret);
        if (result.ok && db) {
          // Persist the slug on the owner row. Previously listing_slugs was
          // only ever written by lib/rental-sync.js AFTER Ikiel approved in
          // admin, so until then Maya had no slug and every follow-up intake
          // created a fresh listing — 15 duplicate "Casa Suhana" records in
          // one conversation (16 Aug 2026).
          const merged = Array.from(new Set([...listingSlugs, result.slug].filter(Boolean)));
          const fields = { listing_slugs: merged };
          if (isProspect(owner)) fields.onboarding_status = 'listed'; // funnel complete
          // Remember the portal email so later listings link themselves too,
          // and so Maya stops asking for something she already has.
          if (result.email && result.email !== owner.email) {
            fields.email = result.email;
            owner = { ...owner, email: result.email };
          }
          await fetch(`${db.SUPABASE_URL}/rest/v1/owners?id=eq.${owner.id}`, {
            method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(fields),
          }).catch(() => {});
          listingSlugs = merged;
        }
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Listing submission result: ${result.message}\n\nNow confirm to the owner in one friendly sentence (JSON, action "auto"). If it succeeded, tell them it's gone to Ikiel for review and will appear once approved. If the note above says a calendar is missing or was rejected, ask for the iCal export URL in the same message.` });
        continue;
      }
      if (parsed.action === 'media' && parsed.media_key && ONBOARD_MEDIA[parsed.media_key]) {
        return { action: 'media', media_key: parsed.media_key, reply: parsed.reply || ONBOARD_MEDIA[parsed.media_key].caption, llm_calls: llmCalls, cost_usd: costUsd };
      }
      if (parsed.action === 'optout') {
        return { action: 'optout', reply: parsed.reply || '', llm_calls: llmCalls, cost_usd: costUsd };
      }
      return { action: parsed.action === 'auto' ? 'auto' : 'escalate', reply: parsed.reply || '', llm_calls: llmCalls, cost_usd: costUsd };
    }
    return { action: 'escalate', reply: '', llm_calls: llmCalls, cost_usd: costUsd };
  } catch (e) {
    return { action: 'escalate', reply: '', error: e.message || 'generateOwnerReply threw', llm_calls: llmCalls, cost_usd: costUsd };
  }
}

// Fetch a listing's report from the portal (service secret) and compress it to
// a few lines Maya can turn into a friendly WhatsApp answer.
async function fetchOwnerReportSummary(slug, secret) {
  try {
    const r = await fetch(`${PORTAL_BASE}/api/portal?action=report&slug=${encodeURIComponent(slug)}`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!r.ok) return `(could not load report: HTTP ${r.status})`;
    const d = await r.json();
    const mx = d.metrics || {};
    const line = (label, o) => `${label}: ${o?.now ?? 0} this week (was ${o?.prev ?? 0} last week)`;
    const occ = d.occupancy
      ? `Occupancy next 30 nights: ${d.occupancy.pct}% (${d.occupancy.bookedNights} booked, ${d.occupancy.openNights} open)${d.occupancy.openWindows?.[0] ? `; open gap of ${d.occupancy.openWindows[0].nights} nights from ${d.occupancy.openWindows[0].from}` : ''}`
      : 'Occupancy: no availability calendar connected';
    const bench = d.benchmark?.percentile != null ? `Benchmark: ${d.benchmark.percentile}th percentile of ${d.benchmark.peerCount} active listings` : '';
    return [
      `Villa: ${d.name}${d.area ? ` (${d.area})` : ''}`,
      line('Listing views', mx.views),
      line('Enquiries', mx.enquiries),
      `Agents reached: ${d.agentsReached?.now ?? 0} this week (was ${d.agentsReached?.prev ?? 0})`,
      line('Photo views', mx.photoViews),
      occ, bench,
    ].filter(Boolean).join('\n');
  } catch (e) {
    return `(report fetch failed: ${e.message})`;
  }
}

// Submit a Maya-collected listing to the portal intake endpoint (service secret).
// Only accept a URL that is actually an exported iCal feed. Maya has invented
// plausible-looking Airbnb .ics URLs from a room link before (16 Aug 2026),
// which silently gives a villa a calendar that never resolves — worse than no
// calendar, because nobody notices. A real Airbnb export always carries the
// per-calendar secret (?s=<hex>); without it the URL is a guess.
export function sanitizeIcalUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  if (!/\.ics(\?|$)|\/ical\//i.test(u)) return '';           // a listing page, not a feed
  if (/airbnb\./i.test(u) && !/[?&]s=[0-9a-f]{16,}/i.test(u)) return '';
  return u;
}

// The portal renders monthly rent as "<value>/mo", so a value that already
// carries its own period reads as "IDR 40.000.000/month / month" on the live
// listing (16 Aug 2026). Strip the suffix and normalise the common ways an
// owner writes 40 million rupiah down to the portal's own "40jt".
export function normalizeMonthly(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s*(?:\/|per\s+)\s*(?:month|mo|bulan)\.?$/i, '').trim();
  const m = s.match(/^(?:idr|rp)?\s*([\d.,]+)\s*(jt|juta|m|mil|million)?$/i);
  if (m) {
    const digits = m[1].replace(/[.,]/g, '');
    const unit = (m[2] || '').toLowerCase();
    const jt = unit ? parseFloat(m[1].replace(/[.,]/g, '.')) : (digits.length >= 7 ? parseInt(digits, 10) / 1e6 : null);
    if (jt && Number.isFinite(jt)) return `${Number.isInteger(jt) ? jt : jt.toFixed(1)}jt`;
  }
  return s;
}

// Read an owner's public Airbnb/Booking.com page through the portal's own
// scraper (one extraction path, not a second copy of it here) and flatten the
// result into a few lines Maya can reason over. Never applied automatically:
// on Casa Suhana the page said 2 bedrooms where the owner had said 3, so the
// caller is instructed to treat this as suggestions and query conflicts.
async function importOwnerListingPage(url, secret) {
  try {
    const r = await fetch(`${PORTAL_BASE}/api/portal?action=import-listing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify({ url }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return `import failed: ${d.error || `HTTP ${r.status}`}`;
    const f = d.fields || d;
    const lines = [
      f.name && `page title: ${f.name}`,
      f.area && `area: ${f.area}`,
      f.unitType && `type: ${f.unitType}`,
      f.bedrooms != null && `bedrooms on the page: ${f.bedrooms}`,
      f.bathrooms != null && `bathrooms on the page: ${f.bathrooms}`,
      f.overview && `description: ${f.overview}`,
      Array.isArray(f.features) && f.features.length && `amenities: ${f.features.join(', ')}`,
      Array.isArray(f.photos) && f.photos.length && `${f.photos.length} photos are on the page (already-sent WhatsApp photos are what we use — do not ask them to re-send)`,
    ].filter(Boolean);
    return lines.length ? lines.join('\n') : 'the page gave nothing usable — ask the owner directly';
  } catch (e) {
    return `import failed: ${e.message}`;
  }
}

// A listing is bound to a portal account purely by email: the portal's
// claimByEmail links it the first time that Google address signs in. So the
// address Maya records IS the linking key — validate it rather than writing
// through whatever she heard over a voice note.
export function sanitizeOwnerEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@,]+\.[a-z]{2,}$/.test(s) ? s : '';
}

async function submitOwnerIntake(owner, listing, secret) {
  const ical = sanitizeIcalUrl(listing.icalUrl);
  const icalRejected = !!String(listing.icalUrl || '').trim() && !ical;
  const email = sanitizeOwnerEmail(listing.ownerEmail) || sanitizeOwnerEmail(owner.email);
  try {
    const data = {
      name: listing.name, area: listing.area, tag: listing.area, unitType: listing.unitType,
      bedrooms: listing.bedrooms, bathrooms: listing.bathrooms, monthly: normalizeMonthly(listing.monthly),
      overview: listing.overview, photosLink: listing.photosLink, icalUrl: ical,
      features: Array.isArray(listing.features) ? listing.features.join('\n') : (listing.features || ''),
    };
    const r = await fetch(`${PORTAL_BASE}/api/portal?action=intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      // The owner's number IS the listing's enquiry contact — agents tap
      // "Visit" to arrange a viewing with whoever runs the villa. What it also
      // needs is a NAME: every admin-entered listing shows one (Ariani, Vira,
      // Era…), and Casa Suhana went live as a bare number because Maya had
      // never been asked to collect one.
      body: JSON.stringify({
        slug: listing.slug || '', waNumber: owner.wa_num, ownerEmail: email,
        waContactName: String(listing.contactName || owner.name || '').trim(),
        data,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, slug: '', email, message: `failed: ${d.error || `HTTP ${r.status}`}` };
    const thin = !String(listing.overview || '').trim()
      || (Array.isArray(listing.features) ? listing.features.length : 0) < 2;
    const notes = [
      `success: "${d.name}" saved as ${d.status} (slug ${d.slug})`,
      `Use slug "${d.slug}" for every future change to this villa — never submit it again without the slug or you will create a duplicate listing.`,
      icalRejected
        ? 'NOTE: the calendar link was rejected because it is not a real iCal export — ask the owner to send the proper export URL and do not guess one.'
        : (ical ? '' : 'NOTE: this villa still has no availability calendar — ask the owner for their iCal export URL.'),
      thin ? 'NOTE: the listing has little or no description — ask the owner what kind of guest it suits and what stands out, then submit again with the slug.' : '',
      email
        ? `NOTE: it is linked to ${email} — tell them to sign in at ${PORTAL_BASE}/portal with that exact Google address to see it.`
        : 'NOTE: no portal email yet, so the owner cannot open their own listing — ask which Google address they want to sign in with.',
    ].filter(Boolean);
    return { ok: true, slug: d.slug || '', email, message: notes.join(' ') };
  } catch (e) {
    return { ok: false, slug: '', message: `failed: ${e.message}` };
  }
}

// True when a DIFFERENT inbound message with a later timestamp already exists
// on this OWNER thread — i.e. the one we're processing has been superseded.
// The owner-side twin of hasNewerInbound, and the same tie-break rule: on equal
// timestamps the wa_message_id string decides, so exactly ONE of a set of
// concurrent invocations proceeds (all skipping would mean no reply at all).
// WhatsApp timestamps are second-precision and a photo burst lands dozens of
// messages inside one second, so ties are the norm here, not the exception.
async function hasNewerOwnerInbound(url, headers, ownerId, ownTimestamp, ownWaMessageId) {
  if (!ownWaMessageId) return false; // can't tie-break safely — always reply
  try {
    const r = await fetch(`${url}/rest/v1/wa_messages?owner_id=eq.${ownerId}&direction=eq.inbound&order=timestamp.desc,wa_message_id.desc&limit=1&select=wa_message_id,timestamp`, { headers });
    const latest = (await r.json())?.[0];
    if (!latest || !latest.wa_message_id || latest.wa_message_id === ownWaMessageId) return false;
    // Epoch-ms compare: Supabase serialises timestamptz as "+00:00" while ours
    // are "Z"-suffixed, so string comparison would misorder them.
    const latestT = new Date(latest.timestamp).getTime();
    const ownT = new Date(ownTimestamp).getTime();
    if (latestT > ownT) return true;
    return latestT === ownT && String(latest.wa_message_id) > String(ownWaMessageId);
  } catch (_) { return false; }
}

// Get-or-create the owner's Drive photo folder without racing.
//
// Concurrent invocations all read owner.drive_folder_id as null, so a plain
// "if empty, create" hands every one of them a fresh folder. Instead we take a
// claim on the row FIRST — a PATCH conditional on drive_folder_id still being
// null, which Postgres serialises — and only the winner creates a folder. The
// losers poll for the winner's id. The claim ticket is written into the same
// column so there is no schema change and no second source of truth.
async function claimOwnerDriveFolder({ url, headers, owner, label }) {
  const real = (v) => v && !String(v).startsWith('pending:');
  if (real(owner.drive_folder_id)) return owner.drive_folder_id;

  const ticket = `pending:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let won = false;
  try {
    const claim = await fetch(`${url}/rest/v1/owners?id=eq.${owner.id}&drive_folder_id=is.null`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ drive_folder_id: ticket }),
    });
    won = claim.ok && (await claim.json())?.[0]?.drive_folder_id === ticket;
  } catch (_) { won = false; }

  if (won) {
    let folderId;
    try {
      folderId = await createOwnerFolder(label);
    } catch (e) {
      // Release the claim, otherwise this owner can never get a folder again.
      await fetch(`${url}/rest/v1/owners?id=eq.${owner.id}&drive_folder_id=eq.${encodeURIComponent(ticket)}`, {
        method: 'PATCH', headers, body: JSON.stringify({ drive_folder_id: null }),
      }).catch(() => {});
      throw e;
    }
    await fetch(`${url}/rest/v1/owners?id=eq.${owner.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ drive_folder_id: folderId }),
    });
    return folderId;
  }

  // Someone else is creating it (or already did) — wait for their write.
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch(`${url}/rest/v1/owners?id=eq.${owner.id}&select=drive_folder_id`, { headers });
      const cur = (await r.json())?.[0]?.drive_folder_id;
      if (real(cur)) return cur;
    } catch (_) { /* keep waiting */ }
  }
  throw new Error('timed out waiting for the villa photo folder');
}

async function fetchOwnerThread(url, headers, ownerId) {
  try {
    // Pull a WIDE window, then collapse runs of photos into a single line.
    // With a flat 30-message limit a 27-photo burst filled the entire window
    // with "[Image]" rows and pushed the villa's name, area and price out of
    // Maya's context — she then asked the owner for details they had already
    // given (16 Aug 2026). Collapsing keeps a burst to one line, so the real
    // conversation survives it.
    const r = await fetch(`${url}/rest/v1/wa_messages?owner_id=eq.${ownerId}&order=timestamp.desc&limit=200&select=direction,content,timestamp`, { headers });
    if (!r.ok) return '';
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return '';
    rows.reverse();

    const lines = [];
    let run = null; // an unbroken run of photo-only messages from one side
    const flush = () => {
      if (!run) return;
      lines.push(`[${run.time}] ${run.who}: [sent ${run.n} photo${run.n === 1 ? '' : 's'}]`);
      run = null;
    };
    for (const m of rows) {
      const t = new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
      const who = m.direction === 'outbound' ? 'Maya' : 'Owner';
      const body = humanizeMarker(m.content || '');
      if (/^\[Image\]\s*$/i.test(body)) {
        if (run && run.who === who) run.n++;
        else { flush(); run = { who, time: t, n: 1 }; }
        continue;
      }
      flush();
      lines.push(`[${t}] ${who}: ${body.slice(0, 200)}`);
    }
    flush();
    return lines.slice(-30).join('\n');
  } catch { return ''; }
}

async function logOutboundOwner(url, headers, ownerId, waNum, content, waMessageId = null) {
  await fetch(`${url}/rest/v1/wa_messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      owner_id: ownerId, wa_num: waNum, direction: 'outbound',
      content, timestamp: new Date().toISOString(), source: 'api',
      status: 'sent', wa_message_id: waMessageId,
    }),
  }).catch(e => console.warn('logOutboundOwner failed:', e.message));
}

async function patchOwner(url, headers, ownerId, patch) {
  await fetch(`${url}/rest/v1/owners?id=eq.${ownerId}`, {
    method: 'PATCH', headers, body: JSON.stringify(patch),
  }).catch(e => console.warn('patchOwner failed:', e.message));
}

// ── Web-standard entry point ──────────────────────────────────────────────
// Vercel's (req, res) helpers consume the body before the handler runs, which
// makes X-Hub-Signature-256 verification impossible. The Web signature hands
// us the Request intact; this adapter gives nodeHandler the same `req`/`res`
// shape it has always used, plus `req.rawBody` for the signature check.
function makeRes() {
  const r = { _status: 200, _headers: {}, _body: null, _type: null };
  r.status = (c) => { r._status = c; return r; };
  r.setHeader = (k, v) => { r._headers[k] = v; return r; };
  r.json = (o) => { r._body = JSON.stringify(o); r._type = 'application/json'; return r; };
  r.send = (b) => { r._body = b == null ? '' : (typeof b === 'string' ? b : String(b)); r._type = r._type || 'text/plain'; return r; };
  r.end = (b) => { if (b != null) r._body = String(b); return r; };
  r.toResponse = () => new Response(r._body, { status: r._status, headers: { ...(r._type ? { 'content-type': r._type } : {}), ...r._headers } });
  return r;
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    const rawBody = request.method === 'POST' ? await request.text() : '';
    const req = {
      method: request.method, url: request.url, query, headers, rawBody,
      get body() { return rawBody ? JSON.parse(rawBody) : undefined; },
    };
    const res = makeRes();
    try {
      await nodeHandler(req, res);
    } catch (e) {
      console.error('webhook adapter: handler threw', e);
      if (res._body == null) res.status(500).json({ error: e.message });
    }
    return res.toResponse();
  },
};
