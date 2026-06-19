// Single-listing sync from the Samba portal -> Supabase `rentals`.
// POST /api/sync-rental   { slug, action: 'upsert' | 'delete' }
//
// The portal (api/listings.js) fires this fire-and-forget whenever a listing is
// created, edited, hidden, or deleted in /admin, so the CRM's rentals table
// (the data Maya answers from) stays in lockstep without a manual re-seed.
//
// Auth: Bearer LISTING_SYNC_SECRET (shared secret, same value set on the portal).
// On upsert we pull the merged listing from the portal's own /api/listings so we
// reuse the exact same mapping seed-rentals uses — no field drift between paths.

import { mapListingToRental } from '../lib/rental-map.js';

const PORTAL_URL = 'https://sambarentals.vercel.app/api/listings';
const PROPERTIES_URL = 'https://sambarentals.vercel.app/api/properties';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.LISTING_SYNC_SECRET;
  if (!secret) return res.status(500).json({ error: 'LISTING_SYNC_SECRET not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const slug = String(body.slug || '').trim();
  const action = body.action === 'delete' ? 'delete' : 'upsert';
  if (!slug) return res.status(400).json({ error: 'slug required' });

  // Portal slugs are kebab-case; the rentals table keys on snake_case.
  const dbSlug = slug.replace(/-/g, '_');

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    if (action === 'delete') {
      await deactivate(SUPABASE_URL, headers, dbSlug);
      return res.status(200).json({ ok: true, slug: dbSlug, action: 'deactivated' });
    }

    // upsert: fetch the merged listing (+ cover) from the portal
    const [portalRes, propsRes] = await Promise.all([
      fetch(PORTAL_URL),
      fetch(PROPERTIES_URL).catch(() => null),
    ]);
    if (!portalRes.ok) return res.status(502).json({ error: `Portal fetch failed: ${portalRes.status}` });
    const portalData = await portalRes.json();
    const listing = (portalData.listings || []).find(l => l.slug === slug);

    // Not in the portal feed anymore (deleted, or a hidden custom) -> deactivate.
    if (!listing || listing.hidden) {
      await deactivate(SUPABASE_URL, headers, dbSlug);
      return res.status(200).json({ ok: true, slug: dbSlug, action: 'deactivated (not in portal feed)' });
    }

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

    // idx = null -> mapping omits display_order so we don't renumber siblings.
    const rental = mapListingToRental(listing, null, coverMap);

    const r = await fetch(`${SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([rental]),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err, slug: dbSlug });
    }
    return res.status(200).json({ ok: true, slug: dbSlug, action: 'upserted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function deactivate(supabaseUrl, headers, dbSlug) {
  // Soft delete — keep the row for history, just drop it from Maya's live set.
  await fetch(`${supabaseUrl}/rest/v1/rentals?slug=eq.${encodeURIComponent(dbSlug)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ active: false }),
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
