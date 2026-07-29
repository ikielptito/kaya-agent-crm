#!/usr/bin/env node
// Submit the villa-owner onboarding intro template (samba_owner_onboard_v1) to
// Meta for approval. This is the FIRST message a prospect owner receives —
// someone Ikiel already spoke to who verbally agreed to list — fired manually
// from the owner inbox's "Send intro" button (api/supabase send_onboard_intro).
//
// Format: image header (the villa→agents network diagram) + bilingual EN/ID
// body ({{1}} = owner first name) + "See how it works" button → /portal.
// Meta caps BODY at 1,024 chars, so the copy is tight; Maya expands on the
// pitch in conversation once they reply (see lib/owner-onboarding.js).
//
// Run:            SYNC_SECRET=<TEMPLATE_ADMIN_SECRET> node dev/create-owner-onboard-template.mjs
// Check status:   node dev/create-owner-onboard-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_onboard_v1';

const BODY = `Hi {{1}}, I'm Maya, Ikiel's listings coordinator at Samba Rentals. He mentioned you're happy to list your villa with us — wonderful! I'm here to get you set up 🌴

Samba puts your villa in front of 250+ Bali rental agents. Zero commission, ever — agents deal with you directly. Listing is free during pre-launch, and I can set everything up right here in this chat.

Shall I walk you through how it works?

---

Halo {{1}}, saya Maya, koordinator listing Ikiel di Samba Rentals. Kata beliau, Anda setuju memasarkan villa Anda bersama kami — senang sekali! Saya siap membantu 🌴

Samba menampilkan villa Anda ke 250+ agen sewa di Bali. Tanpa komisi — agen berhubungan langsung dengan Anda. Selama pra-peluncuran gratis, dan semua bisa saya urus lewat chat ini.

Boleh saya jelaskan cara kerjanya?`;

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved. The owner inbox "Send intro" button is live.');
  else console.log('Still pending Meta review. Re-run with `status` to check.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-owner-onboard-template.mjs');
    process.exit(1);
  }
  if (BODY.length > 1024) { console.error(`Body too long: ${BODY.length}/1024`); process.exit(1); }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({
      action: 'create_media',
      name: NAME,
      body: BODY,
      example: ['Made'],
      sampleImageUrl: 'https://sambarentals.com/wa/onboard-hero.jpg',
      buttonText: 'See how it works',
      buttonBase: 'https://sambarentals.com/',
      buttonExampleUrl: 'https://sambarentals.com/portal',
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log('Meta review is usually minutes to a few hours. Check with:\n  node dev/create-owner-onboard-template.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
