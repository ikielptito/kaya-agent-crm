// Seed rentals from the live Samba portal API.
// POST /api/seed-rentals
//
// Fetches https://sambarentals.vercel.app/api/listings, maps each listing into
// the rentals schema, and UPSERTs them by slug (so running it again refreshes
// the data without creating duplicates).

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

// ── Mapping helpers ──────────────────────────────────────────────────

function parseIdr(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/(\d+(?:\.\d+)?)\s*jt/);
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000);
  return null;
}

function extractBeds(features) {
  for (const f of features || []) {
    const m = f.match(/(\d+)\s*Bedroom/i);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function extractBaths(features) {
  for (const f of features || []) {
    const m = f.match(/(\d+(?:\.\d+)?)\s*Bathroom/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractSqm(features) {
  for (const f of features || []) {
    const buildMatch = f.match(/(\d+(?:\.\d+)?)\s*m[²2]\s*building/i);
    if (buildMatch) return parseFloat(buildMatch[1]);
  }
  // fallback: any m² figure
  for (const f of features || []) {
    const m = f.match(/(\d+(?:\.\d+)?)\s*m[²2]/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractAmenities(features) {
  const text = (features || []).join(' ').toLowerCase();
  const tags = [];
  if (text.includes('pool')) tags.push('Pool');
  if (text.includes('wifi') || text.includes('internet') || text.includes('fibre') || text.includes('fiber')) tags.push('Wifi');
  if (text.includes('workspace') || text.includes('desk')) tags.push('Workspace');
  if (text.includes('kitchen')) tags.push('Kitchen');
  if (text.includes('parking')) tags.push('Parking');
  if (text.includes('air-condition') || text.includes('air condition') || text.includes('ac ')) tags.push('Air-con');
  if (text.includes('furnished')) tags.push('Furnished');
  if (text.includes('washing')) tags.push('Washing machine');
  if (text.includes('garden')) tags.push('Garden');
  if (text.includes('balcony')) tags.push('Balcony');
  return tags.join(', ');
}

function guessPropertyType(listing) {
  const name = (listing.name || '').toLowerCase();
  const slug = (listing.slug || '').toLowerCase();
  if (name.includes('villa')) return 'Villa';
  if (slug.startsWith('lanehaus')) return 'Townhouse';
  return 'Apartment';
}

function mapListingToRental(l, idx, coverMap = {}) {
  const features = l.features || [];
  const inclusions = l.inclusions || [];
  const locationHighlights = l.locationHighlights || [];
  const tag = l.tag || '';
  const area = tag.includes('·') ? tag.split('·')[0].trim() : tag;

  // Convert slug from kebab-case (portal) to snake_case (Supabase convention)
  const slug = (l.slug || '').replace(/-/g, '_');

  // Build extended_info as a structured digest of the portal content
  const extendedSections = [];
  if (l.overview) extendedSections.push(`OVERVIEW:\n${l.overview}`);
  if (features.length) extendedSections.push('FEATURES:\n' + features.map(f => `- ${f}`).join('\n'));
  if (inclusions.length) extendedSections.push('INCLUSIONS (covered by Samba):\n' + inclusions.map(i => `- ${i}`).join('\n'));
  if (locationHighlights.length) extendedSections.push('LOCATION HIGHLIGHTS:\n' + locationHighlights.map(h => `- ${h}`).join('\n'));
  if (l.location) extendedSections.push(`MAP: ${l.location}`);
  if (l.yearly2) extendedSections.push(`ALTERNATE YEARLY: ${l.yearly2}`);
  if (l.hostexId) extendedSections.push(`PORTAL HOSTEX ID: ${l.hostexId}`);

  const beds = extractBeds(features);
  const monthly = parseIdr(l.monthly);
  const yearly = parseIdr(l.yearly);

  // Maya context: rates summary as a single line
  const mayaParts = [];
  if (l.monthly) mayaParts.push(`Monthly: ${l.monthly} IDR`);
  if (l.yearly) mayaParts.push(`Yearly: ${l.yearly} IDR`);
  if (l.yearly2) mayaParts.push(`(or ${l.yearly2} IDR yearly)`);
  const mayaNotes = mayaParts.join('. ') + (mayaParts.length ? '.' : '');

  return {
    slug,
    display_order: idx + 1,
    active: true,
    name: (l.name || '').replace(/–/g, '-'),
    area,
    full_location: tag,
    property_type: guessPropertyType(l),
    beds,
    baths: extractBaths(features),
    sqm: extractSqm(features),
    max_guests: beds ? beds * 2 : null,
    amenities: extractAmenities(features),
    features: features.join('\n'),
    nightly_rate_usd: null,
    nightly_rate_idr: null,
    min_stay_nights: 30,    // portal is long-term focused; edit per unit if needed
    occupancy_pct: null,
    monthly_revenue_idr: null,         // leave blank — actual revenue not in portal
    monthly_rate_idr: monthly,         // asking monthly rate from portal
    yearly_rate_idr: yearly,           // asking yearly rate from portal
    airbnb_url: null,
    booking_url: null,
    maps_url: l.location || null,                             // Google Maps link from portal
    photos_url: l.folder ? `https://drive.google.com/drive/folders/${l.folder}` : null,  // Google Drive photos folder
    portal_url: `https://sambarentals.vercel.app/?property=${l.slug}`,
    hero_image_url: (l.hostexId && coverMap[String(l.hostexId)]) || null,
    commission_pct: 10,
    maya_notes: mayaNotes,
    extended_info: extendedSections.join('\n\n')
  };
}
