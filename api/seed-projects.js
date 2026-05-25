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
    extended_info: `ARCHITECTS:
- Tyler Johnson (Executive Director): American architect with a decade of international experience. Blends vernacular design with modern techniques to create buildings that are contextually grounded, high-performing, and environmentally conscious.
- Ngurah Risyana (Lead Architect): Nearly 20 years of experience in Balinese design. Emphasises simplicity, functionality, and sustainability — uses natural materials to create timeless spaces that evolve with the needs of their users.

DESIGN PHILOSOPHY:
Quiet luxury, thoughtfully designed. Soft lighting, natural textures, clean lines. Boutique studio residences built with Western construction standards — a rare quality level at this price point in Bali. Designed to support a grounded, restful lifestyle and create lasting impressions on guests.

KEY ARCHITECTURAL DETAILS:
- Breezeblock façade for passive cooling: provides shade in front of floor-to-ceiling glass, filters light into soft shifting patterns, glows from within at night. Both functional (reduces heat buildup) and beautiful.
- Resort-style pool: tranquil, framed by lush greenery, beside a gentle stream. Couple's loungers. Designed for guest-shareable moments that boost Airbnb visibility, booking rate, and nightly value.
- Shared rooftops, private comfort: 4 rooftops total across the complex, each shared between just two units, with private dedicated seating per apartment. Natural materials, surrounded by jungle views. Used for sunset BBQs, open-air dining.
- Dedicated workspaces in select units: custom-built desks with warm lighting and natural finishes — one of the most-searched Airbnb amenities, drives longer stays and stronger returns.

LOCATION DETAIL:
Set in a quiet lane in Cepaka, beside a gentle ravine, shaded by trees. Free from construction noise, traffic, roosters. Surrounded by tropical greenery and high-end villas. 8 min to Tiying Tutul / Nüde / Copenhagen / House of Creambath. 10 min to Canggu / Jungle Padel / Obsidian Gym / Pepito / Frestive. 15 min to Pererenan Beach and La Brisa. 60 min to airport.

CONSTRUCTION QUALITY:
Professional-grade waterproofing, passive cooling, proper drainage. Every detail designed to reduce maintenance and ensure long-term comfort. Western construction standards.

PAYMENT MILESTONES (construction-linked):
1. 20% at Construction Start
2. 30% at Foundation Complete
3. 30% at Structure Finalised
4. 20% at Finishing Concluded
Each payment tied to a clear milestone so investor capital progresses in lockstep with project development.`,
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
    extended_info: `ARCHITECT:
- Ngurah Risyana: Balinese architect, nearly 20 years of experience, graduate of Warmadewa University. Known for creating spaces that "breathe and evolve." His approach is rooted in sustainable principles and clean architectural lines.

DESIGN PHILOSOPHY:
For Tropical Townhouses he focused on what truly matters in a successful short-term rental: smart layouts for privacy and comfort, optimised natural light and airflow, easy-to-maintain finishes, and a design that photographs beautifully — ensuring strong performance on booking platforms. Modern tropical design with natural materials and layouts that capture light and air. Homes that feel private, connected, and distinctly Bali.

KEY ARCHITECTURAL DETAILS:
- Extra-tall pitched roofs: create dramatic bedroom ceilings while offering protection from Bali's tropical rains.
- High ceilings + large windows + smart layouts: keep interiors bright and cool naturally.
- Material palette: terrazzo and timber for warmth; natural textures throughout.
- Private plunge pool per townhouse: at the heart of each home, framed by greenery. Calm retreat just steps from the living room. Photogenic, drives 5-star reviews and rental appeal.
- Loft-style bedroom on upper level with built-in workspace: one of the most sought-after Airbnb amenities for remote workers. Drives more views, longer stays, stronger returns.
- Sunset balconies: each townhouse includes a private 2-seater balcony facing WEST — perfect for evening coffee, reading, sunset drinks. Balances privacy with open views.
- Shaded outdoor areas + soaking tub: invite moments of rest.
- All units 75 sqm across 2 floors. Open-plan living downstairs, private bedroom + workspace + balcony upstairs.

LOCATION DETAIL:
Set in Buduk, a peaceful village on the borders of Canggu and Tumbak Bayuh. Calm and tucked-away feeling, surrounded by rice fields and villas, yet only 5 min to Pererenan and <7 min to Canggu's most popular cafes/gyms/social spots. 5 min to Pererenan / Tiying Tutul / Nüde / Copenhagen / House of Creambath. <7 min to Sozd, Touché, Samadi Work Life, Obsidian Gym, Jungle Padel. 15 min to Canggu and Berawa Beach. 60 min to Bali Airport. Breezes move across open fields, narrow lanes shaded by greenery — feels private and connected to nature.

PERFORMANCE NARRATIVE:
Pererenan/Buduk area has strong year-round rental demand. Popular with remote workers, couples, longer-stay tenants. Established cafés, gyms, lifestyle infrastructure. Limited supply of this quality at this price point.`,
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
    extended_info: `DESIGN PHILOSOPHY:
Three-level villa designed to balance style, comfort, and function. Sunlit entry opens to an enclosed living room and seamless kitchen-dining flow. Architectural elegance designed for living. Resort-style living, elevated. Smart investment meets everyday luxury.

3-LEVEL LAYOUT (detailed):
- GROUND FLOOR: Open kitchen with island, dining area, lounge that opens directly to the pool via folding glass doors — perfect for easy indoor-outdoor living. Cozy family room with TV and built-in workspace for flexibility. Ground floor powder room.
- SECOND FLOOR: Two ensuite bedrooms, each with its own balcony and soaking tub — comfort and privacy for guests or family.
- THIRD FLOOR: Master suite with pitched timber roof, ocean views, and a bathtub framed by the horizon. Just outside: rooftop patio with built-in BBQ, prep kitchen, and shaded lounge.

ROOFTOP (the headline feature):
Sun-drenched private rooftop with ocean views. Custom built-in BBQ, full kitchen, prep area, sink, dining island with stools for 6, outdoor sectional/lounge with cushions, two sun loungers, shaded dining pavilion. "Where lifestyle and performance meet."

MATERIAL PALETTE:
Granite floors, ironwood decking, terrazzo bathrooms, teak and rattan furnishings. Natural materials throughout — handcrafted rattan, timber. Curated coastal charm.

SPECIFICATIONS:
- Freehold title (HGB)
- Land: 150 m² per villa
- Building: 218.39 m² per villa, 3 floors
- 3 bedrooms / 3.5 bathrooms
- Private pool: 2.4 × 6.85m with wooden deck and sun loungers
- Electricity: 7,700 watts
- Water: PDAM
- Toto toilets, premium fixtures
- Car + motorbike parking

LOCATION DETAIL (Bukit Peninsula):
Perched on a hilltop in Ungasan, in the heart of Bali's most sought-after destination. Elevated above it all yet minutes from the action. 5 min to BGS Bali Cafe, Sunday Beach, Karma Beach, HEDONIST Restaurant. 10 min to Savaya Beach Club, Golf Pecatu. 15 min to Uluwatu Temple. 35 min to Bali Airport. The Bukit coastline (at the base of dramatic limestone cliffs) is among the most beautiful in all of Bali — all within easy reach from the villa.

INVESTMENT NARRATIVE:
Nightly rates average $300 USD. Projected gross ROI 15.7%–21.0% annually depending on occupancy. Professional rental management available for turnkey income. High rental demand + premium amenities + Bali's booming tourism = rare chance to enjoy both lifestyle and income from day one.

INCLUSIONS / FURNISHING:
King-size master bed (premium mattress). Queen-size guest beds. All bedrooms: bedside tables, built-in or freestanding wardrobes, wall decoration. All bathrooms: soap dispenser, bath mat (managed units), decorative candle/incense. Ground floor: comfortable sofa with coffee table, flat-screen TV with media console, built-in work desk with chair. Open-plan modern kitchen.`,
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
    extended_info: `ARCHITECTS:
- Tyler Johnson (Executive Director): American architect with a decade of international experience. Blends vernacular design with modern techniques to create buildings that are contextually grounded, high-performing, and environmentally conscious.
- Ngurah Risyana (Lead Architect): Nearly 20 years of experience in Balinese design. Emphasises simplicity, functionality, and sustainability — uses natural materials to create timeless spaces that evolve with the needs of their users.

THE NAME — "SABIT":
"Sabit" comes from the Balinese word for sickle, and in "bulan sabit" it means crescent moon — the inspiration behind the building's sculptural façade. By night, The Sabit House becomes a calm, luminous landmark in the heart of Berawa.

DESIGN PHILOSOPHY:
Architecture in rhythm with light. Nine boutique luxury apartments defined by design consciousness and curated detail. Built to Western standards with professional-grade waterproofing, drainage, and finishings — engineered for durability and long-term ease of ownership. Combines central convenience with rare tranquility and scenic views.

KEY ARCHITECTURAL DETAILS:
- Crescent-moon (sabit) sculptural façade — defines the building visually and lights up at night.
- THE ROOFTOP (the headline feature): horizon-edge pool, sunken lounge, BBQ kitchen, seating bar, scenic Berawa views. "A photogenic space that elevates lifestyle and drives 5-star reviews." Framed by golden light — designed for both quiet moments and social evenings.
- THE BALCONIES: each apartment opens to a private balcony framed by greenery and soft curves. A personal retreat for morning coffee or evening air. Seamless transition between indoors and out. Adds calm, light, and value to every stay.
- THE WORKSPACES: select units include a built-in workspace crafted for focus and calm. Warm materials, soft lighting, natural textures. Appeals to remote travellers, encourages longer/higher-value stays.
- PRIVATE ELEVATOR: rare in boutique developments of this scale. Discreet luxury, enhances accessibility and resident comfort.

LOCATION DETAIL:
Tucked between two quiet dead-end roads in the heart of Berawa — one of Bali's most dynamic neighbourhoods. Pairs rare tranquility and uninterrupted rice paddy views with immediate access to the island's leading dining, nightlife, and fitness destinations. 5 min to Nirvana / Power / Revive. 6 min to BAKED / Luma. 7 min to Atlas Beach Club / Finns Recreation Club. 8 min to Bali Social Club. 9 min to Canggu Beach. 12 min to Berawa Beach. 15 min to Seminyak. 60 min to airport. Free from through-traffic but minutes from lifestyle hotspots.

UNIT TYPES:
- TYPE A (Units 1 & 2): 1 bed / 1 bath, dedicated workspace, ground floor, 40 sqm, $180k. Fully furnished.
- TYPE B (Units 3, 4, 6, 7): 1 bed / 1 bath, dedicated workspace, 2nd & 3rd floors, 46 sqm, $180k. Fully furnished.
- TYPE C (Units 5 & 8): 1 bed / 1 bath, 51 sqm, $189k. Fully furnished. NO workspace.
- PENTHOUSE / TYPE C (Unit 9): 1 bed / 1 bath, 51 sqm, $199k. Top-floor premium.

CORPORATE HOA OWNERSHIP STRUCTURE (the unique selling point):
A new model of ownership in Bali. Each buyer becomes a SHAREHOLDER in the company (PT) that owns the freehold land and building, with shares tied to exclusive usage rights for their apartment. Combines the permanence of true freehold ownership with the efficiency of professional management.

Three benefits:
1. FREEHOLD SECURITY — land and building are collectively owned by the company on behalf of all shareholders.
2. CONTROL OVER RENEWAL — owners directly manage extensions and renewals of the freehold title, without dependence on a third-party landowner.
3. COMPREHENSIVE GOVERNANCE — a formal Shareholders Agreement (SHA) defines voting rights, decision-making, and building operations.

This is a rare structure in Bali. When agents ask "how is this freehold?" the explanation is: "The buyer doesn't hold the deed personally — they own shares in the Indonesian company that holds the freehold deed. The shares come with exclusive usage rights to their specific apartment, and the company is governed by all the shareholders together."`,
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
    extended_info: `PROPERTY OVERVIEW:
LaneHAUS Pererenan is a boutique collection of three two-level townhouses located in the heart of Pererenan. Designed for efficient living and flexible rental use. The property is FULLY OPERATIONAL and INCOME-PRODUCING TODAY. Built 2016, renovated June 2025.

POSITIONING (different from the other KAYA projects):
This is a TURNKEY rental property, not a development. Offered fully furnished and turnkey, with existing rental operations in place. Transition to new ownership can be made seamlessly, with the option to continue generating rental income from day one. Small scale ensures privacy, ease of management, and a calm residential atmosphere — suits both short-term guests and longer-term tenants.

LAYOUT (per unit):
- GROUND FLOOR: Single open-plan living space combining kitchen, dining, and lounge. Practical and efficient. Direct access to outdoor area. Natural flow between spaces. Ground-floor bathroom with polished concrete and terrazzo surfaces with natural stone accents.
- SECOND FLOOR: Spacious bedroom separated from living areas below — suits short stays and longer-term living. Enclosed balcony configured as a DEDICATED WORKSPACE with natural light — ideal for remote work and longer stays, with added noise insulation.

SHARED AMENITIES:
- Well-sized shared pool with outdoor sectional for lounging and daily use.
- Small patio with table seating for dining or working outdoors.
- Large shared storage area along the side of the building — flexibility for future use (co-working area, dedicated laundry, etc.).
- On-site scooter and car parking.
- PDAM water connection. Individual electricity meters.

WHY PERERENAN WORKS:
Pererenan is one of the most desirable areas in Bali for both living and rentals — strong year-round rental demand, popular with remote workers, couples, and longer-stay tenants. Established cafés, gyms, and lifestyle infrastructure. Limited supply of quality properties at this scale. Walking distance to cafés, gyms, daily amenities. Short ride to Pererenan Beach. Easy access to Canggu, Berawa, Seseh, Cemagi, Kedungu, Ubud. ~60 min to Bali Airport.

LEGAL & SPECS:
- Land: 213.8 m². Total building: 189 m². Zoning: Yellow.
- Leasehold valid until 22 November 2052.
- 10-YEAR EXTENSION OPTION ALREADY AGREED with landowner. Extension cost: IDR 270,000,000. (This is significant — it effectively extends usable tenure to 2062.)
- IMB license in place.
- Suitable for short-term rentals, long-term rentals, or personal use.

UNITS (for sale):
- Unit 1 — 65 m² — IDR 1.7B
- Unit 3 — 55 m² — IDR 1.5B
- Unit 2 — NOT for sale.

KEY DIFFERENCE vs other KAYA projects:
This is Ikiel's personal property, NOT a KAYA project. Mention this distinction if asked. Standard commission still applies. The property's already-built / already-renting status means a buyer can step into immediate cashflow — different value proposition from off-plan or pre-construction options.`,
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
    // on_conflict=slug tells PostgREST to UPSERT on the slug unique constraint
    // (otherwise merge-duplicates is ignored and we hit a 23505 duplicate-key error).
    const r = await fetch(SUPABASE_URL + '/rest/v1/projects?on_conflict=slug', {
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
