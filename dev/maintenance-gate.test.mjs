// The gate that decides whether a staff message is even LOOKED at.
//
// Everything downstream — the model call, the property match, the ticket —
// happens only if this returns true. It was written when Era, who writes
// English, was the only person who could file a report; once five
// Indonesian-speaking housekeepers and a tukang were let in, it dropped
// almost everything they sent. A leaking tap reported as "kran bocor" simply
// never existed.
//
// The asymmetry that decides the tuning: a false positive is a spurious
// ticket Era deletes in two seconds. A false negative is a leak nobody hears
// about until it is a ceiling.
import { looksLikeMaintenance } from '../lib/maintenance-intake.js';

let pass = 0, fail = 0;
const t = (label, text, hasImage, expect) => {
  const got = looksLikeMaintenance(text, hasImage);
  if (got === expect) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} — got ${got}, want ${expect}: "${text}"`); }
};

// ── Indonesian, no photo. The case that was broken. ──────────────────
for (const s of [
  'kran kamar mandi bocor',
  'AC tidak dingin',
  'airnya tidak panas',
  'ada jamur di langit-langit',
  'lampu teras mati',
  'pintu lemari rusak',
  'kursi patah',
  'wastafel mampet',
  'atap bocor waktu hujan',
  'listrik mati di kamar',
  'kunci pintu macet',
  'mesin cuci rusak',
  'kompor tidak menyala',
  'kolam kotor',
  'plafon rembes',
  'gorden sobek',
  'kulkas tidak dingin',
  'shower airnya tidak keluar',
]) t(`ID  ${s}`, s, false, true);

// ── English still works ──────────────────────────────────────────────
for (const s of [
  'the tap in the bathroom is leaking',
  'aircon not working in unit 2',
  'wall needs a paint touch up',
  'wardrobe door is broken',
]) t(`EN  ${s}`, s, false, true);

// ── Ordinary chatter must NOT become a work order ────────────────────
for (const s of [
  'selamat pagi bu',
  'saya sudah sampai',
  'ok siap',
  'terima kasih',
  'sudah selesai semua',
  'baik bu, besok saya ke sana',
  'good morning, I am on my way',
]) t(`chat  ${s}`, s, false, false);

// ── A photo relaxes the gate: the picture carries the detail ─────────
t('photo with a vague caption', 'ini di kamar mandi ya bu', true, true);
t('photo with no caption at all', '', true, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
