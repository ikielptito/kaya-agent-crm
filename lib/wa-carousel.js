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

// Build the send-time `components` for a carousel message.
// villas: [{ name, area, detail, slug, imageUrl }] — exactly CAROUSEL_CARD_COUNT of them.
export function buildCarouselComponents(firstName, villas) {
  return [
    { type: 'body', parameters: [{ type: 'text', text: firstName }] },
    { type: 'carousel', cards: villas.slice(0, CAROUSEL_CARD_COUNT).map((v, i) => ({
      card_index: i,
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: v.imageUrl } }] },
        { type: 'body', parameters: [{ type: 'text', text: `${v.name} in ${v.area} -- ${v.detail}` }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: v.slug }] }
      ]
    })) }
  ];
}
