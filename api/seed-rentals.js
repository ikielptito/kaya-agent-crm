// Rentals sync from the Samba portal -> Supabase `rentals`.
// Single endpoint, two modes:
//
//   POST /api/seed-rentals
//       (no body)                       -> bulk seed every portal listing
//       { slug }                        -> single-slug upsert
//       { slug, action: 'delete' }      -> single-slug soft-delete (active=false)
//
// Auth: Bearer LISTING_SYNC_SECRET. The portal's /api/listings handler fires
// the single-slug mode automatically after a save in /admin (configure
// CRM_SYNC_URL=https://kaya-agent-crm.vercel.app/api/seed-rentals on the portal).
// The bulk mode is for manual backfills — `curl -X POST <url> -H "Authorization:
// Bearer $LISTING_SYNC_SECRET"`.
//
// Both modes pull the merged listing(s) from the portal's /api/listings + cover
// images from /api/properties so the mapping (lib/rental-map.js) is the only
// source of truth for portal->rental field shape.

import { mapListingToRental } from '../lib/rental-map.js';

const PORTAL_URL = 'https://sambarentals.vercel.app/api/listings';
const PROPERTIES_URL = 'https://sambarentals.vercel.app/api/properties';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const secret = process.env.LISTING_SYNC_SECRET;
  if (!secret) return res.status(500).json({ error: 'LISTING_SYNC_SECRET not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const slug = body.slug ? String(body.slug).trim() : '';
  const action = body.action === 'delete' ? 'delete' : 'upsert';

  try {
    // ── Single-slug: soft delete ────────────────────────────────────
    if (slug && action === 'delete') {
      const dbSlug = slug.replace(/-/g, '_');
      await deactivate(SUPABASE_URL, sbHeaders, dbSlug);
      return res.status(200).json({ ok: true, slug: dbSlug, action: 'deactivated' });
    }

    // Both upsert paths need the portal's current listing data + cover map.
    const [portalRes, propsRes] = await Promise.all([
      fetch(PORTAL_URL),
      fetch(PROPERTIES_URL).catch(() => null),
    ]);
    if (!portalRes.ok) return res.status(502).json({ error: `Portal fetch failed: ${portalRes.status}` });
    const portalData = await portalRes.json();
    const listings = portalData.listings || [];
    if (listings.length === 0) return res.status(500).json({ error: 'Portal returned no listings' });

    const coverMap = {};
    if (propsRes && propsRes.ok) {
      try {
        const propsData = await propsRes.json();
        for (const p of (propsData?.data?.properties || [])) {
          const url = p?.cover?.large_url || p?.cover?.original_url;
          if (p?.id && url) coverMap[String(p.id)] = url;
        }
      } catch { /* covers stay null */ }
    }

    // ── Single-slug: upsert ─────────────────────────────────────────
    if (slug) {
      const listing = listings.find(l => l.slug === slug);
      const dbSlug = slug.replace(/-/g, '_');
      // No longer in the portal feed (or hidden) -> soft delete.
      if (!listing || listing.hidden) {
        await deactivate(SUPABASE_URL, sbHeaders, dbSlug);
        return res.status(200).json({ ok: true, slug: dbSlug, action: 'deactivated (not in portal feed)' });
      }
      // idx = null -> mapping omits display_order so siblings keep their order.
      const rental = mapListingToRental(listing, null, coverMap);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([rental]),
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err, slug: dbSlug });
      }
      return res.status(200).json({ ok: true, slug: dbSlug, action: 'upserted' });
    }

    // ── Bulk: seed every portal listing ─────────────────────────────
    // Skip hidden customs so they don't bloat the active set.
    const visible = listings.filter(l => !l.hidden);
    const rentals = visible.map((l, idx) => mapListingToRental(l, idx, coverMap));
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rentals),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err, attempted_count: rentals.length });
    }
    const inserted = await r.json();
    return res.status(200).json({
      message: `Synced ${inserted.length} rentals from portal.`,
      slugs: inserted.map(p => p.slug),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function deactivate(supabaseUrl, sbHeaders, dbSlug) {
  // Soft delete — keep the row for history; just drop it from Maya's live set.
  await fetch(`${supabaseUrl}/rest/v1/rentals?slug=eq.${encodeURIComponent(dbSlug)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ active: false }),
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
