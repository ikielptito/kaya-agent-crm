#!/usr/bin/env node
// Submit the three housekeeping templates to Meta for approval.
//
// All Indonesian: Gede, Naomi, Ita, Ana and Putu do not work in English, and
// a cleaning schedule nobody can read is not a schedule.
//
// Why templates rather than plain messages: the housekeepers rarely message
// Maya first, so the 24-hour window is almost always shut when the morning's
// work needs sending. A template opens it; once she replies, everything else
// that day is free text.
//
// Run with your Vercel LISTING_SYNC_SECRET:
//   SYNC_SECRET=xxxxxxxx node dev/create-housekeeping-templates.mjs
//   node dev/create-housekeeping-templates.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';

const TEMPLATES = [
  {
    name: 'samba_hk_task',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, ada jadwal untuk hari ini.

Villa: {{1}}
Tugas: {{2}}

Kalau ada kendala atau tidak bisa hari ini, balas saja pesan ini. Terima kasih.`,
    example: ['HAUS Canggu · Unit 2', 'bersih-bersih setelah tamu check out'],
  },
  {
    // Same body as samba_hk_task, plus three one-tap answers. A housekeeper
    // standing in a villa with wet hands will tap a button; she will often
    // not compose a sentence. Whether she answers at all is the difference
    // between a schedule and a guess.
    //
    // Free text still works and still means the same things — the buttons
    // are a shortcut, never the only way through.
    name: 'samba_hk_task_v2',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, ada jadwal untuk hari ini.

Villa: {{1}}
Tugas: {{2}}

Kalau sudah selesai atau ada kendala, tekan tombol di bawah. Terima kasih.`,
    example: ['HAUS Canggu · Unit 2', 'bersih-bersih setelah tamu check out'],
    quickReplies: ['Sudah selesai', 'Besok saja', 'Tidak bisa'],
  },
  {
    name: 'samba_hk_week',
    language: 'id',
    category: 'UTILITY',
    body: `Halo {{1}}, ini jadwal Anda untuk minggu ini.

{{2}}

Kalau ada hari yang tidak bisa, kabari sekarang supaya bisa diatur. Terima kasih.`,
    example: ['Putu', 'Senin, 31 Agustus: HAUS Canggu · Unit 2 — bersih-bersih setelah tamu check out\nRabu, 2 September: HAUS Canggu · Unit 4 — siapkan villa sebelum tamu datang'],
  },
  {
    name: 'samba_hk_inspection',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, hari ini jadwalnya pemeriksaan rutin di {{1}}.

Tolong kirim foto: kamar mandi, langit-langit, dinding dekat AC, dapur, dan kolam kalau ada. Kalau ada jamur, rembes air, atau yang rusak, foto dari dekat ya.

Kirim fotonya langsung ke chat ini. Terima kasih.`,
    example: ['Villa Saturno'],
  },
  {
    // v2 (5 Sep 2026): the functional walk-through from Oli's own studio
    // checklist folded into the fortnightly round. The handover after a
    // clean stays at seven photos; this is the every-two-weeks look at what
    // a photo of a clean room does not show — a lock that sticks, a plug
    // that is dead, a remote with no batteries, a fire extinguisher that
    // has quietly expired. Preferred by the sweep when approved, with the
    // original as the fallback.
    name: 'samba_hk_inspection_v2',
    language: 'id',
    category: 'UTILITY',
    body: `Halo, hari ini jadwalnya pemeriksaan rutin di {{1}}.

Tolong kirim foto: kamar mandi, langit-langit, dinding dekat AC, dapur, dan kolam kalau ada. Kalau ada jamur, rembes air, atau yang rusak, foto dari dekat.

Sambil jalan, coba juga: engsel, kunci dan gagang pintu · semua colokan, saklar dan lampu · AC dan remote TV · gorden dan tirai · keran, shower dan selang · toilet dan semprotan · kompor, kulkas dan dispenser · brankas · alat pemadam api (tanggal) · hanger lengkap · bantal kolam tidak berjamur.

Yang tidak berfungsi, tulis saja di sini. Kalau semua bagus, balas "semua bagus". Terima kasih.`,
    example: ['Villa Saturno'],
  },
  {
    // Onboarding (5 Sep 2026): Maya introduces the readiness system to each
    // housekeeper herself, because the guide Era was asked to hand out
    // competes with everything else on Era's day. A template because the
    // window is shut; the buttons open it, and whatever they say next is
    // answered by staff-help.
    name: 'samba_hk_onboarding',
    language: 'id',
    category: 'UTILITY',
    body: `Halo {{1}}, saya Maya dari Samba 🙏

Mulai minggu ini ada cara kerja baru supaya setiap villa benar-benar siap sebelum tamu masuk. Tiga hal yang berubah:

1. Setelah selesai menyiapkan villa untuk tamu, saya akan minta 7 foto: sofa dengan sarungnya, dapur dan bagian dalam oven, kamar mandi dengan sabun terisi, kamar tidur, dinding, area kolam, dan kotak perlengkapan. Foto itu bukti kerja Anda yang baik, bukan kecurigaan.

2. Kotak perlengkapan (sabun, sampo, tisu, kantong sampah, air) harus penuh saat tamu masuk. Kalau ada yang hampir habis, tulis ke saya. Era yang membeli.

3. Pembersihan menyeluruh 3 bulan sekali, dan setelah tamu menginap lama. Jadwalnya saya kirim seperti biasa.

Yang tidak berubah: pesan pagi, tombol Sudah selesai / Besok saja / Tidak bisa, dan lapor barang rusak dengan foto.

Kalau ada yang belum jelas, tanya saja di sini kapan pun, saya jawab langsung. Tekan salah satu tombol di bawah ya.`,
    example: ['Putu'],
    quickReplies: ['Saya mengerti', 'Ada pertanyaan'],
  },
];

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  for (const t of TEMPLATES) {
    const found = (j.templates || []).find(x => x.name === t.name);
    console.log(`${t.name.padEnd(24)} ${found ? found.status + (found.category ? ' · ' + found.category : '') : 'not found yet'}`);
  }
  console.log('\nThe housekeeping sweep skips any queue whose template is not APPROVED,');
  console.log('so nothing else breaks while these are pending.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-housekeeping-templates.mjs');
    process.exit(1);
  }
  // ONLY=<name> submits one template, so adding a version does not resubmit
  // the ones Meta already approved.
  const only = process.env.ONLY;
  for (const t of TEMPLATES.filter(t => !only || t.name === only)) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({ action: 'create', ...t }),
    });
    const j = await r.json();
    console.log(`${t.name.padEnd(24)} ${r.ok ? 'submitted' : 'FAILED'} ${JSON.stringify(j).slice(0, 200)}`);
  }
  console.log('\nCheck with:\n  node dev/create-housekeeping-templates.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
