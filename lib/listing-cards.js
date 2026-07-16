// Shared listing-card machinery — the ONE way a single property gets sent to
// an agent as rich media, used by:
//   - Maya's autoresponder (send_cards in her reply JSON, whatsapp-webhook.js)
//   - the console's "Send listing (card)" picker (api/supabase.js)
//   - draft-approved card sends from the inbox (api/whatsapp-send.js 'cards')
//
// A card is sent as an interactive CTA-URL message: hero photo header, a short
// name/rate body, and a NATIVE "View listing" button that opens the portal
// listing — the premium in-session equivalent of the broadcast carousel cards.
// If Meta rejects the interactive shape, we fall back to image+caption so the
// agent always gets something. Every send is logged with the [[card]] marker
// (cardMarker) so the console inbox renders a real card, not raw JSON.

import { coverPhotoUrl } from './wa-carousel.js';

const GRAPH = 'https://graph.facebook.com/v19.0';
const PORTAL_ORIGIN = 'https://sambarentals.com';

// Portal listings → card objects { slug, title, subtitle, image, url, badge }.
// Warm-container cache: the portal is fetched at most once per 5 minutes.
let _cardsCache = null;
let _cardsCacheAt = 0;
const CARDS_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchPortalCards() {
  const now = Date.now();
  if (_cardsCache && (now - _cardsCacheAt) < CARDS_CACHE_TTL_MS) return _cardsCache;
  const r = await fetch(`${PORTAL_ORIGIN}/api/listings`);
  let listings = await r.json();
  if (!Array.isArray(listings)) listings = listings.listings || [];
  const cards = listings
    .filter(l => l && l.slug && !l.isHidden)
    .map(l => {
      const rate = l.monthly ? `${l.monthly}/mo` : 'Monthly rental';
      // tag is the human area ("Batu Bolong, Canggu"); location is often a maps URL.
      const area = l.tag && !/^https?:/i.test(l.tag) ? l.tag : null;
      const subtitle = [rate, l.unitType, area].filter(Boolean).join(' · ');
      return {
        slug: l.slug,
        title: l.name || l.slug,
        subtitle,
        image: l.coverPhotoId ? coverPhotoUrl(l.coverPhotoId) : null,
        url: `${PORTAL_ORIGIN}/?property=${l.slug}`,
        badge: l.badge || null,
      };
    });
  _cardsCache = cards;
  _cardsCacheAt = now;
  return cards;
}

// Slugs arrive in two dialects: portal kebab-case (villa-saturno) and DB
// snake_case (villa_saturno) — Maya sees both in her context. Normalise to
// the portal form so either resolves.
export function normSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/^.*property=/, '').replace(/_/g, '-');
}

// Resolve up to `max` slugs to card objects, preserving order, deduped.
// Unknown slugs are silently dropped (never block the other cards).
export async function resolveListingCards(slugs, max = 4) {
  const cards = await fetchPortalCards();
  const bySlug = {};
  cards.forEach(c => { bySlug[normSlug(c.slug)] = c; });
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(slugs) ? slugs : []) {
    const key = normSlug(s);
    if (!key || seen.has(key) || !bySlug[key]) continue;
    seen.add(key);
    out.push(bySlug[key]);
    if (out.length >= max) break;
  }
  return out;
}

// The inbox marker: wa_messages.content rows that start with [[card]] render
// as a rich card in chat.html (same convention as the broadcast carousels).
export function cardMarker(card) {
  return '[[card]]' + JSON.stringify({
    title: card.title, subtitle: card.subtitle, image: card.image,
    url: card.url, badge: card.badge,
  });
}

// Send ONE card to one number. env: { PHONE_ID, TOKEN }.
// Returns { waMessageId, format: 'cta_url' | 'image' | 'text' } or { error }.
export async function sendListingCardMessage(env, to, card) {
  const badge = card.badge ? `${String(card.badge).toUpperCase()} -- ` : '';
  const line = `${badge}${card.title}\n${card.subtitle || ''}`.trim();

  // Preferred: interactive CTA-URL — native "View listing" button.
  const interactive = {
    type: 'cta_url',
    ...(card.image ? { header: { type: 'image', image: { link: card.image } } } : {}),
    body: { text: line.slice(0, 1024) },
    footer: { text: 'sambarentals.com' },
    action: { name: 'cta_url', parameters: { display_text: 'View listing', url: card.url } },
  };
  let r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'interactive', interactive }),
  });
  let d = await r.json().catch(() => ({}));
  if (r.ok && d.messages?.[0]?.id) return { waMessageId: d.messages[0].id, format: 'cta_url' };
  const ctaError = d?.error?.message || `HTTP ${r.status}`;

  // Fallback 1: hero image with a caption carrying the link.
  if (card.image) {
    const caption = [`*${card.title}*`, card.subtitle, '', card.url].filter(v => v != null).join('\n');
    r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: card.image, caption } }),
    });
    d = await r.json().catch(() => ({}));
    if (r.ok && d.messages?.[0]?.id) return { waMessageId: d.messages[0].id, format: 'image' };
  }

  // Fallback 2: plain text with the link (never leave the agent card-less).
  r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: `${line}\n${card.url}` } }),
  });
  d = await r.json().catch(() => ({}));
  if (r.ok && d.messages?.[0]?.id) return { waMessageId: d.messages[0].id, format: 'text' };
  return { error: ctaError };
}
