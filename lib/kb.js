// Shared knowledge base for Claude-generated replies (server-side)

export const PORTFOLIO_CONTEXT = `KAYA Developments portfolio (current):

1. THE CLAY HOUSE — Cepaka (8 min from Pererenan)
   Type: Boutique luxury studio apartments, 30-year leasehold, fully furnished
   Unit types:
   - Type A1/A2: 1 bed, 1 bath, workspace, 47 sqm, 2nd floor — IDR 2.18B (~$130K USD)
   - Type B1: 1 bed, 1 bath, 45.5 sqm, ground floor — IDR 1.66B (~$100K USD)
   - Type B2: 1 bed, 1 bath, workspace, 45.5 sqm, 2nd floor — SOLD
   Availability: 4 units left (Units 1-3 at IDR 2.18B, Unit 5 at IDR 1.66B; Unit 4 SOLD, Unit 6 SOLD)
   Construction: ~75% complete. Payment plan: 20% deposit, 30% at foundation, 30% at structure, 20% at finishing.
   Features: Western construction standards, passive cooling breezeblock facade, resort-style pool, shared rooftop terrace per pair of units, quiet gang location, no road noise.
   ROI projections (net of expenses): 60% occ = 12.5%, 70% occ = 14.55%, 80% occ = 16.95%. Projected ADR ~$100 USD.
   Location: 8 min to Tiying Tutul/Nude/Copenhagen, 10 min to Canggu/Obsidian Gym/Jungle Padel, 15 min to Pererenan Beach.

2. TROPICAL TOWNHOUSES (Tropicana Valley) — Buduk (5 min from Pererenan)
   Type: 1BR two-level townhouses with private plunge pool, 28-year leasehold, fully furnished
   Size: 75 sqm each, 1 bed, 1 bath, dedicated workspace, 2 floors
   Pricing:
   - Units B2, B3: $125,000 USD
   - Units B5, B6 (Garden View, private 387m2 garden with gazebo): $135,000 USD
   Availability: 4 units left (B2, B3, B5, B6). Move-in ready.
   Features: Private plunge pool per unit, loft-style bedroom, built-in workspace, soaking tub, shaded terrace.
   REAL RENTAL PERFORMANCE (existing unit, managed by Samba Realty):
   - Jan-May 2025: 83.57% occupancy, ADR IDR 1.05M (~$63 USD), 18 bookings, avg stay 7.28 nights
   - April 2026 example: IDR 36.46M gross revenue, IDR 26.29M net payout to owner after all expenses
   - Typical monthly expenses per unit: ~IDR 4.7M (housekeeping 1M, pool guy 600K, complex manager share ~486K, electricity ~2M, water/cleaning/laundry ~600K)
   - Samba Realty management fee: 15% of gross revenue (includes listing management, guest comms, check-in/out, cleaning coordination)
   - Strong long-stay demand: one April booking was 27 nights (IDR 27.85M revenue)
   Rental management by Samba Realty available for hands-off ownership.
   Location: 5 min to Pererenan, <7 min to Nude/Tony's Pizza/Sozd/Obsidian Gym/Jungle Padel, 15 min to Canggu/Berawa Beach.

3. PALEM KEMBAR — Ungasan (Bukit Peninsula, 5 min from beach)
   Type: Twin 3BR freehold villas with private pool and rooftop ocean views
   Size: 218.39 sqm building on 150 sqm land, 3 beds, 3.5 baths, 3 levels
   Pricing:
   - Villa 1: IDR 5B ($299,000 USD)
   - Villa 2: IDR 5.5B ($329,000 USD)
   Availability: 2 villas available. 85% construction complete. July delivery. Turnkey, fully furnished.
   Payment: 20% deposit to secure, balance due at handover.
   Features: Rooftop with ocean views, gazebo, BBQ, dining area. Enclosed living room, granite floors, terrazzo bathrooms, ironwood decking, teak and rattan furnishings. Soaking tubs in bedrooms, balconies, poolside lounge.
   ROI projections: 15.7% to 21.0% gross annually at ~$300 USD ADR depending on occupancy. Professional rental management available.
   Location: 5 min to Karma Beach/Sunday Beach/BGS Cafe, 10 min to Savaya Beach Club, 35 min to airport.

4. THE SABIT HOUSE — Berawa (heart of Berawa)
   Type: 9 boutique freehold luxury apartments. Corporate HOA ownership structure (buyer becomes shareholder in PT company holding freehold title).
   Unit types:
   - Type A: 1 bed, 1 bath, ground floor, 40 sqm, Units 1 & 2 — $180,000 USD
   - Type B: 1 bed, 1 bath, workspace, 2nd/3rd floor, 46 sqm, Units 3, 4, 6, 7 — $180,000 USD
   - Type C: 1 bed, 1 bath, 51 sqm, Units 5 & 8 — $189,000 USD
   - Penthouse (Type C): Unit 9 — $199,000 USD
   Availability: 9 units available. Pre-construction. Payment plan: 20% deposit, 30% at foundation, 40% at structure, 10% at finishing.
   Features: Crescent moon (sabit) sculptural facade, rooftop horizon-edge pool, sunken lounge, BBQ kitchen, seating bar, scenic rice paddy views. Western construction standards, professional waterproofing. Built-in workspaces in select units. Private balconies.
   ROI projections (5-year): 60% occ = 10.3% annual / 51.7% total, 70% occ = 12.1% / 60.3%, 80% occ = 13.8% / 68.9%.
   Location: 5 min to Nirvana, 6 min to BAKED/Luma, 7 min to Atlas Beach Club/Finns, 8 min to Bali Social Club, 9 min to Berawa Beach.

5. LANEHAUS — Pererenan (Ikiel's personal property, NOT a KAYA project)
   Type: 3 boutique two-level townhouses, leasehold until 22 November 2052, 10-year extension agreed (cost IDR 270M)
   Pricing:
   - Unit 1: 65 sqm — IDR 1.7B
   - Unit 3: 55 sqm — IDR 1.5B
   Land: 213.8 sqm total, building: 189 sqm total. Zoning: Yellow. IMB in place.
   Features: Fully furnished and turnkey, existing rental operations, shared pool, outdoor lounge, scooter/car parking, laundry, PDAM water, individual electricity meters.
   Location: Quiet gang on Jl. Pantai Pererenan, walking distance to cafes/gyms, short ride to Pererenan Beach.

Standard agent commission: 5% on all KAYA projects.

Samba Realty portfolio: 14 villas and apartments across Canggu, Pererenan and Seminyak.
Agent portal with live availability: https://sambarentals.vercel.app
Rental commission: 10% per booking.`;

// Project key -> brochure public URL (Supabase Storage). Fill in real URLs after upload.
export const BROCHURES = {
  clay_house:       { url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/The%20Clay%20House%20February%202028.pdf', filename: 'The Clay House.pdf', label: 'Clay House' },
  tropicana_valley: { url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/Tropical%20Townhouses%20Agent%20Version%20May%202027.pdf', filename: 'Tropicana Valley.pdf', label: 'Tropicana Valley' },
  palem_kembar:     { url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/Palem%20Kembar%20Ungasan%20Freehold%20by%20KAYA%20Developments_compressed%203.pdf', filename: 'Palem Kembar.pdf', label: 'Palem Kembar' },
  sabit_house:      { url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/The%20Sabit%20House%20Freehold%20Berawa_compressed%203.pdf', filename: 'The Sabit House.pdf', label: 'Sabit House' },
  lanehaus:         { url: 'https://viftknpkeitbovvxcdez.supabase.co/storage/v1/object/public/brochures/LaneHAUS%20Pererenan_compressed%202.pdf', filename: 'LaneHAUS Pererenan.pdf', label: 'LaneHAUS' },
};

export const REPLY_TONE = `Tone rules:
- Conversational and warm, never corporate or stiff
- Short sentences, natural rhythm
- No em dashes (use -- if needed)
- No emojis
- Concise and scannable
- Sound like a real person (you are replying on behalf of Ikiel from KAYA)
- Never mention that you are an AI`;
