// Listing completeness: Maya chases each villa's listed contact (Era for the
// villas our team manages, otherwise the owner / manager) for the key facts
// agents ask about most and the record doesn't have — deposit, electricity
// terms, wifi, pool type, minimum stay, pets. Ikiel's instruction (22 Aug
// 2026): "Maya should be trying to follow up regularly with the listed
// owner/manager to get the missing listing info."
//
// Rides on the relay machinery (lib/relay.js): one relay per contact per
// round, question prefixed with LISTING_INFO_PREFIX so the wording is "could
// you confirm…" rather than "an agent asked…", and no agent leg. The contact's
// reply is captured by the normal relay path and staged as a fact for Ikiel to
// approve — he then fills the fields in the portal admin, which is the source
// of truth the sync reads from.
//
// Cadence: one round per contact every CHASE_EVERY_DAYS, at most CHASE_MAX
// rounds per listing (then it stops and shows up in the daily briefing as
// "still missing"). State lives in settings.listing_info_chase (single daily
// writer, so the jsonb read-modify-write is safe here).

import { fetchPortalListings, dbSlug } from './rental-sync.js';
import { openRelay, LISTING_INFO_PREFIX } from './relay.js';

export const CHASE_EVERY_DAYS = 5;
// Ikiel, 25 Aug 2026: "Maya needs to keep pushing and following up with all
// the managers to fill in the missing info" — 8 rounds ≈ 6 weeks of chasing
// before a listing is declared exhausted in the briefing.
export const CHASE_MAX = 3;   // was 8 — eight rounds of the same message is
                              // how "Maya keeps forgetting" feels from the
                              // other side of the phone
export const PER_MESSAGE_CAP = 8;   // property families per contact per round (HAUS Canggu's five units are one family)
const ERA_WA = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');

const KEY_FACTS = [
  ['deposit', 'deposit'],
  ['electricity', 'electricity terms'],
  ['wifi', 'wifi speed'],
  ['pool', 'pool (private/shared)'],
  ['minStay', 'minimum stay'],
];

// ── Closing the loop: answer → listing ─────────────────────────────────────
// When a contact answers a chase, Maya applies the facts to the portal
// listing herself (merge-only endpoint; the portal stays source of truth and
// an admin edit can always overwrite). Extraction is tightly scoped: only the
// six key-fact fields, only what the contact actually said.
export async function extractListingFacts(apiKey, answer) {
  if (!apiKey || !String(answer || '').trim()) return null;
  const system = `Extract villa listing facts from a property contact's message. Return ONLY JSON with any of these keys — omit a key entirely when they said nothing about it:
{ "deposit": "<short, e.g. '1 month'>", "electricity": "<who pays / included or not>", "wifi": "<speed, e.g. '200 Mbps'>", "pool": "<'Private' or 'Shared', plus any detail>", "minStay": "<e.g. '3 nights', '1 month'>", "petFriendly": true|false }
Rules: stay faithful to their words, never guess, keep values short (a few words). If nothing matches, return {}.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300, system,
        messages: [{ role: 'user', content: String(answer).slice(0, 1500) }],
      }),
    });
    const d = await r.json();
    if (!r.ok || d.type === 'error') return null;
    const m = (d.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    const facts = m ? JSON.parse(m[0]) : null;
    return facts && Object.keys(facts).length ? facts : null;
  } catch { return null; }
}

export async function applyFactsToListing(slug, facts) {
  const secret = process.env.LISTING_SYNC_SECRET;
  if (!secret || !slug || !facts) return { ok: false, reason: 'missing secret, slug or facts' };
  try {
    const r = await fetch('https://sambarentals.com/api/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      // Relays carry db slugs (underscored); the portal wants its own hyphened
      // form. Portal slugs never contain underscores, so this is lossless.
      body: JSON.stringify({ action: 'update-facts', slug: String(slug).replace(/_/g, '-'), facts }),
    });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, applied: d.applied || [] } : { ok: false, reason: d.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export function missingFacts(listing) {
  const out = KEY_FACTS.filter(([k]) => !String(listing[k] || '').trim()).map(([, label]) => label);
  if (listing.petFriendly !== true && listing.petFriendly !== false) out.push('pets allowed?');
  return out;
}

function contactOf(l) {
  const num = String(l.waNumber || '').replace(/\D/g, '');
  if (!num) return { name: 'Era', wa: ERA_WA };
  return { name: l.waContactName || (num === ERA_WA ? 'Era' : ''), wa: num };
}

// Read one PostgREST path; the chase guards use it to see what is already
// sitting with a contact before adding to the pile.
async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json().catch(() => []) : [];
}

async function getSetting(db, key) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value`, { headers: db.sbHeaders });
  return (await r.json().catch(() => []))?.[0]?.value || {};
}
async function setSetting(db, key, value) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}

// Daily. Returns a summary for the cron response / briefing.
// "HAUS Canggu – Unit 4" → family "HAUS Canggu", unit "4".
function splitUnit(name) {
  const m = String(name || '').match(/^(.*?)\s*[–-]?\s*Unit\s*([A-Za-z0-9]+)\s*$/i);
  return m ? { family: m[1].trim(), unit: m[2] } : { family: String(name || '').trim(), unit: null };
}
function groupFamilies(items) {
  const fams = new Map();
  for (const i of items) {
    const { family, unit } = splitUnit(i.name);
    if (!fams.has(family)) fams.set(family, { family, units: [], items: [], missing: new Set() });
    const f = fams.get(family);
    if (unit) f.units.push(unit);
    f.items.push(i);
    i.missing.forEach(m => f.missing.add(m));
  }
  return [...fams.values()].map(f => ({
    label: f.units.length ? `${f.family} (Unit${f.units.length > 1 ? 's' : ''} ${f.units.join(', ')})` : f.family,
    items: f.items,
    missing: [...f.missing],
  }));
}

// Daily (or on demand from the console). `onlyContact`: digits of one
// contact's number to restrict a run to them (e.g. Era for the first round).
// Returns a summary for the cron response / briefing.
export async function chaseMissingListingInfo(db, wa, { now = new Date(), onlyContact = null } = {}) {
  onlyContact = onlyContact ? String(onlyContact).replace(/\D/g, '') : null;
  const listings = await fetchPortalListings();
  const state = await getSetting(db, 'listing_info_chase');
  const cutoff = now.getTime() - CHASE_EVERY_DAYS * 86400e3;
  const byContact = new Map();   // wa → { name, items: [{ slug, name, missing }] }
  const stillMissing = [];
  const exhausted = [];

  // Slugs whose listing-info question was ANSWERED recently. missingFacts
  // reads the portal listing's own fields, but a captured answer is staged
  // as a pending fact on the relay and reaches those fields only after a
  // human applies it — so without this, the owners who cooperate are exactly
  // the ones who get re-asked: their gaps still read as missing next round.
  // An answered ask buys the listing thirty quiet days for the facts to be
  // applied by hand. (Family asks store only their first slug on the relay,
  // so a multi-unit answer may not shield every sibling — accepted for now.)
  const recentIso = new Date(now.getTime() - 30 * 86400e3).toISOString();
  const answeredRows = await sbGet(db,
    `relays?question=like.${encodeURIComponent('[Listing info]%')}&status=in.(answered,delivered)`
    + `&asked_at=gte.${encodeURIComponent(recentIso)}&select=rental_slug`);
  const answeredSlugs = new Set((answeredRows || []).map(r => r.rental_slug).filter(Boolean));

  for (const l of listings) {
    if (l.hidden) continue;
    const missing = missingFacts(l);
    if (!missing.length) continue;
    const slug = dbSlug(l.slug);
    if (answeredSlugs.has(slug)) continue;
    stillMissing.push({ slug, name: l.name, missing });
    const st = state[slug] || { count: 0, last_at: null };
    if (st.count >= CHASE_MAX) { exhausted.push(slug); continue; }
    if (st.last_at && new Date(st.last_at).getTime() > cutoff) continue;
    const c = contactOf(l);
    if (!c.wa) continue;
    if (!byContact.has(c.wa)) byContact.set(c.wa, { name: c.name, items: [] });
    byContact.get(c.wa).items.push({ slug, name: l.name, missing });
  }

  let opened = 0, queued = 0, skipped = 0; const skippedReasons = [];
  for (const [contactWa, { name, items: all }] of byContact) {
    if (onlyContact && contactWa !== onlyContact) continue;

    // Two courtesies the chase owed people and did not pay, learned from the
    // owners who got angry in late August:
    //
    // Never chase while ANY question is already sitting with this contact —
    // a second "quick questions" message while the first is unanswered reads
    // as forgetting, and their eventual reply has two asks to collide with.
    const pending = await sbGet(db,
      `relays?contact_wa=eq.${contactWa}&status=in.(queued,asked)&select=id&limit=1`);
    if (pending?.length) {
      skipped++; skippedReasons.push({ contact: contactWa.slice(-4), reason: 'question already pending' });
      continue;
    }
    // Never repeat into silence (Era excepted — chasing staff is her job
    // arriving, not marketing). If they have not sent us anything since the
    // last chase, another copy of the same message will not change that; it
    // only teaches them Maya nags. One reply re-opens the chase.
    const lastChase = Math.max(0, ...all.map(i => Date.parse(state[i.slug]?.last_at || 0) || 0));
    if (lastChase && contactWa !== ERA_WA) {
      const sinceIso = new Date(lastChase).toISOString();
      const heard = await sbGet(db,
        `wa_messages?wa_num=eq.${contactWa}&direction=eq.inbound&timestamp=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1`);
      if (!heard?.length) {
        skipped++; skippedReasons.push({ contact: contactWa.slice(-4), reason: 'silent since last chase' });
        continue;
      }
    }
    // Group units of one property into a family line ("HAUS Canggu (Units 1,
    // 2, 4, 5, 6): deposit, …") — the answers are shared, and Era's sixteen
    // villas become six lines. Capped per round; the rest wait.
    const fams = groupFamilies(all).slice(0, PER_MESSAGE_CAP);
    const items = fams.flatMap(f => f.items);
    const lines = fams.map(f => `• ${f.label}: ${f.missing.join(', ')}`).join('\n');
    const intro = contactWa === ERA_WA
      ? "I'm trying to complete some missing details for some of the listings we manage and was wondering if you could please help me out?"
      : (fams.length === 1
        ? `I'm trying to complete a few missing details on ${fams[0].label} so I can answer agents faster — could you help me out?`
        : "I'm trying to complete a few missing details on your listings so I can answer agents faster — could you help me out?");
    const res = await openRelay(db, wa, {
      agent: null,
      question: `${LISTING_INFO_PREFIX}${intro}\n\n${lines}`,
      slug: items[0].slug,
      propertyName: fams.length === 1 ? fams[0].label : `${fams.length} of your listings`,
      contactName: name || 'there',
      contactWa,
    });
    if (res.ok) {
      if (res.status === 'queued') queued++; else opened++;
      for (const i of items) state[i.slug] = { count: (state[i.slug]?.count || 0) + 1, last_at: now.toISOString() };
    } else {
      skipped++; skippedReasons.push({ contact: contactWa.slice(-4), reason: res.reason });
    }
  }
  await setSetting(db, 'listing_info_chase', state);
  return { listings_with_gaps: stillMissing.length, contacts_messaged: opened + queued, opened, queued, skipped, skipped_reasons: skippedReasons, exhausted, still_missing: stillMissing };
}
