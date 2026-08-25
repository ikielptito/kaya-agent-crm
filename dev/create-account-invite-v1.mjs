#!/usr/bin/env node
// Submit the dormant-reactivation account invite (samba_account_invite_v1) to
// Meta for approval. Bilingual EN + ID, {{1}} = agent first name, plus a URL
// button whose dynamic suffix carries the CRM agent id so the portal
// attributes the visit (?signin=1&ref=acct_invite&aid=<id>).
//
// Sent by the account-invite sweep in cron-followups.js: a capped daily batch
// of dormant/cold agents, one invite per agent ever. The sweep stays off until
// settings.samba_availability.account_invite_daily_cap is a positive number
// AND Meta approves this template.
//
// Run with your Vercel LISTING_SYNC_SECRET (same secret as portal sync):
//   SYNC_SECRET=xxxxxxxx node dev/create-account-invite-v1.mjs
// Check status afterwards:
//   node dev/create-account-invite-v1.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_account_invite_v1';

// Meta caps template BODY at 1,024 chars, so the bilingual copy is kept tight.
const BODY = `Hi {{1}}, Maya from Samba Realty here. Agent accounts are now live on the Samba portal — free, one tap with Google.

Your account gets you:
- Your own share link — every click and enquiry credited to you
- One-tap Instagram stories with your name, photo and WhatsApp on the card
- Client shortlists you send as one link
- Your own live stats: clicks and enquiries

Commission stays 10%, already in the price.

---

Halo {{1}}, Maya dari Samba Realty. Akun agen kini hadir di portal Samba — gratis, sekali ketuk dengan Google.

Dengan akun Anda:
- Link share pribadi — setiap klik dan inquiry tercatat atas nama Anda
- Story Instagram sekali ketuk dengan nama, foto, dan WhatsApp Anda
- Shortlist untuk klien, cukup kirim satu link
- Statistik Anda real-time: klik dan inquiry

Komisi tetap 10%, sudah termasuk harga.`;

const BUTTON = {
  text: 'Create my account',
  urlBase: 'https://sambarentals.com/?signin=1&ref=acct_invite&aid=',
  exampleUrl: 'https://sambarentals.com/?signin=1&ref=acct_invite&aid=123',
};

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved. The sweep starts on the next daily pass once account_invite_daily_cap is set.');
  else console.log(`Still pending Meta review. Re-run \`node dev/create-account-invite-v1.mjs status\` to check.`);
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-account-invite-v1.mjs');
    process.exit(1);
  }
  console.log(`Body length: ${BODY.length}/1024`);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({
      action: 'create',
      name: NAME,
      category: 'MARKETING',
      language: 'en',
      body: BODY,
      example: ['Wayan'],
      button: BUTTON,
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log('Meta review is usually minutes to a few hours. Check with:\n  node dev/create-account-invite-v1.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
