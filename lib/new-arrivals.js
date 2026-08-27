// "New arrivals on Samba Rentals" — a dedicated broadcast for listings that
// just went live, sent the next 9am (WITA) pass instead of being one bullet
// in an availability alert that only fires when three things changed.
//
// Format: the approved six-card carousel template, led by the new villa(s)
// with a NEW badge and padded with current openings so the template is full.
// Audience: the same eligibility as event alerts (opted in, not capped, tier
// allows event alerts, not on a weekly/monthly/paused frequency), and it
// stamps last_availability_alert_at so it counts toward the alert cadence.
// Ikiel, 23 Aug 2026: "they should be advertised to agents as a new listing
// that was just added to the platform".

import { fetchPortalListings } from './rental-sync.js';
import { coverPhotoUrl, buildCarouselComponents, CAROUSEL_CARD_COUNT } from './wa-carousel.js';

const CAROUSEL_TEMPLATE = 'samba_weekly_carousel_v1';      // fixed greeting baked in
const CAROUSEL_TEMPLATE_V2 = 'samba_weekly_carousel_v2';   // neutral body: intro renders once
const GRAPH = 'https://graph.facebook.com/v24.0';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}
async function getSetting(db, key) {
  return (await sbGet(db, `settings?key=eq.${key}&select=value`))?.[0]?.value || {};
}
async function setSetting(db, key, value) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}
function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0] || '';
  return n.replace(/^(I|Ni)$/i, '') || 'there';
}
function cardFor(l, badge) {
  if (!l || !l.coverPhotoId) return null;
  const beds = l.unitType ? String(l.unitType).match(/\d+\s*(?:BR|bed)/i)?.[0] : '';
  const rate = l.monthly ? `${l.monthly}/mo` : '';
  const detail = [rate, beds || l.unitType].filter(Boolean).join(', ') || 'monthly rental';
  // `tag` is the human area ("Ungasan, Bukit Peninsula"); `location` is
  // almost always a maps URL, so it's only a fallback when it reads clean.
  const area = (l.tag || '').trim() || (l.location && !/^https?:|maps\./i.test(l.location) ? l.location : '');
  return { name: l.name, area, detail, slug: l.slug, imageUrl: coverPhotoUrl(l.coverPhotoId), badge: badge || l.badge || null };
}

// Build the cards: new ones first (NEW badge), then current openings.
export async function buildNewArrivalCards(newSlugs, digestProperties) {
  const listings = await fetchPortalListings();
  const bySlug = Object.fromEntries(listings.map(l => [l.slug, l]));
  const cards = [];
  const seen = new Set();
  for (const s of newSlugs) {
    const c = cardFor(bySlug[s], 'NEW');
    if (c && !seen.has(s)) { cards.push(c); seen.add(s); }
    if (cards.length >= CAROUSEL_CARD_COUNT) break;
  }
  const newCount = cards.length;
  if (!newCount) return { cards: null, newCount: 0 };
  const order = [
    ...((digestProperties || []).filter(p => p.availability?.availableToday).map(p => p.slug)),
    ...listings.map(l => l.slug),
  ];
  for (const s of order) {
    if (cards.length >= CAROUSEL_CARD_COUNT) break;
    if (seen.has(s)) continue;
    const c = cardFor(bySlug[s]);
    if (c) { cards.push(c); seen.add(s); }
  }
  return { cards: cards.length === CAROUSEL_CARD_COUNT ? cards : null, newCount };
}

// Daily. `eligible` = agents already filtered by the cron's event-alert rules.
export async function sendNewArrivals(db, wa, { eligible, digestProperties, previewMode = false, templatesMap = {}, campaign = null }) {
  const pending = await getSetting(db, 'new_arrivals_pending');
  const slugs = Object.keys(pending);
  if (!slugs.length) return { ran: false, reason: 'nothing pending' };
  const { cards, newCount } = await buildNewArrivalCards(slugs, digestProperties);
  if (!cards) return { ran: false, reason: 'could not build a full carousel (cover photos?)', pending: slugs };
  if (previewMode) return { ran: false, preview: true, pending: slugs, recipients: eligible.length };

  const names = cards.slice(0, newCount).map(c => c.name);
  const out = { ran: true, new: slugs, recipients: eligible.length, sent: 0, failed: 0, errors: [] };
  // v2 template renders the intro as the whole body; v1 bakes its own
  // greeting + pitch around {{1}}, so passing a sentence there produced
  // "Good morning Hi Wayan, …" — on v1 send only the bare first name.
  const useV2 = !!templatesMap[CAROUSEL_TEMPLATE_V2];
  const sendTemplate = useV2 ? CAROUSEL_TEMPLATE_V2 : CAROUSEL_TEMPLATE;
  for (const agent of eligible) {
    const fn = firstName(agent.name);
    const intro = !useV2 ? fn : (newCount === 1
      ? `Hi ${fn}, new arrival on Samba Rentals — ${names[0]} was just added to the platform. First look for our agents (10% commission built into the price)`
      : `Hi ${fn}, new arrivals on Samba Rentals — ${names.join(' and ')} were just added to the platform. First look for our agents (10% commission built into the price)`);
    const components = buildCarouselComponents(fn, cards, intro);
    try {
      const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: agent.wa_num, type: 'template', template: { name: sendTemplate, language: { code: 'en' }, components } }),
      });
      const j = await r.json().catch(() => ({}));
      const mid = r.ok ? (j.messages?.[0]?.id || null) : null;
      if (!mid) { out.failed++; if (out.errors.length < 5) out.errors.push(j.error?.message || `HTTP ${r.status}`); continue; }
      out.sent++;
      await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: db.sbHeaders,
        body: JSON.stringify({ agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound', content: `[[carousel]]${JSON.stringify({ title: 'New arrivals on Samba Rentals', cards: cards.map(c => ({ title: c.name, subtitle: [c.detail, c.area].filter(Boolean).join(' · '), image: c.imageUrl, url: `https://sambarentals.com/?property=${c.slug}`, badge: c.badge })) })}`, wa_message_id: mid, timestamp: new Date().toISOString(), source: 'cron', category: 'new_arrivals', template_name: sendTemplate, status: 'sent', campaign_id: campaign?.id || null }),
      }).catch(() => {});
      await fetch(`${db.SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
        method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify({ last_availability_alert_at: new Date().toISOString() }),
      }).catch(() => {});
    } catch (e) { out.failed++; if (out.errors.length < 5) out.errors.push(e.message); }
  }
  // Clear the queue; remember what was announced so the day's availability
  // alert doesn't repeat it as "New: …".
  const announced = await getSetting(db, 'new_arrivals_announced');
  slugs.forEach(s => { announced[s] = new Date().toISOString(); });
  await setSetting(db, 'new_arrivals_announced', announced);
  await setSetting(db, 'new_arrivals_pending', {});
  if (campaign) {
    const { noteRun } = await import('./campaigns.js');
    await noteRun(db, campaign, { sent: out.sent, failed: out.failed, summary: { sent: out.sent, failed: out.failed, new: slugs } }).catch(() => {});
  }
  return out;
}
