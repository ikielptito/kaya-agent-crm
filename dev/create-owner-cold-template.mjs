#!/usr/bin/env node
// Submit the cold owner-outreach intro (samba_owner_cold_v1) to Meta — EN and
// ID language versions of the same template name. This unblocks the cold
// pipeline: send_onboard_intro deliberately 409s on cold prospects until a
// samba_owner_cold* template is APPROVED (the warm template overclaims).
//
// The body is deliberately ORIGIN-FREE — it works for both a scraped-ad cold
// prospect and an agent-referred owner; Maya explains the true origin in the
// conversation that follows (buildOnboardingPitch handles both framings).
// {{1}} = owner first name. Dynamic URL button: base + suffix — the sender in
// send_onboard_intro passes suffix "portal", so the base lands on /home?ref=.
//
// Run with a working console key or LISTING_SYNC_SECRET:
//   KEY=<console-or-sync-secret> node dev/create-owner-cold-template.mjs
//   node dev/create-owner-cold-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_cold_v1';

const BODIES = {
  en: `Hi {{1}}, I'm Maya from Samba Rentals (sambarentals.com). We introduce Bali villas to 300+ rental agents who bring long-term tenants — and the owner keeps every rupiah: no commission to us, no booking fees. The first 25 founding villas list free, for good.

Would you be open to a quick look at how it works?`,
  id: `Halo {{1}}, saya Maya dari Samba Rentals (sambarentals.com). Kami memperkenalkan villa di Bali ke 300+ agen sewa yang membawa penyewa jangka panjang — dan pemilik menerima penuh: tanpa komisi ke kami, tanpa biaya booking. 25 villa founding pertama tercantum gratis, selamanya.

Boleh saya jelaskan singkat cara kerjanya?`,
};

const BUTTON = {
  text: 'See how it works',
  urlBase: 'https://sambarentals.com/home?ref=',
  exampleUrl: 'https://sambarentals.com/home?ref=portal',
};

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const ts = (j.templates || []).filter((x) => x.name === NAME);
  if (!ts.length) return console.log(`${NAME} not found yet.`);
  ts.forEach((t) => console.log(`${NAME} [${t.language}] -> ${t.status}${t.quality ? ' quality ' + t.quality : ''}`));
}

async function create() {
  const KEY = process.env.KEY;
  if (!KEY) { console.error('Set KEY to the console key or LISTING_SYNC_SECRET.'); process.exit(1); }
  for (const [language, body] of Object.entries(BODIES)) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-console-key': KEY, Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        action: 'create', name: NAME, category: 'MARKETING', language,
        body, example: [language === 'id' ? 'Wayan' : 'Sarah'], button: BUTTON,
      }),
    });
    const j = await r.json();
    console.log(language, '->', r.status, JSON.stringify(j).slice(0, 200));
  }
  console.log('Meta review usually minutes to hours. Check: node dev/create-owner-cold-template.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
