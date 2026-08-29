#!/usr/bin/env node
// Submit the four tukang-dispatch templates to Meta for approval.
//
// These are what let Maya start a conversation with a tradesman who has not
// messaged us in the last 24 hours, which is almost always the case: a repair
// is approved days after anyone last spoke to him.
//
// THREE OF THEM ARE INDONESIAN (language "id"). BTC Electric and Dian do not
// read English, and a work order nobody understands is worse than none. Only
// the update to Era is in English.
//
// Nothing is phrased as a code or a one-time password. The owner login
// template taught us that Meta force-classifies anything code-shaped as
// AUTHENTICATION and then refuses to deliver it to some countries, so the
// job link rides a URL button instead.
//
// Run with your Vercel LISTING_SYNC_SECRET:
//   SYNC_SECRET=xxxxxxxx node dev/create-tukang-templates.mjs
// Then check on them:
//   node dev/create-tukang-templates.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';

const TEMPLATES = [
  {
    name: 'samba_tukang_job',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, ada permintaan perbaikan dari Samba Realty.

Lokasi: {{1}}
Pekerjaan: {{2}}
Perkiraan biaya: {{3}}

Foto dan detail lengkapnya ada di tombol bawah ini. Balas pesan ini dengan hari dan jam kapan Anda bisa datang. Terima kasih.`,
    example: ['Villa Saturno', 'Pompa kolam bocor', 'IDR 1.200.000'],
    button: {
      text: 'Lihat detail',
      urlBase: 'https://sambarentals.com/j/',
      exampleUrl: 'https://sambarentals.com/j/43~a1b2c3d4e5f60718',
    },
  },
  {
    name: 'samba_tukang_reminder',
    language: 'id',
    category: 'UTILITY',
    body: `Pengingat dari Samba Realty.

Hari ini ada perbaikan di {{1}}, dijadwalkan {{2}}.

Kalau ada perubahan, balas saja pesan ini. Terima kasih.`,
    example: ['Villa Saturno', 'Rabu, 2 September, pukul 09:00 WITA'],
  },
  {
    name: 'samba_tukang_followup',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, mau menanyakan soal perbaikan di {{1}}.

Pekerjaannya: {{2}}

Sudah dikerjakan atau belum? Balas saja di sini, terima kasih.`,
    example: ['Villa Saturno', 'Pompa kolam bocor'],
  },
  {
    name: 'samba_tukang_cancel',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, ada perubahan dari Samba Realty.

Perbaikan di {{1}} ({{2}}) sudah tidak jadi untuk Anda, jadi tidak perlu datang.

Maaf atas ketidaknyamanannya, dan terima kasih.`,
    example: ['Villa Saturno', 'Pompa kolam bocor'],
  },
  {
    name: 'samba_staff_dispatch_update',
    language: 'en',
    category: 'UTILITY',
    body: `An update on the repair at {{1}}.

Job: {{2}}
{{3}}

Open the payouts cockpit if you need to change anything.`,
    example: ['Villa Saturno', 'Pool pump service', 'Dian confirmed: Wednesday 2 September, 09:00 WITA.'],
  },
];

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  for (const t of TEMPLATES) {
    const found = (j.templates || []).find(x => x.name === t.name);
    if (!found) { console.log(`${t.name.padEnd(30)} not found yet`); continue; }
    console.log(`${t.name.padEnd(30)} ${found.status}${found.category ? ' · ' + found.category : ''}`);
  }
  console.log('\nThe dispatch queues skip any template that is not APPROVED, so the');
  console.log('rest of the maintenance sweep keeps running while these are pending.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-tukang-templates.mjs');
    process.exit(1);
  }
  for (const t of TEMPLATES) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({ action: 'create', ...t }),
    });
    const j = await r.json();
    console.log(`${t.name.padEnd(30)} ${r.ok ? 'submitted' : 'FAILED'} ${JSON.stringify(j).slice(0, 200)}`);
  }
  console.log('\nMeta review is usually minutes to a few hours. Check with:\n  node dev/create-tukang-templates.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
