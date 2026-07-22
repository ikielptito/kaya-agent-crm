// Portal → CRM rental sync. The portal (sambarentals.com) is the source of
// truth for listing facts — price, name, badge, cover, visibility. Its admin
// console fires notifyCrmSync() on every save; this module is the receiving
// end, upserting the changed listing into the `rentals` table so BOTH Mayas
// (webhook autoresponder reads the DB, assistant overlays live) stay correct.
//
// Also used by the daily cron as a full reconcile pass (safety net for any
// missed webhook), so the logic lives here once.

import { mapListingToRental } from './rental-map.js';
import { coverPhotoUrl } from './wa-carousel.js';

const PORTAL_LISTINGS = 'https://sambarentals.com/api/listings';

// "35jt" / "37.5jt" → 35000000 / 37500000. Null when unparseable.
export function parseJt(s) {
  const m = String(s || '').match(/(\d+(?:[.,]\d+)?)\s*jt/i);
  return m ? Math.round(parseFloat(m[1].replace(',', '.')) * 1e6) : null;
}

// Portal slugs are hyphenated (villa-saturno); rentals.slug uses underscores.
export function dbSlug(portalSlug) {
  return String(portalSlug || '').toLowerCase().replace(/-/g, '_');
}

export async function fetchPortalListings() {
  const r = await fetch(PORTAL_LISTINGS);
  if (!r.ok) throw new Error(`portal listings HTTP ${r.status}`);
  let data = await r.json();
  if (!Array.isArray(data)) data = data.listings || [];
  return data;
}

// Map one portal listing onto a rentals row patch. Full listing facts — beds,
// baths, area, features, extended_info — via the shared portal→rentals mapper,
// so a villa added on the portal is immediately matchable by Maya ("2BR with
// garden under 27jt") instead of arriving as a name+rate shell. (Villa Umah
// Astanine was invisible to criteria matching for exactly this reason.)
// CRM-owned fields (maya_notes, display_order, min_stay_nights, occupancy /
// revenue figures, engagement data) are never touched.
const SYNC_FIELDS = ['name', 'area', 'full_location', 'property_type', 'beds',
  'baths', 'sqm', 'max_guests', 'amenities', 'features', 'monthly_rate_idr',
  'yearly_rate_idr', 'photos_url', 'portal_url', 'extended_info'];

function rowFromListing(l) {
  const full = mapListingToRental(l, null, {});
  const row = {};
  // Only carry derived values that exist — a null must not clobber a manually
  // filled column (e.g. beds typed in by hand for an older row).
  for (const k of SYNC_FIELDS) {
    if (full[k] !== null && full[k] !== undefined && full[k] !== '') row[k] = full[k];
  }
  // Rates via parseJt (handles comma decimals like "37,5jt").
  const monthly = parseJt(l.monthly);
  const yearly = parseJt(l.yearly);
  if (monthly) row.monthly_rate_idr = monthly;
  if (yearly) row.yearly_rate_idr = yearly;
  // Portal unitType ("1BR Townhouse with Dedicated Workspace") beats the
  // mapper's coarse guess ("Townhouse").
  if (l.unitType) row.property_type = l.unitType;
  // maps_url only when it is a real link (the portal field is sometimes text).
  if (l.location && /^https?:/.test(l.location)) row.maps_url = l.location;
  // Portal cover → Meta-fetchable hero image, so every listing can ride in a
  // WhatsApp card/carousel. null intentionally NOT written (keep any existing).
  if (l.coverPhotoId) row.hero_image_url = coverPhotoUrl(l.coverPhotoId);
  // badge: null on purpose — removing the badge in the portal admin clears it here.
  row.badge = (typeof l.badge === 'string' && l.badge.trim()) ? l.badge.trim().slice(0, 24) : null;
  row.slug = dbSlug(l.slug);
  row.active = true;
  row.updated_at = new Date().toISOString();
  return row;
}

// Upsert one slug (or deactivate it). env: { SUPABASE_URL, headers }.
export async function syncRental(env, portalSlug, action) {
  const slug = dbSlug(portalSlug);
  if (!slug) return { error: 'slug required' };

  if (action === 'delete') {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?slug=eq.${slug}`, {
      method: 'PATCH', headers: env.headers,
      body: JSON.stringify({ active: false, updated_at: new Date().toISOString() })
    });
    return r.ok ? { ok: true, slug, action: 'deactivated' } : { error: `deactivate failed ${r.status}` };
  }

  const listings = await fetchPortalListings();
  const l = listings.find(x => x.slug === portalSlug || dbSlug(x.slug) === slug);
  if (!l) return { error: `slug "${portalSlug}" not found on the portal` };

  const row = rowFromListing(l);
  Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) return { error: `upsert failed: ${(await r.text()).slice(0, 200)}` };
  const saved = (await r.json())?.[0];
  return { ok: true, slug, action: 'upserted', monthly_rate_idr: saved?.monthly_rate_idr ?? row.monthly_rate_idr, badge: row.badge };
}

// Pull per-agent portal engagement (clicks/enquiries/last-seen + channel
// totals) from the portal and cache it in settings.agent_portal_stats, so the
// CRM can join it with message read-rates for the funnel — without querying the
// portal on every dashboard/report load. Runs daily from the cron.
export async function pullAgentAnalytics(env) {
  const secret = process.env.LISTING_SYNC_SECRET;
  const r = await fetch('https://sambarentals.com/api/dashboard?agent_funnel=1', {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {}
  });
  if (!r.ok) return { error: `portal analytics HTTP ${r.status}` };
  const data = await r.json();
  await fetch(`${env.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'agent_portal_stats', value: {
      updated_at: new Date().toISOString(),
      agents: data.agents || {},
      channels: data.channels || {},
    } })
  });
  return { ok: true, agents: data.count || 0 };
}

// Full reconcile: upsert every visible portal listing. Cheap (one portal fetch,
// one upsert batch) — run daily from the cron as the safety net.
export async function reconcileAllRentals(env) {
  const listings = await fetchPortalListings();
  const rows = listings.map(rowFromListing).map(row => {
    Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
    return row;
  });
  if (!rows.length) return { error: 'portal returned no listings' };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) return { error: `reconcile failed: ${(await r.text()).slice(0, 200)}` };
  return { ok: true, reconciled: rows.length };
}

// Owner sync: pull the portal's authed owner-contact feed and upsert the CRM
// `owners` table, keyed by WhatsApp number. Groups the per-listing rows so one
// number that contacts for several villas becomes a single owner with all its
// slugs. Identity + links only — opt_in / report_enabled / notes / active are
// deliberately omitted so PostgREST's merge-duplicates leaves owner-managed
// state untouched on every re-sync. Run daily from the cron alongside rentals.
export async function syncOwners(env) {
  const secret = process.env.LISTING_SYNC_SECRET;
  const r = await fetch('https://sambarentals.com/api/dashboard?owner_sync=1', {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
  if (!r.ok) return { error: `portal owner-sync HTTP ${r.status}` };
  const data = await r.json();
  const rows = Array.isArray(data.owners) ? data.owners : [];

  const byNum = new Map();
  for (const row of rows) {
    const wa = String(row.waNumber || '').replace(/[^0-9]/g, '');
    if (!wa) continue;
    let o = byNum.get(wa);
    if (!o) { o = { wa_num: wa, name: '', email: '', portal_sub: null, slugs: new Set() }; byNum.set(wa, o); }
    if (!o.name && (row.ownerName || row.waContactName)) o.name = row.ownerName || row.waContactName;
    if (!o.email && row.ownerEmail) o.email = row.ownerEmail;
    if (!o.portal_sub && row.ownerSub) o.portal_sub = row.ownerSub;
    if (row.slug) o.slugs.add(row.slug);
  }
  if (!byNum.size) return { ok: true, owners: 0 };

  const now = new Date().toISOString();
  const payload = [...byNum.values()].map(o => ({
    wa_num: o.wa_num,
    name: o.name || null,
    email: o.email || null,
    portal_sub: o.portal_sub,
    listing_slugs: [...o.slugs],
    last_synced_at: now,
    updated_at: now,
  }));
  const up = await fetch(`${env.SUPABASE_URL}/rest/v1/owners?on_conflict=wa_num`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!up.ok) return { error: `owner upsert failed: ${(await up.text()).slice(0, 200)}` };
  return { ok: true, owners: payload.length };
}
