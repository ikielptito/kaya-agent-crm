// WhatsApp carousel-template plumbing for the weekly Samba availability digest.
//
// A carousel template shows up to 10 swipeable cards, each with its own hero
// image, a line of copy, and a "View listing" button — the premium, visual
// replacement for the old text-bullet digest.
//
// Two hard bits of Meta machinery live here:
//  1. CREATE needs an example image supplied as a `header_handle`, which only
//     comes from the Resumable Upload API (app-scoped) — not a plain URL. We
//     derive the app id from the token and run the upload server-side.
//  2. SEND supplies each card's real image as a link + body params + the button
//     slug. The number of cards is fixed at creation, so the cron fills exactly
//     that many (top-N available villas) or falls back to the text digest.

const GRAPH = 'https://graph.facebook.com/v19.0';
const PORTAL_ORIGIN = 'https://sambarentals.com';
export const CAROUSEL_CARD_COUNT = 6;   // fixed at template creation

// Google Drive photo id → a Meta-fetchable direct JPEG (the portal's own CDN form).
export function coverPhotoUrl(coverPhotoId) {
  return coverPhotoId ? `https://lh3.googleusercontent.com/d/${coverPhotoId}=w1600` : null;
}

// The token's own app id, needed for the Resumable Upload endpoint.
async function deriveAppId(token) {
  const r = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`);
  const d = await r.json();
  const appId = d?.data?.app_id;
  if (!appId) throw new Error('could not derive app id from token: ' + JSON.stringify(d?.error || d).slice(0, 160));
  return appId;
}

// Upload image bytes via the Resumable Upload API → returns a header handle
// usable as a template header example.
async function uploadHeaderHandle(token, appId, buffer, mime) {
  // 1) open an upload session
  const startRes = await fetch(`${GRAPH}/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mime)}`, {
    method: 'POST', headers: { Authorization: 'OAuth ' + token }
  });
  const start = await startRes.json();
  if (!start?.id) throw new Error('upload session failed: ' + JSON.stringify(start?.error || start).slice(0, 160));
  // 2) upload the bytes at offset 0
  const upRes = await fetch(`${GRAPH}/${start.id}`, {
    method: 'POST',
    headers: { Authorization: 'OAuth ' + token, file_offset: '0' },
    body: buffer
  });
  const up = await upRes.json();
  if (!up?.h) throw new Error('upload failed: ' + JSON.stringify(up?.error || up).slice(0, 160));
  return up.h;
}

async function fetchImageBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`image fetch ${r.status} for ${url}`);
  const mime = r.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, mime: mime.split(';')[0] };
}

// Create (submit for approval) the weekly carousel digest template.
// env: { TOKEN, PHONE_ID, WABA_ID }
export async function createCarouselDigest(env, { name, sampleImageUrl }) {
  const token = env.TOKEN;
  const wabaId = env.WABA_ID || (await (await fetch(`${GRAPH}/${env.PHONE_ID}?fields=whatsapp_business_account`, { headers: { Authorization: 'Bearer ' + token } })).json())?.whatsapp_business_account?.id;
  if (!wabaId) throw new Error('no WABA id');

  const appId = await deriveAppId(token);
  const { buffer, mime } = await fetchImageBuffer(sampleImageUrl);
  const handle = await uploadHeaderHandle(token, appId, buffer, mime);

  // Every card shares the same structure: image header + one body line + a
  // dynamic "View listing" URL button. Cards are identical at creation; real
  // content is filled per-card at send time.
  const card = {
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } },
      // Card body needs static words around the variable — Meta rejects a body
      // that is 100% variable (words-to-variables ratio, subcode 2388293).
      { type: 'BODY', text: '{{1}}\nTap below for photos and live availability.', example: { body_text: [['Villa Saturno in Padang Linjong -- 40jt/month, 3BR sleeps 6']] } },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'View listing', url: `${PORTAL_ORIGIN}/?property={{1}}`, example: [`${PORTAL_ORIGIN}/?property=villa-saturno`] }
      ]}
    ]
  };
  const cards = Array.from({ length: CAROUSEL_CARD_COUNT }, () => card);

  const body = {
    name,
    language: 'en',
    category: 'MARKETING',
    components: [
      { type: 'BODY',
        text: 'Good morning {{1}}. Here is this week\'s Samba Rentals availability -- swipe through, tap any villa to see photos and live calendars, and share straight to a client. 10% commission on every rental closed.',
        example: { body_text: [['Wayan']] } },
      { type: 'CAROUSEL', cards }
    ]
  };

  const r = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const created = await r.json();
  if (!r.ok) {
    const e = created?.error || {};
    throw new Error(`${e.message || 'carousel create failed'} | ${e.error_user_title || ''} :: ${e.error_user_msg || ''} | subcode ${e.error_subcode || '?'}`.slice(0, 400));
  }
  return { id: created.id, status: created.status, name, cards: CAROUSEL_CARD_COUNT };
}

// Build the N villa cards for the weekly carousel — ALWAYS a full carousel.
// Available-today villas lead (so the "availability" framing holds for the
// first cards), then the rest of the portfolio fills the remaining slots so
// the message is never a half-empty carousel or a text fallback. Every listing
// carries a cover photo, so N cards are always reachable. Returns null only if
// the portal itself is unreachable (the caller then text-falls-back so the
// Monday send can never error).
export async function topAvailableVillas(digestProperties, n = CAROUSEL_CARD_COUNT) {
  let listings = [];
  try {
    const r = await fetch(`${PORTAL_ORIGIN}/api/listings`);
    listings = await r.json();
    if (!Array.isArray(listings)) listings = listings.listings || [];
  } catch (_) { return null; }
  const bySlug = {};
  listings.forEach(l => { if (l.slug) bySlug[l.slug] = l; });

  const props = (digestProperties || []).filter(p => p && p.slug && !p.isHidden);
  // Available-today first, then everything else — preserving portal order.
  const ordered = [
    ...props.filter(p => p.availability?.availableToday),
    ...props.filter(p => !p.availability?.availableToday),
  ];
  const cards = [];
  const seen = new Set();
  const pushCard = (slug, name, area, monthly, unitType, badge) => {
    if (seen.has(slug) || cards.length >= n) return;
    const l = bySlug[slug];
    const cover = l?.coverPhotoId ? coverPhotoUrl(l.coverPhotoId) : null;
    if (!cover) return;                          // no image → skip
    seen.add(slug);
    const beds = (unitType || l?.unitType) ? String(unitType || l.unitType).match(/\d+\s*(?:BR|bed)/i)?.[0] : '';
    const rate = monthly || l?.monthly || '';
    const detail = [rate && `${rate}/mo`, beds].filter(Boolean).join(', ') || 'monthly rental';
    cards.push({ name: name || l?.name, area: area || l?.location || '', detail, slug, imageUrl: cover, badge: l?.badge || null });
  };
  // 1) availability-ordered properties from the digest
  ordered.forEach(p => pushCard(p.slug, p.name, p.area, p.monthly, null, null));
  // 2) top up from the raw portal listings so the carousel is always full
  for (const l of listings) { if (cards.length >= n) break; pushCard(l.slug, l.name, l.location, l.monthly, l.unitType); }

  return cards.length === n ? cards : null;
}

// Build CAROUSEL_CARD_COUNT cards straight from the portal listings (no
// availability filter) — used for test sends / previews of the carousel.
export async function listingCarouselCards(n = CAROUSEL_CARD_COUNT) {
  let listings = [];
  try {
    const r = await fetch(`${PORTAL_ORIGIN}/api/listings`);
    listings = await r.json();
    if (!Array.isArray(listings)) listings = listings.listings || [];
  } catch (_) { return null; }
  const cards = [];
  for (const l of listings) {
    if (!l.coverPhotoId) continue;
    const rate = l.monthly ? `${l.monthly}/mo` : 'monthly rental';
    const detail = [rate, l.unitType].filter(Boolean).join(', ');
    cards.push({ name: l.name, area: l.location || '', detail, slug: l.slug, imageUrl: coverPhotoUrl(l.coverPhotoId), badge: l.badge || null });
    if (cards.length === n) break;
  }
  return cards.length === n ? cards : null;
}

// A villa slug → its portal cover image (Meta-fetchable), for image-header
// template sends. Returns null if the slug or cover photo is unknown.
export async function heroImageForSlug(slug) {
  if (!slug) return null;
  try {
    const r = await fetch(`${PORTAL_ORIGIN}/api/listings`);
    let listings = await r.json();
    if (!Array.isArray(listings)) listings = listings.listings || [];
    const l = listings.find(x => x.slug === slug);
    return l?.coverPhotoId ? coverPhotoUrl(l.coverPhotoId) : null;
  } catch (_) { return null; }
}

// Create (submit) a single-image-header marketing template: a large hero image
// on top, body copy, and a dynamic "View listing" URL button. The example image
// is uploaded via Resumable Upload (same machinery as the carousel).
export async function createMediaTemplate(env, { name, body, example, sampleImageUrl, buttonText, buttonBase, buttonExampleUrl }) {
  const token = env.TOKEN;
  const wabaId = env.WABA_ID;
  if (!wabaId) throw new Error('no WABA id');
  const appId = await deriveAppId(token);
  const { buffer, mime } = await fetchImageBuffer(sampleImageUrl);
  const handle = await uploadHeaderHandle(token, appId, buffer, mime);

  const components = [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } },
    { type: 'BODY', text: body, ...(Array.isArray(example) && example.length ? { example: { body_text: [example] } } : {}) },
    { type: 'BUTTONS', buttons: [
      { type: 'URL', text: buttonText || 'View listing', url: `${buttonBase || (PORTAL_ORIGIN + '/?property=')}{{1}}`, example: [buttonExampleUrl || `${PORTAL_ORIGIN}/?property=villa-saturno`] }
    ]}
  ];
  const r = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language: 'en', category: 'MARKETING', components })
  });
  const created = await r.json();
  if (!r.ok) {
    const e = created?.error || {};
    throw new Error(`${e.message || 'media template create failed'} :: ${e.error_user_msg || ''} | subcode ${e.error_subcode || '?'}`.slice(0, 300));
  }
  return { id: created.id, status: created.status, name };
}

// Build the send-time `components` for a carousel message.
// villas: [{ name, area, detail, slug, imageUrl }] — exactly CAROUSEL_CARD_COUNT of them.
// intro (optional): the {{1}} body line — a single line, no newlines (Meta rejects
// them in template params). Defaults to just the first name.
export function buildCarouselComponents(firstName, villas, intro) {
  const bodyText = (intro && String(intro).replace(/[\r\n\t]+/g, ' ').trim()) || firstName;
  return [
    { type: 'body', parameters: [{ type: 'text', text: bodyText }] },
    { type: 'carousel', cards: villas.slice(0, CAROUSEL_CARD_COUNT).map((v, i) => {
      // The villa name already carries the location ("HAUS Canggu – Unit 1"),
      // and the portal's `area`/`location` field is sometimes a maps URL — so
      // the card line is just name + rate/type, never a raw link. A manual
      // badge from the portal admin leads the line in caps: "PRICE DROP".
      const areaClean = v.area && !/^https?:|maps\./i.test(v.area) ? v.area : '';
      const badge = v.badge ? `${String(v.badge).toUpperCase()} -- ` : '';
      const line = `${badge}${v.name}${areaClean ? ` (${areaClean})` : ''}\n${v.detail}`;
      return {
        card_index: i,
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: v.imageUrl } }] },
          { type: 'body', parameters: [{ type: 'text', text: line }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: v.slug }] }
        ]
      };
    }) }
  ];
}
