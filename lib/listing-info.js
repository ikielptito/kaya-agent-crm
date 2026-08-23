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
export const CHASE_MAX = 4;
export const PER_MESSAGE_CAP = 8;   // property families per contact per round (HAUS Canggu's five units are one family)
const ERA_WA = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');

const KEY_FACTS = [
  ['deposit', 'deposit'],
  ['electricity', 'electricity terms'],
  ['wifi', 'wifi speed'],
  ['pool', 'pool (private/shared)'],
  ['minStay', 'minimum stay'],
];

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

  for (const l of listings) {
    if (l.hidden) continue;
    const missing = missingFacts(l);
    if (!missing.length) continue;
    const slug = dbSlug(l.slug);
    stillMissing.push({ slug, name: l.name, missing });
    const st = state[slug] || { count: 0, last_at: null };
    if (st.count >= CHASE_MAX) { exhausted.push(slug); continue; }
    if (st.last_at && new Date(st.last_at).getTime() > cutoff) continue;
    const c = contactOf(l);
    if (!c.wa) continue;
    if (!byContact.has(c.wa)) byContact.set(c.wa, { name: c.name, items: [] });
    byContact.get(c.wa).items.push({ slug, name: l.name, missing });
  }

  let opened = 0, queued = 0, skipped = 0;
  for (const [contactWa, { name, items: all }] of byContact) {
    if (onlyContact && contactWa !== onlyContact) continue;
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
      skipped++;
    }
  }
  await setSetting(db, 'listing_info_chase', state);
  return { listings_with_gaps: stillMissing.length, contacts_messaged: opened + queued, opened, queued, skipped, exhausted, still_missing: stillMissing };
}
