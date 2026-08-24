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

// "35jt" / "37.5jt" / "35 juta" → 35000000. A bare number is read as
// millions too ("60" → 60jt, "700" → 700jt) — owner-entered listings arrive
// without the unit and used to land in the CRM as "rate TBC" (Villa Swarna
// Umalas, Villa Bula yearly). Anything ≥ 1,000,000 is taken as raw rupiah.
// Null when unparseable.
export function parseJt(s) {
  const str = String(s || '').trim();
  const m = str.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|m)?\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] || n < 1e6) return Math.round(n * 1e6);
  return Math.round(n);
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


// Facts approved from owner relays are appended to rentals.extended_info as
// "… (confirmed by <name>, YYYY-MM-DD)" lines (lib/relay.js resolveFact). The
// portal knows nothing about them, so a sync that rewrites extended_info from
// the portal would silently erase every approved fact. Re-attach them.
const CONFIRMED_RE = /\(confirmed by [^()]*, \d{4}-\d{2}-\d{2}\)\s*$/;
export async function preserveConfirmedFacts(env, rows) {
  const slugs = rows.map(r => r.slug).filter(Boolean);
  if (!slugs.length) return rows;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?slug=in.(${slugs.join(',')})&select=slug,extended_info`, { headers: env.headers });
  const existing = r.ok ? await r.json() : [];
  const byslug = Object.fromEntries((Array.isArray(existing) ? existing : []).map(x => [x.slug, x.extended_info || '']));
  for (const row of rows) {
    const kept = String(byslug[row.slug] || '').split('\n').map(l => l.trim()).filter(l => CONFIRMED_RE.test(l));
    if (!kept.length) continue;
    const fresh = String(row.extended_info || '');
    const missing = kept.filter(l => !fresh.includes(l));
    if (missing.length) row.extended_info = [fresh, 'CONFIRMED BY THE VILLA CONTACT:', ...missing].filter(Boolean).join('\n');
  }
  return rows;
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
  // Not in the PUBLIC feed = not live (awaiting approval, hidden, or removed).
  // The portal fires this sync on every admin save, so this is the moment we
  // learn a listing is no longer public: switch the CRM row off immediately so
  // Maya stops recommending it, rather than waiting for the daily reconcile.
  if (!l) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?slug=eq.${slug}`, {
      method: 'PATCH', headers: env.headers,
      body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
    });
    return { ok: true, slug, action: 'deactivated', reason: 'not visible in the public feed (unapproved, hidden, or removed)', patched: r.ok };
  }

  const row = rowFromListing(l);
  Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
  await preserveConfirmedFacts(env, [row]);
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
  await preserveConfirmedFacts(env, rows);
  // One upsert per row, not one batch: PostgREST bulk inserts require every
  // object to carry the same keys, and rowFromListing deliberately omits empty
  // fields so they don't clobber hand-filled columns. The batch form failed
  // with 400 on every daily run (rows' updated_at stayed at their last
  // event-sync date; Casa Suhana and Villa Bula — created via Maya's intake,
  // which never fires the event sync — were absent from the CRM entirely).
  let reconciled = 0; const failed = [];
  for (const row of rows) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
      method: 'POST',
      headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    });
    if (r.ok) reconciled++;
    else failed.push({ slug: row.slug, error: (await r.text()).slice(0, 160) });
  }
  if (!reconciled) return { error: `reconcile failed for all ${rows.length} rows`, failed };

  // DEACTIVATE WHAT LEFT THE FEED. The portal's public feed already hides
  // listings that are not live (pending_review intakes, hidden, deleted), but
  // nothing here ever flipped a stale `rentals` row back to inactive — so once
  // a slug landed in the CRM it stayed recommendable forever. Maya pitched
  // Dony's Vila Lestari (and carded it in the weekly carousel) while it was
  // still awaiting approval, and every link she sent 404'd for the agent.
  // Ikiel, 24 Aug 2026: "maya shouldnt suggest a property that isn't
  // live/approved yet".
  // A re-approved listing reactivates by itself: rowFromListing sets
  // active = true on every upsert above.
  const liveSlugs = new Set(rows.map(r => r.slug).filter(Boolean));
  let deactivated = [];
  try {
    const cur = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?select=slug&active=eq.true`, { headers: env.headers });
    const active = cur.ok ? await cur.json() : [];
    const stale = (Array.isArray(active) ? active : [])
      .map(x => x.slug).filter(s => s && !liveSlugs.has(s));
    // Safety: a partial/broken feed must never mass-deactivate the portfolio.
    // Bail out if this run would switch off more than a third of what's live.
    if (stale.length && stale.length > Math.max(3, Math.floor(liveSlugs.size / 3))) {
      return { ok: true, reconciled, failed: failed.length ? failed : undefined,
        deactivate_skipped: stale.length, reason: 'too many missing slugs — treating the feed as unreliable' };
    }
    for (const slug of stale) {
      const dr = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?slug=eq.${encodeURIComponent(slug)}`, {
        method: 'PATCH', headers: env.headers,
        body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
      });
      if (dr.ok) deactivated.push(slug);
    }
  } catch (_) { /* deactivation is best-effort; never fail the reconcile */ }

  return { ok: true, reconciled, failed: failed.length ? failed : undefined,
    deactivated: deactivated.length ? deactivated : undefined };
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
  // Which numbers do we already know? Anything not in this set is a brand-new
  // owner, and only those get the reporting defaults applied below — an
  // existing owner's own choice (including an opt-out) is never touched.
  let knownNums = new Set();
  try {
    const ex = await fetch(`${env.SUPABASE_URL}/rest/v1/owners?select=wa_num`, { headers: env.headers });
    if (ex.ok) knownNums = new Set((await ex.json()).map(o => String(o.wa_num)));
  } catch (_) { /* fall through: with no list we simply skip the defaults */ }

  const up = await fetch(`${env.SUPABASE_URL}/rest/v1/owners?on_conflict=wa_num`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!up.ok) return { error: `owner upsert failed: ${(await up.text()).slice(0, 200)}` };

  // Weekly reporting is ON by default for every property (Ikiel, 24 Aug 2026).
  // opt_in / report_enabled are deliberately left out of the upsert above so a
  // re-sync can't stomp owner-managed state, which meant a NEW owner landed on
  // the column defaults and silently never got a report. Apply the default once,
  // to new numbers only.
  const fresh = payload.map(p => p.wa_num).filter(n => !knownNums.has(String(n)));
  let defaulted = 0;
  if (fresh.length && knownNums.size) {
    const list = fresh.map(n => `"${n}"`).join(',');
    const pr = await fetch(`${env.SUPABASE_URL}/rest/v1/owners?wa_num=in.(${list})`, {
      method: 'PATCH', headers: env.headers,
      body: JSON.stringify({ opt_in: true, report_enabled: true, updated_at: now }),
    });
    if (pr.ok) defaulted = fresh.length;
  }
  return { ok: true, owners: payload.length, ...(defaulted ? { reporting_defaulted_on: defaulted } : {}) };
}
