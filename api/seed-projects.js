// One-time seed endpoint. POST to populate the `projects` table from the
// existing hardcoded portfolio (extracted from the original lib/kb.js).
// Uses ON CONFLICT (slug) DO NOTHING via Prefer: resolution=ignore-duplicates
// so running this multiple times is safe.

const SEED_PROJECTS = [
  {
    slug: 'clay_house',
    display_order: 1,
    active: true,
    brand: 'KAYA',
    name: 'The Clay House',
    tagline: 'Boutique luxury studio apartments in Cepaka, 8 min from Pererenan',
    status: 'Available',
    area: 'Cepaka',
    full_location: 'Cepaka (8 min from Pererenan)',
    distances: '8 min to Tiying Tutul / Nude / Copenhagen. 10 min to Canggu / Obsidian Gym / Jungle Padel. 15 min to Pererenan Beach.',
    property_type: 'Apartment',
    tenure: 'Leasehold',
    tenure_details: '30-year leasehold',
    furnished: 'Fully furnished',
    construction_status: '~75% complete',
    delivery_date: 'July 2026',
    commission_pct: 5,
    payment_plan: '20% deposit, 30% at foundation, 30% at structure, 20% at finishing',
    description: 'Boutique luxury studio apartments with Western construction standards, passive cooling breezeblock facade, resort-style pool, shared rooftop terrace per pair of units, quiet gang location with no road noise.',
    features: 'Western construction standards. Passive cooling breezeblock facade. Resort-style pool. Shared rooftop terrace per pair of units. Quiet gang location, no road noise.',
    roi_projections: '60% occupancy = 12.5%. 70% occupancy = 14.55%. 80% occupancy = 16.95%. Projected ADR ~$100 USD (net of expenses).',
    rental_performance: '',
    maya_notes: '4 units left as of latest. Units 1-3 at IDR 2.18B, Unit 5 at IDR 1.66B. Units 4 and 6 are sold.',
    brochure_url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/The%20Clay%20House%20February%202028.pdf',
    brochure_filename: 'The Clay House.pdf',
    units: [
      { code: 'Type A1', beds: 1, baths: 1, sqm: 47, floor: '2nd', price_usd: 130000, price_idr: 2180000000, availability: 'Available', notes: 'With workspace' },
      { code: 'Type A2', beds: 1, baths: 1, sqm: 47, floor: '2nd', price_usd: 130000, price_idr: 2180000000, availability: 'Available', notes: 'With workspace' },
      { code: 'Type B1', beds: 1, baths: 1, sqm: 45.5, floor: 'Ground', price_usd: 100000, price_idr: 1660000000, availability: 'Available', notes: '' },
      { code: 'Type B2', beds: 1, baths: 1, sqm: 45.5, floor: '2nd', price_usd: 100000, price_idr: 1660000000, availability: 'Sold', notes: 'With workspace' },
      { code: 'Unit 4', beds: 1, baths: 1, sqm: 47, floor: '2nd', price_usd: 130000, price_idr: 2180000000, availability: 'Sold', notes: '' },
      { code: 'Unit 6', beds: 1, baths: 1, sqm: 45.5, floor: '2nd', price_usd: 100000, price_idr: 1660000000, availability: 'Sold', notes: '' }
    ]
  },
  {
    slug: 'tropicana_valley',
    display_order: 2,
    active: true,
    brand: 'KAYA',
    name: 'Tropical Townhouses',
    tagline: '1BR two-level townhouses with private plunge pool, 5 min from Pererenan',
    status: 'Available',
    area: 'Buduk',
    full_location: 'Buduk (5 min from Pererenan)',
    distances: '5 min to Pererenan. <7 min to Nude / Tony\'s Pizza / Sozd / Obsidian Gym / Jungle Padel. 15 min to Canggu / Berawa Beach.',
    property_type: 'Townhouse',
    tenure: 'Leasehold',
    tenure_details: '28-year leasehold',
    furnished: 'Fully furnished, move-in ready',
    construction_status: 'Complete',
    delivery_date: 'Available now',
    commission_pct: 5,
    payment_plan: 'Standard payment terms',
    description: '1BR two-level townhouses with private plunge pool, loft-style bedroom, built-in workspace, soaking tub, shaded terrace. 75 sqm each.',
    features: 'Private plunge pool per unit. Loft-style bedroom. Built-in workspace. Soaking tub. Shaded terrace. 75 sqm, 1 bed, 1 bath, dedicated workspace, 2 floors.',
    roi_projections: 'See real rental performance below for live data.',
    rental_performance: 'Unit A5 (managed by Samba Realty, PriceLabs data): Jan-May 2026 = 83.57% occupancy, ADR IDR 1.05M (~$63 USD), 18 bookings, avg stay 7.28 nights, RevPAR IDR 874.73K. Recent 30-day: 87.1% occupancy, ADR IDR 1.1M. Total revenue Jan-May 2026: IDR 122.46M (~$7,400 USD) from one unit. April 2026 payout: IDR 36.46M gross / IDR 26.29M net to owner. Typical monthly expenses ~IDR 4.7M (housekeeping 1M, pool 600K, complex mgr ~486K, electricity ~2M, water/cleaning/laundry ~600K). Samba Realty mgmt fee: 15% of gross. Strong long-stay demand: April booking was 27 nights (IDR 27.85M).',
    maya_notes: '4 units left: B2, B3, B5, B6. Garden View units (B5/B6) are premium with 387m2 private garden + gazebo. Rental management by Samba Realty available for hands-off ownership.',
    brochure_url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/Tropical%20Townhouses%20Agent%20Version%20May%202027.pdf',
    brochure_filename: 'Tropical Townhouses.pdf',
    units: [
      { code: 'B2', beds: 1, baths: 1, sqm: 75, floor: '2 levels', price_usd: 125000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'B3', beds: 1, baths: 1, sqm: 75, floor: '2 levels', price_usd: 125000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'B5', beds: 1, baths: 1, sqm: 75, floor: '2 levels', price_usd: 135000, price_idr: null, availability: 'Available', notes: 'Garden View, private 387m2 garden with gazebo' },
      { code: 'B6', beds: 1, baths: 1, sqm: 75, floor: '2 levels', price_usd: 135000, price_idr: null, availability: 'Available', notes: 'Garden View, private 387m2 garden with gazebo' }
    ]
  },
  {
    slug: 'palem_kembar',
    display_order: 3,
    active: true,
    brand: 'KAYA',
    name: 'Palem Kembar',
    tagline: 'Twin 3BR freehold villas with rooftop ocean views, Bukit Peninsula',
    status: 'Available',
    area: 'Ungasan',
    full_location: 'Ungasan, Bukit Peninsula (5 min from beach)',
    distances: '5 min to Karma Beach / Sunday Beach / BGS Cafe. 10 min to Savaya Beach Club. 35 min to airport.',
    property_type: 'Villa',
    tenure: 'Freehold',
    tenure_details: 'Freehold',
    furnished: 'Turnkey, fully furnished',
    construction_status: '85% complete',
    delivery_date: 'July 2026',
    commission_pct: 5,
    payment_plan: '20% deposit to secure, balance due at handover',
    description: 'Twin 3BR freehold villas on the Bukit Peninsula with private pool, rooftop ocean views, and three levels. 218.39 sqm building on 150 sqm land each, 3 beds, 3.5 baths.',
    features: 'Rooftop with ocean views, gazebo, BBQ, dining area. Enclosed living room. Granite floors, terrazzo bathrooms, ironwood decking, teak and rattan furnishings. Soaking tubs in bedrooms. Balconies. Poolside lounge.',
    roi_projections: '15.7% to 21.0% gross annually at ~$300 USD ADR depending on occupancy. Professional rental management available.',
    rental_performance: '',
    maya_notes: '2 villas total available. Both freehold which is rare for Bali. July delivery is firm.',
    brochure_url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/Palem%20Kembar%20Ungasan%20Freehold%20by%20KAYA%20Developments_compressed%203.pdf',
    brochure_filename: 'Palem Kembar.pdf',
    units: [
      { code: 'Villa 1', beds: 3, baths: 3.5, sqm: 218.39, floor: '3 levels', price_usd: 299000, price_idr: 5000000000, availability: 'Available', notes: '150 sqm land' },
      { code: 'Villa 2', beds: 3, baths: 3.5, sqm: 218.39, floor: '3 levels', price_usd: 329000, price_idr: 5500000000, availability: 'Available', notes: '150 sqm land' }
    ]
  },
  {
    slug: 'sabit_house',
    display_order: 4,
    active: true,
    brand: 'KAYA',
    name: 'The Sabit House',
    tagline: '9 boutique freehold luxury apartments in the heart of Berawa',
    status: 'Pre-construction',
    area: 'Berawa',
    full_location: 'Heart of Berawa',
    distances: '5 min to Nirvana. 6 min to BAKED / Luma. 7 min to Atlas Beach Club / Finns. 8 min to Bali Social Club. 9 min to Berawa Beach.',
    property_type: 'Apartment',
    tenure: 'Freehold',
    tenure_details: 'Corporate HOA ownership structure -- buyer becomes shareholder in PT company holding freehold title',
    furnished: 'Fully furnished',
    construction_status: 'Pre-construction',
    delivery_date: 'TBC',
    commission_pct: 5,
    payment_plan: '20% deposit, 30% at foundation, 40% at structure, 10% at finishing',
    description: '9 boutique freehold luxury apartments with crescent moon (sabit) sculptural facade, rooftop horizon-edge pool, sunken lounge, BBQ kitchen, seating bar, and scenic rice paddy views.',
    features: 'Crescent moon (sabit) sculptural facade. Rooftop horizon-edge pool. Sunken lounge. BBQ kitchen. Seating bar. Scenic rice paddy views. Western construction standards. Professional waterproofing. Built-in workspaces in select units. Private balconies.',
    roi_projections: '5-year cumulative: 60% occupancy = 10.3% annual / 51.7% total. 70% = 12.1% / 60.3%. 80% = 13.8% / 68.9%.',
    rental_performance: '',
    maya_notes: 'All 9 units available (pre-construction). Penthouse (Unit 9) is the premium option at $199K. Corporate HOA structure is unusual for Bali -- explain it as buyer becoming a shareholder in the PT that holds the freehold title.',
    brochure_url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/The%20Sabit%20House%20Freehold%20Berawa_compressed%203.pdf',
    brochure_filename: 'The Sabit House.pdf',
    units: [
      { code: 'Unit 1 (Type A)', beds: 1, baths: 1, sqm: 40, floor: 'Ground', price_usd: 180000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'Unit 2 (Type A)', beds: 1, baths: 1, sqm: 40, floor: 'Ground', price_usd: 180000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'Unit 3 (Type B)', beds: 1, baths: 1, sqm: 46, floor: '2nd', price_usd: 180000, price_idr: null, availability: 'Available', notes: 'With workspace' },
      { code: 'Unit 4 (Type B)', beds: 1, baths: 1, sqm: 46, floor: '2nd', price_usd: 180000, price_idr: null, availability: 'Available', notes: 'With workspace' },
      { code: 'Unit 5 (Type C)', beds: 1, baths: 1, sqm: 51, floor: '2nd', price_usd: 189000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'Unit 6 (Type B)', beds: 1, baths: 1, sqm: 46, floor: '3rd', price_usd: 180000, price_idr: null, availability: 'Available', notes: 'With workspace' },
      { code: 'Unit 7 (Type B)', beds: 1, baths: 1, sqm: 46, floor: '3rd', price_usd: 180000, price_idr: null, availability: 'Available', notes: 'With workspace' },
      { code: 'Unit 8 (Type C)', beds: 1, baths: 1, sqm: 51, floor: '3rd', price_usd: 189000, price_idr: null, availability: 'Available', notes: '' },
      { code: 'Unit 9 (Penthouse, Type C)', beds: 1, baths: 1, sqm: 51, floor: 'Penthouse', price_usd: 199000, price_idr: null, availability: 'Available', notes: 'Premium top-floor unit' }
    ]
  },
  {
    slug: 'lanehaus',
    display_order: 5,
    active: true,
    brand: 'Personal',
    name: 'LaneHAUS',
    tagline: 'Ikiel\'s personal property -- 3 boutique two-level townhouses in Pererenan',
    status: 'Available',
    area: 'Pererenan',
    full_location: 'Quiet gang on Jl. Pantai Pererenan',
    distances: 'Walking distance to cafes and gyms. Short ride to Pererenan Beach.',
    property_type: 'Townhouse',
    tenure: 'Leasehold',
    tenure_details: 'Leasehold until 22 November 2052 + 10-year extension agreed (cost IDR 270M)',
    furnished: 'Fully furnished and turnkey',
    construction_status: 'Complete, with existing rental operations',
    delivery_date: 'Available now',
    commission_pct: 5,
    payment_plan: 'Standard',
    description: '3 boutique two-level townhouses. Ikiel\'s personal property, NOT a KAYA project. Existing rental operations. 213.8 sqm land total, 189 sqm building total. Yellow zoning. IMB in place.',
    features: 'Fully furnished and turnkey. Existing rental operations. Shared pool. Outdoor lounge. Scooter and car parking. Laundry. PDAM water. Individual electricity meters.',
    roi_projections: '',
    rental_performance: 'Existing rental operations -- ask Ikiel for details.',
    maya_notes: 'IMPORTANT: This is Ikiel\'s personal property, NOT a KAYA project. Mention this distinction if asked. Unit 2 is not for sale.',
    brochure_url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/LaneHAUS%20Pererenan_compressed%202.pdf',
    brochure_filename: 'LaneHAUS Pererenan.pdf',
    units: [
      { code: 'Unit 1', beds: 1, baths: 1, sqm: 65, floor: '2 levels', price_usd: null, price_idr: 1700000000, availability: 'Available', notes: '' },
      { code: 'Unit 3', beds: 1, baths: 1, sqm: 55, floor: '2 levels', price_usd: null, price_idr: 1500000000, availability: 'Available', notes: '' }
    ]
  }
];

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

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=representation'
  };

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify(SEED_PROJECTS)
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }
    const inserted = await r.json();
    return res.status(200).json({
      message: `Seeded ${inserted.length} project(s). Existing slugs were skipped.`,
      inserted: inserted.map(p => p.slug)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
