// Shared mapping: a Samba portal listing (from sambarentals.vercel.app/api/listings)
// -> a row in the Supabase `rentals` table. Used by both api/seed-rentals.js
// (bulk backfill) and api/sync-rental.js (single-listing push on save).

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

// Map one portal listing -> a rentals row. `coverMap` is hostexId -> cover URL.
// Pass `idx` to set display_order for bulk seeding; pass null to omit it
// (single-listing sync should not clobber the existing ordering).
export function mapListingToRental(l, idx, coverMap = {}) {
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

  const row = {
    slug,
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

  // Only set display_order during bulk seeding; on single-listing sync we omit
  // it so an edit to one unit doesn't renumber/clobber the rest.
  if (typeof idx === 'number') row.display_order = idx + 1;

  return row;
}
