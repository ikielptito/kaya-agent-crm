// "Your listing is live" — Maya congratulates the owner the first time one of
// their listings goes public, with the link, how the weekly report works, how
// to check performance in the owner portal, and what is still missing from
// the listing. Ikiel, 23 Aug 2026.
//
// Trigger: the portal fires a listing-sync for the slug on every admin save
// (including Approve). api/supabase.js calls announceListingLive() after the
// sync; it sends once per slug (settings.listing_live_announced) and only for
// owner listings (custom, with an owner number) that are now in the public
// feed. Delivery rides on the relay transport so a shut 24h window is handled
// by the approved re-opener template (the full message follows on reply).

import { fetchPortalListings } from './rental-sync.js';
import { openRelay, LISTING_LIVE_PREFIX } from './relay.js';

const PORTAL = 'https://sambarentals.com';

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
const norm = (n) => String(n || '').replace(/\D/g, '');

// What the listing still lacks, as short phrases in the owner's language.
export function missingForListing(l, lang) {
  const id = lang === 'id';
  const out = [];
  if (!String(l.overview || '').trim() || String(l.overview || '').trim().length < 80) out.push(id ? 'deskripsi singkat villa (cocok untuk tamu seperti apa, apa yang istimewa)' : 'a short description (who the villa suits, what stands out)');
  if (!l.folder) out.push(id ? 'foto-foto villa' : 'photos');
  if (!l.icalUrl) out.push(id ? 'link kalender (iCal dari Airbnb/Booking) — atau kabari saya tanggal yang sudah terisi' : 'a calendar link (Airbnb/Booking iCal) — or just tell me which dates are taken');
  if (!String(l.yearly || '').trim()) out.push(id ? 'harga sewa per tahun (kalau ada)' : 'a yearly rate (if you offer one)');
  const facts = [['deposit', id ? 'deposit' : 'deposit'], ['electricity', id ? 'ketentuan listrik' : 'electricity terms'], ['wifi', id ? 'kecepatan wifi' : 'wifi speed'], ['pool', id ? 'kolam (private/shared)' : 'pool (private/shared)'], ['minStay', id ? 'minimum sewa' : 'minimum stay']];
  const f = facts.filter(([k]) => !String(l[k] || '').trim()).map(([, label]) => label);
  if (f.length) out.push((id ? 'detail: ' : 'key facts: ') + f.join(', '));
  if (l.petFriendly !== true && l.petFriendly !== false) out.push(id ? 'boleh bawa hewan peliharaan atau tidak' : 'whether pets are allowed');
  return out;
}

export function buildLiveMessage(l, owner) {
  const id = (owner.lang || '').toLowerCase() === 'id';
  const link = `${PORTAL}/l/${l.slug}`;
  const missing = missingForListing(l, id ? 'id' : 'en');
  if (id) {
    return `selamat — *${l.name}* sudah tayang di Samba Rentals! 🎉 Agen-agen di jaringan kami sekarang bisa melihatnya di ${link} dan mulai menawarkan ke klien mereka; saya juga akan menyertakannya dalam update ketersediaan yang saya kirim ke para agen.

Dua hal yang perlu Bapak/Ibu tahu:
• Setiap Senin pagi saya kirim laporan mingguan lewat WhatsApp ini: berapa agen yang melihat listing, berapa yang membagikannya, dan pertanyaan yang masuk.
• Performa listing bisa dicek kapan saja di ${PORTAL}/portal — masuk dengan Google memakai email${owner.email ? ` ${owner.email}` : ' yang sudah didaftarkan'}. Di sana juga bisa mengubah harga, foto, dan tanggal yang sudah terisi.

${missing.length ? `Supaya listing-nya makin kuat di mata agen, ada beberapa hal yang belum ada: ${missing.join('; ')}. Kirim saja di sini kapan pun ada waktu, nanti saya masukkan.` : 'Listing-nya sudah lengkap — kalau ada yang ingin diubah, tinggal kabari saya di sini.'}`;
  }
  return `congratulations — *${l.name}* is now live on Samba Rentals! 🎉 Agents across our network can see it at ${link} and start offering it to their clients; I'll also include it in the availability updates I send them.

Two things worth knowing:
• Every Monday morning I'll send you a short report here on WhatsApp: how many agents viewed the listing, how many shared it, and any enquiries.
• You can check performance any time at ${PORTAL}/portal — sign in with Google using${owner.email ? ` ${owner.email}` : ' the email you registered'}. You can also update the price, photos and booked dates there.

${missing.length ? `To make the listing as strong as possible for agents, a few things are still missing: ${missing.join('; ')}. Just send them here whenever convenient and I'll add them.` : 'The listing is complete — if you ever want to change anything, just tell me here.'}`;
}

// Called after a listing-sync upsert. Returns a small summary.
export async function announceListingLive(db, wa, portalSlug) {
  const slug = String(portalSlug || '').trim();
  if (!slug) return { sent: false, reason: 'no slug' };
  const announced = await getSetting(db, 'listing_live_announced');
  if (announced[slug]) return { sent: false, reason: 'already announced' };

  const listings = await fetchPortalListings();            // public feed = live listings only
  const l = listings.find(x => x.slug === slug);
  if (!l) return { sent: false, reason: 'not live' };
  if (!l.custom && !l.waNumber) return { sent: false, reason: 'not an owner listing' };

  const num = norm(l.waNumber);
  let owner = null;
  const rows = await sbGet(db, `owners?select=*&or=(listing_slugs.cs.{${slug}}${num ? `,wa_num.eq.${num}` : ''})&limit=5`);
  owner = (Array.isArray(rows) ? rows : []).find(o => (o.listing_slugs || []).includes(slug)) || (Array.isArray(rows) ? rows[0] : null);
  if (!owner) return { sent: false, reason: 'no owner record' };

  const body = buildLiveMessage(l, owner);
  const res = await openRelay(db, wa, {
    agent: null, question: LISTING_LIVE_PREFIX + body, slug,
    propertyName: l.name, contactName: owner.name || '', contactWa: owner.wa_num, ownerId: owner.id,
  });
  if (res.ok) {
    announced[slug] = new Date().toISOString();
    await setSetting(db, 'listing_live_announced', announced);
    await fetch(`${db.SUPABASE_URL}/rest/v1/owners?id=eq.${owner.id}`, {
      method: 'PATCH', headers: db.sbHeaders, // We just promised a Monday report and portal access — make sure both are on.
      body: JSON.stringify({ onboarding_status: 'listed', opt_in: true, report_enabled: true, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }
  return { sent: !!res.ok, status: res.status, reason: res.reason, owner: owner.id, missing: missingForListing(l, owner.lang) };
}

// ── New arrivals ─────────────────────────────────────────────────────────
// Any listing seen live for the first time (owner-listed or admin-added) is
// queued in settings.new_arrivals_pending; the daily 9am pass sends the
// "New arrivals on Samba Rentals" carousel for everything queued (see
// lib/new-arrivals.js). The seen-set is seeded once with every listing live
// at install time so the existing catalogue never broadcasts as new.
export async function noteNewArrivals(db, slugsLiveNow) {
  const seen = await getSetting(db, 'new_arrivals_seen');
  const pending = await getSetting(db, 'new_arrivals_pending');
  const slugs = (slugsLiveNow || []).filter(Boolean);
  let added = 0;
  if (!seen.__seeded) {
    slugs.forEach(s => { seen[s] = 'seed'; });
    seen.__seeded = new Date().toISOString();
  } else {
    for (const s of slugs) {
      if (seen[s]) continue;
      seen[s] = new Date().toISOString();
      pending[s] = new Date().toISOString();
      added++;
    }
  }
  await setSetting(db, 'new_arrivals_seen', seen);
  if (added) await setSetting(db, 'new_arrivals_pending', pending);
  return { added, pending: Object.keys(pending) };
}
