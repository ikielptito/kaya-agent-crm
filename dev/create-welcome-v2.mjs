#!/usr/bin/env node
// Submit the new agent-onboarding welcome template (samba_agent_welcome_v2) to
// Meta for approval. Bilingual EN + ID, {{1}} = agent first name.
//
// This is the FIRST message a recruited agent receives (fired by quick_add_agent
// when you add their number in the CRM). It introduces Maya as Ikiel's assistant,
// references the Facebook conversation where you asked for their WhatsApp, explains
// the Samba Agent Portal, and links it. Once Meta approves it, pickWelcomeTemplate()
// switches onboarding to it automatically (no code change).
//
// Run with your Vercel LISTING_SYNC_SECRET (the same secret used for portal sync):
//   SYNC_SECRET=xxxxxxxx node dev/create-welcome-v2.mjs
// Optionally check status afterwards:
//   node dev/create-welcome-v2.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';

// Meta caps template BODY at 1,024 chars, so the bilingual copy is kept tight.
const BODY = `Hi {{1}}, I'm Maya, Ikiel's assistant at Samba Realty. Ikiel mentioned you were interested in listing some of our rental villas.

Our Agent Portal has every villa's photos, materials and live availability in one place. You deal with your client directly and can share a custom listing link with them. Commission is 10%, already in the price you quote.

Take a look: https://sambarentals.com

Which area do your clients usually look in?

---

Halo {{1}}, saya Maya, asisten Ikiel di Samba Realty. Kata Ikiel, Anda tertarik memasarkan villa sewa kami.

Agent Portal kami memuat foto, materi, dan ketersediaan real-time tiap villa di satu tempat. Anda berkomunikasi langsung dengan klien dan bisa membagikan link listing khusus. Komisi 10%, sudah termasuk harga.

Lihat di sini: https://sambarentals.com

Klien Anda biasanya cari di area mana?`;

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === 'samba_agent_welcome_v2');
  if (!t) return console.log('samba_agent_welcome_v2 not found yet.');
  console.log(`samba_agent_welcome_v2 -> status: ${t.status}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved. Onboarding now uses v2 automatically.');
  else console.log('Still pending Meta review. Re-run `node dev/create-welcome-v2.mjs status` to check.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-welcome-v2.mjs');
    process.exit(1);
  }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({
      action: 'create',
      name: 'samba_agent_welcome_v2',
      category: 'MARKETING',
      language: 'en',
      body: BODY,
      example: ['Wayan'],
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log('Submitted samba_agent_welcome_v2:', JSON.stringify(j));
  console.log('Meta review is usually minutes to a few hours. Check with:\n  node dev/create-welcome-v2.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
