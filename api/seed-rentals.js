// Seed rentals from the live Samba portal API.
// POST /api/seed-rentals
//
// Fetches https://sambarentals.vercel.app/api/listings, maps each listing into
// the rentals schema, and UPSERTs them by slug (so running it again refreshes
// the data without creating duplicates).

import { mapListingToRental } from '../lib/rental-map.js';

const PORTAL_URL = 'https://sambarentals.vercel.app/api/listings';
const PROPERTIES_URL = 'https://sambarentals.vercel.app/api/properties';  // for cover images

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  try {
    // Fetch live data from the Samba portal
    // Pull listings (descriptions, rates, features) AND properties (cover photos)
    // in parallel, then merge by hostexId so each rental gets its cover image.
    const [portalRes, propsRes] = await Promise.all([
      fetch(PORTAL_URL),
      fetch(PROPERTIES_URL).catch(() => null)
    ]);
    if (!portalRes.ok) {
      return res.status(500).json({ error: `Portal fetch failed: ${portalRes.status}` });
    }
    const portalData = await portalRes.json();
    const listings = portalData.listings || [];
    if (listings.length === 0) {
      return res.status(500).json({ error: 'Portal returned no listings' });
    }

    // Build hostexId → cover URL map (10/14 portal properties currently have one)
    const coverMap = {};
    if (propsRes && propsRes.ok) {
      try {
        const propsData = await propsRes.json();
        const props = propsData?.data?.properties || [];
        for (const p of props) {
          const url = p?.cover?.large_url || p?.cover?.original_url;
          if (p?.id && url) coverMap[String(p.id)] = url;
        }
      } catch (e) { /* non-fatal — covers stay null */ }
    }

    // Map portal listings → rentals schema (with cover lookup)
    const rentals = listings.map((l, idx) => mapListingToRental(l, idx, coverMap));

    // Upsert to Supabase
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation'
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rentals?on_conflict=slug`, {
      method: 'POST', headers,
      body: JSON.stringify(rentals)
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err, attempted_count: rentals.length });
    }
    const inserted = await r.json();
    return res.status(200).json({
      message: `Synced ${inserted.length} rentals from portal.`,
      slugs: inserted.map(p => p.slug)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
