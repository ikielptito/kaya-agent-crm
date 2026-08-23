// ── OWNER ONBOARDING (prospect funnel) ──────────────────────────────
// Shared bits for Maya's villa-owner onboarding mode: the sales pitch she
// works from, the curated set of images she can send, opt-out detection,
// and the WhatsApp image-send used by both the webhook (autopilot) and
// api/supabase.js owner_send (approving a drafted image message).
//
// Funnel statuses on the owners row (owners.onboarding_status):
//   'agreed' → 'contacted' → 'in_conversation' → 'listed' | 'declined'
// null = a regular synced owner who was never a prospect.

const PORTAL_BASE = 'https://sambarentals.com';

// Statuses where Maya pitches/onboards rather than serves an existing owner.
export const PROSPECT_STATUSES = ['agreed', 'contacted', 'in_conversation'];
export const isProspect = (owner) => PROSPECT_STATUSES.includes(owner?.onboarding_status);

// Curated images Maya may send during onboarding. JPEGs hosted on the portal
// (WhatsApp image messages don't render WebP). Keys are stable — they appear
// in [image:key] markers inside drafted messages.
export const ONBOARD_MEDIA = {
  agent_portal:  { url: `${PORTAL_BASE}/wa/hiw-agent-1.jpg`,  caption: 'The agent portal — live availability for every villa, so agents never have to ask "is it still free?"' },
  branded_share: { url: `${PORTAL_BASE}/wa/hiw-agent-3.jpg`,  caption: 'Agents share your villa as a branded page with their own contact — their clients enquire, you get the booking' },
  villa_mobile:  { url: `${PORTAL_BASE}/wa/owner-portal.jpg`, caption: 'How your villa looks to agents on their phone — photos, price, live availability, one-tap enquiry' },
  network:       { url: `${PORTAL_BASE}/wa/network.jpg`,      caption: 'One listing, the whole Bali agent network — every agent brings their own clients to your villa' },
};

// A drafted image message is stored as "[image:key]\ncaption". The inbox
// approve-and-send path parses this back into a real WhatsApp image message.
export function parseImageMarker(text) {
  const m = String(text || '').match(/^\[image:([a-z_]+)\]\s*\n?([\s\S]*)$/);
  if (!m || !ONBOARD_MEDIA[m[1]]) return null;
  return { key: m[1], url: ONBOARD_MEDIA[m[1]].url, caption: (m[2] || ONBOARD_MEDIA[m[1]].caption).trim() };
}

// Hard opt-out phrases (EN + ID). Matching one flips the prospect to
// 'declined' + paused — Maya never contacts them again.
export function isOptOut(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.length > 60) return false; // opt-outs are short; don't misread a long message
  return /\b(stop|unsubscribe|berhenti|jangan (hubungi|kirim)|tidak (usah|tertarik|berminat)|not interested|leave me alone|remove me)\b/.test(t);
}

// Live agent count for the pitch — never a stale hardcoded number. Rounds
// DOWN to the nearest 10 and presents as "N+". Falls back to the portal's
// public claim if the query fails.
export async function fetchAgentReach(SUPABASE_URL, sbHeaders) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id&is_test=eq.false&limit=1`, {
      headers: { ...sbHeaders, Prefer: 'count=exact' },
    });
    const range = r.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1], 10);
    if (Number.isFinite(total) && total >= 10) return `${Math.floor(total / 10) * 10}+`;
  } catch { /* fall through */ }
  return '300+'; // the portal's public figure — brand rule: "300+", never "250+"
}

// The system-prompt block for prospect conversations. Everything Maya is
// allowed to claim lives here — keep it in sync with sambarentals.com copy
// (for-agents.html + portal.html) so she never oversells.
export function buildOnboardingPitch({ owner, agentReach }) {
  const promo = owner.promo_code || 'PRELAUNCH90';
  const langLine = owner.lang === 'id'
    ? 'This owner prefers Bahasa Indonesia — write in natural, warm Indonesian unless they switch to English.'
    : 'Open in English; mirror their language if they reply in Indonesian.';
  return `
ONBOARDING MODE — this owner is a PROSPECT, not yet listed. Ikiel already spoke
with them personally and they verbally agreed to list their villa on Samba
Rentals (context: ${owner.consent_note || 'verbal agreement with Ikiel'}). Your
job: warmly walk them from "agreed in principle" to a live listing, ideally
right here in chat. Never pressure; you are following up on THEIR yes.
${langLine}

THE PITCH (all true today — never invent beyond this):
- Samba Rentals (sambarentals.com) puts their villa in front of ${agentReach}
  rental agents in Bali. I (Maya) also push new listings and daily availability
  updates directly to those agents on WhatsApp.
- FOR AGENTS (why agents actually use it): live availability calendars, full
  photo galleries with one-click download, beautifully branded share pages that
  carry the agent's own contact details, direct owner messaging, client
  shortlists, and an Instagram Story generator. Free for agents.
- FOR OWNERS: an owner dashboard at sambarentals.com/portal — manage the
  listing, see views/enquiries/agent interest, and get a weekly WhatsApp
  performance report from me. Availability can sync automatically from an
  Airbnb/Booking/Hostex calendar link.
- MONEY: we take ZERO commission, ever. Agents deal with the owner directly —
  we never middleman the deal. We're in pre-launch, so listing is free right
  now; at launch their code ${promo} gives 3 more months free, and after that
  it's a flat IDR 150k (~US$10) per month per villa. Cancel anytime.
- LISTING: they can do it right here in chat with you — you collect the villa
  name, area, bedrooms/bathrooms, monthly price, and they can simply send
  photos in this chat (photos are saved automatically). Or they can use the
  portal themselves. Either way Ikiel reviews before it goes live.

EXTRA ACTIONS IN ONBOARDING MODE (on top of the normal ones):
- "media": send ONE of these images when it genuinely helps the explanation
  (set media_key; put a short caption in reply): agent_portal (the agent
  portal with live availability), branded_share (how agents share their villa
  with their own branding), villa_mobile (a villa listing on an agent's
  phone), network (diagram: one villa reaching every agent + their clients).
  Never send two images in a row; at most one image every few messages.
- "optout": they clearly don't want this / asked to stop. Set reply to one
  short gracious goodbye. They will never be contacted again.

ONBOARDING RULES:
- One idea per message. Lead with what's in it for THEM, not features.
- Answer money questions with the exact numbers above; never haggle (that's
  Ikiel). If they want to negotiate anything, escalate.
- When they show intent to list ("ok how do we start", sends photos, gives
  villa details), move straight to collecting listing details — that's the
  goal of this whole conversation.
- Quote the promo code ${promo} exactly once when explaining pricing.`;
}

// Send a WhatsApp image message by URL. Returns the WA message id, or null.
export async function sendOwnerImage(phoneId, token, to, url, caption) {
  const r = await fetch(`https://graph.facebook.com/v24.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'image',
      image: { link: url, ...(caption ? { caption } : {}) },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `image send HTTP ${r.status}`);
  return d?.messages?.[0]?.id || null;
}
