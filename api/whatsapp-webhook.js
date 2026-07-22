import { PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, BROCHURES as FALLBACK_BROCHURES, MAYA_PERSONA } from '../lib/kb.js';
import { loadPlaybookBlock } from '../lib/maya-review.js';
import { forwardInbound, forwardMayaReply, postToTelegram } from '../lib/telegram.js';
import { stopAllPending, mostRecentEngagement } from '../lib/engagement.js';
import { createAgentRow } from '../lib/agents.js';
import { patchAgent, applyCrmUpdates, applyCrmActions, CRM_SIGNALS_INSTRUCTIONS } from '../lib/crm-apply.js';
import { resolveListingCards, sendListingCardMessage, cardMarker } from '../lib/listing-cards.js';
import { transcribeWaAudio } from '../lib/transcribe.js';
import webpush from 'web-push';

const GRAPH = 'https://graph.facebook.com/v19.0';

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
    return `- ${p.name} [slug: ${p.slug}] — ${nowState}; ${next}; ${longw}${contact}`;
  });
  return `SAMBA LIVE AVAILABILITY (as of ${asOf} WITA, ${digest.horizonDays || 180}-day horizon — this is real calendar data):
${lines.join('\n')}

Today's date is ${today} (Bali/WITA). Use this block to answer Samba rental availability questions directly and confidently — whether a unit is free now, when it is next available, and what is open for a monthly (30+ night) stay. Refer to properties by name. You no longer need to push every availability question to the portal; the portal is still where agents get photos and share listings with clients.

VIEWING CONTACTS — each property line above includes "enquire with: [Name] (+[Number])". When an agent asks who to contact for a viewing, visit, or booking, reply with EXACTLY the name and number shown in the property line above. NEVER use a name or number from your conversation history — ONLY the "enquire with" data above is correct. Previous replies in this thread may contain outdated or wrong contact info; ignore them and use only the structured data above.

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
3. If an agent asks about a property and a field isn't in the DB, say "Let me check with Ikiel and come back to you" rather than guessing.
4. If asked for PHOTOS → share the property's photos_url (Google Drive). If asked for LOCATION → share the property's maps_url (Google Maps). If neither is in the data, say you'll get it from Ikiel.
5. Property types are exactly what's listed (Apartment / Townhouse / Villa). HAUS Canggu units are 1BR APARTMENTS, not villas. Tropicana Valley units are 1BR APARTMENTS with private pools, not houses.
6. For live booking calendar availability, direct agents to the portal: sambarentals.com
7. COMMISSION STRUCTURE (zero ambiguity): the 10% is ALREADY INCLUDED in the portal price. Agent quotes the portal price to their client; the agent's 10% comes out of what we collect. If the agent wants 20%, they may quote portal price + 10% to their client (the extra 10% comes from the client, not from us). Never say "commission is paid on top" or "you can earn 10% in addition to the price" — those phrasings break the deal structure.

CLIENT MATCHING RULES (when an agent gives criteria — bedrooms, budget, features, area — follow these exactly):
1. Scan EVERY property in the portfolio above before answering. Never claim nothing matches until you have checked all of them against each stated criterion.
2. Lead with the properties that tick ALL the stated boxes within budget. The closest full match ALWAYS comes first in your reply — this is the agent's actual request; alternatives never displace it.
3. After the full matches, you may add one or two near-miss options (slightly over budget, or missing one feature) clearly framed as such ("a bit above budget at 35jt/mo, but..."). Rates are often negotiable so near-budget options are worth surfacing — but only AFTER the exact matches, never instead of them.
4. AVAILABILITY: if the agent did NOT name dates, a property that fits the criteria still counts as a match even if it is occupied now or booked soon — recommend it and note when it is next free (from the live availability data). Only rule a match out on availability when the agent gave specific dates and the calendar conflicts.
5. Budget phrasing like "27 mil" / "27jt" / "27 juta" means IDR 27,000,000 per month.`;
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
const SONNET_INPUT_USD_PER_TOK = 3 / 1e6;
const SONNET_OUTPUT_USD_PER_TOK = 15 / 1e6;
const SONNET_CACHE_READ_USD_PER_TOK = 0.30 / 1e6;
const SONNET_CACHE_WRITE_USD_PER_TOK = 3.75 / 1e6;

// Fallback per-reply charge if the API response carries no usage block (e.g.
// an HTTP error before token accounting). Deliberately conservative.
const FALLBACK_COST_PER_REPLY_USD = 0.02;

// Real dollar cost of one Anthropic `usage` object.
function costOfUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) * SONNET_INPUT_USD_PER_TOK
    + (u.output_tokens || 0) * SONNET_OUTPUT_USD_PER_TOK
    + (u.cache_read_input_tokens || 0) * SONNET_CACHE_READ_USD_PER_TOK
    + (u.cache_creation_input_tokens || 0) * SONNET_CACHE_WRITE_USD_PER_TOK;
}

export default async function handler(req, res) {
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

  try {
    const body = req.body;
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
          await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(st.id)}`, {
            method: 'PATCH', headers: sh, body: JSON.stringify({ status: st.status })
          }).catch(() => {});
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
    let text = extracted.textForClaude;       // what Maya sees as the inbound prompt
    let dbContent = extracted.dbContent;      // what gets stored in wa_messages.content
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

    // Find matching agent
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${fromNum}&select=*`,
      { headers: sbHeaders }
    );
    const agent = (await agentRes.json())?.[0];

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
          `${SUPABASE_URL}/rest/v1/owners?wa_num=eq.${fromNum}&select=id,name&limit=1`,
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
      title: agent?.name || agent?.agency || ('+' + fromNum),
      body: (dbContent || text || 'New message').slice(0, 160),
      agentId: agent ? agent.id : null,
      badgeCount: (agent?.unread_count || 0) + 1,
    }).catch(() => {});

    // ── OWNER-MODE BRANCH ────────────────────────────────────────────
    // A villa owner/manager (matched by their listing's WhatsApp contact) who
    // is NOT also an agent: Maya handles this in owner-mode and we return,
    // leaving the entire agent pipeline below untouched. Someone who is both an
    // agent and an owner stays in the agent flow (zero regression) — dual-role
    // routing is refined later. `owner` is only ever set when OWNERS_ENABLED is
    // on, so this whole branch is dormant until then.
    if (owner && !agent) {
      try {
        await handleOwnerConversation({
          SUPABASE_URL, sbHeaders, owner, fromNum,
          inbound: text, timestamp, WA_TOKEN, WA_PHONE_ID, ANTHROPIC_KEY,
        });
      } catch (e) {
        console.error('owner-mode error:', e.message);
      }
      return res.status(200).end();
    }

    if (!agent) {
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
      } catch (e) { console.warn('new-agent welcome failed:', e.message); }
      return res.status(200).end();
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

    // STOP CAMPAIGN SEQUENCES — any inbound message stops ALL active sequences
    // for this agent (across both KAYA and Samba pipelines). The conversation
    // is now live; proactive follow-ups should pause regardless of pipeline.
    const stopResult = stopAllPending(agent.campaign_engagement, timestamp);
    if (stopResult.changed) {
      patch.campaign_engagement = stopResult.value;
    }

    // OPT-OUT DETECTION — intercept stop/unsubscribe before Maya sees the message.
    // Sets samba_alerts_opt_out, marks samba engagement as 'unsubscribed', sends
    // a brief confirmation, and short-circuits (no Claude call).
    const OPT_OUT_RE = /^(stop|unsubscribe|please stop|remove me|don'?t contact|opt out|berhenti)$/i;
    if (text && OPT_OUT_RE.test(text.trim())) {
      patch.samba_alerts_opt_out = true;
      const eng = { ...(agent.campaign_engagement || {}) };
      if (eng.samba) {
        eng.samba = { ...eng.samba, status: 'unsubscribed', status_updated_at: timestamp };
      }
      patch.campaign_engagement = eng;
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);

      const confirmText = 'Noted — you\'ve been removed from availability updates. If you ever want to re-subscribe, just let me know.';
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
          reason: 'Agent sent opt-out keyword',
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
    if (await hasNewerInbound(SUPABASE_URL, sbHeaders, agent.id, timestamp, waMessageId)) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // Generate a reply with Claude — load live project + rental data from DB first
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
    const draftCardsSuffix = cardSlugs.length ? `\n[[send-cards:${cardSlugs.join(',')}]]` : '';

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
      const replyMid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, aiResult.reply, buttons);
      const buttonsNote = buttons.length ? `\n[Buttons: ${buttons.join(' | ')}]` : '';
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, aiResult.reply + buttonsNote, replyMid);
      // Mirror Maya's reply to Telegram so Ikiel sees the full conversation
      forwardMayaReply(agent, aiResult.reply).catch(() => {});

      // Send brochure if Claude requested one (use live brochure map from DB)
      // Dedup: skip if the same filename was sent in the last 14 days (e.g. via campaign attachment).
      const doc = aiResult.send_doc && liveBrochures[aiResult.send_doc];
      if (doc && doc.url) {
        const recentlySent = await wasDocRecentlySent(SUPABASE_URL, sbHeaders, agent.id, doc.filename, 14);
        if (!recentlySent) {
          await sendDocument(WA_PHONE_ID, WA_TOKEN, fromNum, doc.url, doc.filename);
          await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, `[Document: ${doc.filename}]`);
        } else {
          console.log(`Skipping ${doc.filename} — already sent in last 14 days`);
        }
      }
      // Send rich listing cards for every property Maya referenced — cover
      // photo + native "View listing" button, one card per property.
      if (cardSlugs.length) {
        try {
          const cards = await resolveListingCards(cardSlugs, 4);
          for (const card of cards) {
            const sent = await sendListingCardMessage({ PHONE_ID: WA_PHONE_ID, TOKEN: WA_TOKEN }, fromNum, card);
            if (sent.waMessageId) {
              await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, cardMarker(card), sent.waMessageId, 'listing_card');
            } else {
              console.warn('listing card send failed:', card.slug, sent.error);
            }
          }
        } catch (e) { console.warn('listing cards failed:', e.message); }
      }
      // Native contact card for viewing handoffs ("who do I contact?") —
      // tappable, saves straight to the agent's phone.
      const contact = aiResult.send_contact;
      if (contact && contact.phone && contact.phone.length >= 9 && contact.phone.length <= 15) {
        const contactMid = await sendContactCard(WA_PHONE_ID, WA_TOKEN, fromNum, contact.name, contact.phone);
        if (contactMid) {
          await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, `[Contact card: ${contact.name} — +${contact.phone}]`, contactMid);
        }
      }
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

async function logOutbound(url, headers, agentId, waNum, content, waMessageId = null, category = null) {
  const ts = new Date().toISOString();
  await fetch(`${url}/rest/v1/wa_messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      agent_id: agentId, wa_num: waNum, direction: 'outbound',
      content, timestamp: ts, source: 'api',
      // category feeds comms_metrics' read-rate-by-format breakdown
      // (e.g. 'listing_card' vs free-text vs template sends).
      category,
      // Baseline status + the id so delivered/read events can be matched.
      status: 'sent', wa_message_id: waMessageId
    })
  }).catch(e => console.warn('logOutbound failed:', e.message));

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
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
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
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
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
async function sendTextWithButtons(phoneId, token, to, text, buttons) {
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

async function generateReply(apiKey, agent, inbound, mode, portfolioContext, brochures, recentThread, rentalsContext, campaignContext, rentalSlugs = [], availabilityContext = '', inboundImage = null, playbookBlock = '') {
  const brochureMap = brochures || FALLBACK_BROCHURES;
  const portfolio = portfolioContext || FALLBACK_PORTFOLIO;
  const brochureKeys = Object.keys(brochureMap).join(', ');
  const isHybrid = mode === 'hybrid';

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

DATA PRIORITY RULES (critical — read carefully):
1. The structured "Units:" list under each project is the AUTHORITATIVE record of what is available, sold, reserved, or coming soon. Trust the per-unit availability tag (-- SOLD, -- RESERVED, -- COMING SOON) over any other text.
2. When quoting prices: only quote prices from units that are NOT marked SOLD/RESERVED. Never quote a sold unit's price as if it's available.
3. When counting availability: count units WITHOUT a SOLD/RESERVED/COMING SOON tag. Do not parrot a number from "Notes for Maya" if it conflicts with the actual unit count.
4. The "Notes for Maya" line is supplementary context (tone, positioning, edge-case framing). It is NOT the source of truth for prices, availability counts, or unit specs. If notes conflict with structured fields, the structured fields win.
5. Brochure URLs, commission %, status, delivery date, payment plan — also authoritative as written in the structured fields.
6. The "Extended details (from brochure)" block is supplementary information pulled from the project's sales brochure. Use it for questions that aren't covered by structured fields (architects, builder/contractor, design philosophy, materials, construction methodology, amenity rationale, etc.). Quote it freely when relevant.
7. If a field is empty AND there's nothing in extended_info that covers the question, do not guess or fill in from memory. Say "Let me check with Ikiel and come back to you."

TEMPLATE CONTEXT (what the approved outbound templates say, so you understand replies to them):
- [Template: kaya_intro] = "Hi {name}, I'm reaching out from KAYA Developments Listings Team to make sure agents have up-to-date info on our current projects and properties. Can I send you the latest info?"
- [Template: samba_intro] = "Hi {name}, I'm reaching out from Samba Realty Listings to make sure agents have up-to-date info on our current rentals. Can I send you the latest info?"

When an agent replies with a short affirmative (Yes / Yes please / Sure / Please / Go ahead / Ok) after one of these templates, they are saying yes to receiving the info. Respond IMMEDIATELY with the info — do NOT ask "which project?" or "what area?" first.

If they said yes to kaya_intro: send a concise overview of all active KAYA SALES projects — one short line each (name, location, price range, headline feature). Then invite them to go deeper on whichever interests them.

If they said yes to samba_intro: send a concise overview of all SAMBA RENTAL property groups (HAUS Canggu, LaneHAUS, Villa Saturno, Tropicana Valley) — one short line each (location, type, headline rate). Then in a SECOND short paragraph, surface the agent portal:

  "All availability, listing photos, and rental details are live at https://sambarentals.com — agents can download photos to share with clients directly, see real-time calendar availability, and use the WhatsApp shortcut to send the listing straight to a client. Happy to answer questions about any specific property too."

Always include the portal link with that explanation on the FIRST Samba response after samba_intro. On subsequent Samba responses you don't need to repeat the explanation — just refer to "the portal" if relevant.`;

  const systemRest = `This conversation's context:
Agent name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}
${threadBlock}
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
  "action": "auto" | "escalate" | "need_availability",
  "reply": "the message to send to the agent (1-4 sentences typical); leave "" when action is need_availability",
  "availability_query": null | { "slug": "<samba property slug>", "check_in": "YYYY-MM-DD", "check_out": "YYYY-MM-DD" },
  "send_doc": null | one of [${brochureKeys}],
  "send_cards": [] | up to 4 Samba rental slugs, e.g. ["villa_umah_astanine", "haus_4"] — valid slugs: [${rentalSlugs.join(', ') || '(none available)'}],
  "send_contact": null | { "name": "Era", "phone": "6281246357778" },
  "reply_buttons": [] | up to 3 short tap options (max 20 chars each), e.g. ["More options", "Download photos"],
  "crm_updates": [
    { "field": "projects.Sabit House.status", "value": "Listed", "reason": "agent confirmed listing" }
  ],
  "crm_actions": [
    { "type": "create_agent", "name": "Hikam", "wa_num": "6281234567890", "reason": "referred by this agent", "service_type": "rental", "replace": false }
  ]
}
Use "need_availability" ONLY to check a specific date range for a Samba rental, per the SAMBA LIVE AVAILABILITY instructions above — set "availability_query" and leave "reply" empty; the system handles the lookup and re-prompts you. For all other messages use "auto" or "escalate".
${isHybrid
  ? `Set "action" to "auto" ONLY if the message is a simple, factual question you can answer with full confidence from the portfolio knowledge (e.g. commission %, price, availability, sending a brochure). For anything involving negotiation, scheduling, complaints, commitments, or ambiguity, set "action" to "escalate" (Ikiel will review your draft before it sends).`
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
Set "crm_updates" to an empty array if no clear pipeline signals are present.
Set "crm_actions" to an empty array unless the TEAM HANDOFF rules above apply.`;

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
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          system,
          messages,
        })
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
      costUsd += data.usage ? costOfUsage(data.usage) : FALLBACK_COST_PER_REPLY_USD;
      const raw = data.content?.[0]?.text || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: 'escalate', reply: raw.trim(), send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls, cost_usd: costUsd };
      }
      const parsed = JSON.parse(jsonMatch[0]);

      // Maya wants a live calendar check for a specific range — do it, then
      // feed the result back for a final reply. Only on the first hop.
      if (parsed.action === 'need_availability' && parsed.availability_query && hop < MAX_LLM_CALLS - 1) {
        const result = await checkPortalAvailability(parsed.availability_query);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Live calendar result: ${result}\n\nNow reply to the agent with a final JSON response (action "auto" or "escalate"). Quote the dates and be specific. If not available, mention the next free option if helpful.` });
        continue;
      }

      return {
        action: parsed.action === 'auto' ? 'auto' : 'escalate',
        reply: parsed.reply || '',
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
        llm_calls: llmCalls,
        cost_usd: costUsd,
      };
    }
    // Exhausted hops without a terminal reply (e.g. Maya asked for availability
    // twice) — escalate so a human picks it up rather than sending nothing.
    return { action: 'escalate', reply: '', send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls, cost_usd: costUsd };
  } catch (err) {
    console.warn('generateReply failed:', err.message);
    return { action: 'escalate', reply: '', error: err.message || 'generateReply threw', send_doc: null, send_cards: [], send_contact: null, reply_buttons: [], crm_updates: [], llm_calls: llmCalls || 1, cost_usd: costUsd };
  }
}

// ══ OWNER-MODE (villa owners/managers, distinct from sales agents) ═════════
// A completely separate reply path from generateReply. Owners get a warm,
// non-salesy Maya who can (1) report on their listing's performance and (2)
// create/update a listing from a natural conversation. Everything routes
// through the portal's service-authed endpoints; drafts/sends mirror the agent
// flow but use the owners table + owner_id-tagged messages. (PORTAL_BASE is
// declared near the top of the file, shared with the availability helpers.)

async function handleOwnerConversation({ SUPABASE_URL, sbHeaders, owner, fromNum, inbound, timestamp, WA_TOKEN, WA_PHONE_ID, ANTHROPIC_KEY }) {
  // Automation mode: global setting, with a per-owner pause override.
  let globalMode = 'draft';
  try {
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
    const sRow = (await sRes.json())?.[0];
    if (sRow?.value?.mode) globalMode = sRow.value.mode;
  } catch { /* default draft */ }
  const mode = owner.paused ? 'paused' : globalMode;

  const patch = { last_inbound_at: timestamp, unread_count: (owner.unread_count || 0) + 1 };
  if (mode === 'paused' || mode === 'off' || !ANTHROPIC_KEY) {
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }

  const thread = await fetchOwnerThread(SUPABASE_URL, sbHeaders, owner.id);
  const listingSlugs = Array.isArray(owner.listing_slugs) ? owner.listing_slugs : [];
  const ai = await generateOwnerReply(ANTHROPIC_KEY, owner, inbound, thread, listingSlugs);

  // Count the token spend against the same daily budget as agent replies.
  if (typeof ai.cost_usd === 'number' && ai.cost_usd > 0) {
    await incrementTodaySpend(SUPABASE_URL, sbHeaders, ai.cost_usd).catch(() => {});
  }

  if (ai.error) {
    patch.suggested_reply = `[Maya (owner) failed: ${ai.error} — reply manually.]`;
    await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
    return;
  }
  // Draft mode (or hybrid escalation): stage the reply for review, don't send.
  if (mode === 'draft' || (mode === 'hybrid' && ai.action === 'escalate')) {
    patch.suggested_reply = ai.reply || '';
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
    const mid = await sendTextWithButtons(WA_PHONE_ID, WA_TOKEN, fromNum, ai.reply, []);
    await logOutboundOwner(SUPABASE_URL, sbHeaders, owner.id, fromNum, ai.reply, mid);
    forwardMayaReply({ name: owner.name || ('+' + owner.wa_num), agency: 'villa owner' }, ai.reply).catch(() => {});
    patch.suggested_reply = '';
    patch.unread_count = 0;
  } else {
    patch.suggested_reply = ai.reply || '';
  }
  await patchOwner(SUPABASE_URL, sbHeaders, owner.id, patch);
}

async function generateOwnerReply(apiKey, owner, inbound, thread, listingSlugs) {
  const secret = process.env.LISTING_SYNC_SECRET;
  const ownerName = owner.name || 'there';
  const listingsLine = listingSlugs.length ? listingSlugs.join(', ') : '(none yet — this owner has not listed a villa)';

  const system = `You are Maya, listings coordinator for Samba Realty in Bali. You are messaging on WhatsApp with a villa OWNER / property manager — a partner and client, not a sales agent. Be warm, concise, first-name friendly, and never salesy.

Owner: ${ownerName}
Their current listing slugs: ${listingsLine}

WHAT YOU DO FOR OWNERS:
1. Answer questions about how their listing is performing — views, enquiries, agents reached, occupancy, this week vs last. NEVER quote numbers from memory: request a live report first (action "report" with report_slug).
2. Help them LIST a new villa or UPDATE one by gathering the details in conversation, then submitting (action "intake"). New/updated listings go to Ikiel for review before they appear publicly — always say so.
3. General help. Ikiel oversees everything and steps in when needed.

RULES:
- To create/update a listing you need at least a villa name. Area, bedrooms/bathrooms, monthly price, a Google Drive photos link, and an iCal availability calendar make it far stronger — ask for what's missing, but don't demand everything in one go.
- For anything about money owed, payouts, billing, complaints, contracts, or legal: set action "escalate" (Ikiel handles those personally).
- Keep replies to 1–4 short sentences. This is WhatsApp.

Respond with ONLY a JSON object (no markdown, no prose):
{
  "action": "auto" | "escalate" | "report" | "intake",
  "reply": "message to the owner; leave \\"\\" when action is report or intake",
  "report_slug": null | "one of their listing slugs",
  "listing": null | { "slug": null | "existing-slug", "name": "", "area": "", "unitType": "", "bedrooms": 0, "bathrooms": 0, "monthly": "", "overview": "", "photosLink": "", "icalUrl": "", "features": [] }
}
Use "report" to fetch real numbers before answering a performance question (set report_slug, leave reply ""). Use "intake" once you have enough to create or update a listing (set listing, leave reply ""). Otherwise use "auto" (a normal reply) or "escalate".`;

  const messages = [{ role: 'user', content: `The owner just sent: "${inbound}"\n\nRecent thread (oldest → newest):\n${thread || '(no prior messages)'}` }];
  let llmCalls = 0, costUsd = 0;
  const MAX = 3;
  try {
    for (let hop = 0; hop < MAX; hop++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system, messages }),
      });
      llmCalls++;
      const data = await res.json();
      if (!res.ok || data.type === 'error') {
        return { action: 'escalate', reply: '', error: data?.error?.message || `HTTP ${res.status}`, llm_calls: llmCalls, cost_usd: costUsd };
      }
      costUsd += data.usage ? costOfUsage(data.usage) : FALLBACK_COST_PER_REPLY_USD;
      const raw = data.content?.[0]?.text || '';
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return { action: 'escalate', reply: raw.trim(), llm_calls: llmCalls, cost_usd: costUsd };
      const parsed = JSON.parse(m[0]);

      if (parsed.action === 'report' && parsed.report_slug && hop < MAX - 1) {
        const summary = await fetchOwnerReportSummary(parsed.report_slug, secret);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Performance data for ${parsed.report_slug}:\n${summary}\n\nNow reply to the owner in plain, friendly language with the key numbers (JSON, action "auto").` });
        continue;
      }
      if (parsed.action === 'intake' && parsed.listing && hop < MAX - 1) {
        const result = await submitOwnerIntake(owner, parsed.listing, secret);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Listing submission result: ${result}\n\nNow confirm to the owner in one friendly sentence (JSON, action "auto"). If it succeeded, tell them it's gone to Ikiel for review and will appear once approved.` });
        continue;
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
async function submitOwnerIntake(owner, listing, secret) {
  try {
    const data = {
      name: listing.name, area: listing.area, tag: listing.area, unitType: listing.unitType,
      bedrooms: listing.bedrooms, bathrooms: listing.bathrooms, monthly: listing.monthly,
      overview: listing.overview, photosLink: listing.photosLink, icalUrl: listing.icalUrl,
      features: Array.isArray(listing.features) ? listing.features.join('\n') : (listing.features || ''),
    };
    const r = await fetch(`${PORTAL_BASE}/api/portal?action=intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify({ slug: listing.slug || '', waNumber: owner.wa_num, ownerEmail: owner.email || '', data }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return `failed: ${d.error || `HTTP ${r.status}`}`;
    return `success: "${d.name}" saved as ${d.status} (slug ${d.slug})`;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

async function fetchOwnerThread(url, headers, ownerId) {
  try {
    const r = await fetch(`${url}/rest/v1/wa_messages?owner_id=eq.${ownerId}&order=timestamp.desc&limit=30`, { headers });
    if (!r.ok) return '';
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return '';
    rows.reverse();
    return rows.map(m => {
      const t = new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
      const who = m.direction === 'outbound' ? 'Maya' : 'Owner';
      return `[${t}] ${who}: ${humanizeMarker(m.content || '').slice(0, 200)}`;
    }).join('\n');
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
