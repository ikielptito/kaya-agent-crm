// Maya corrects the way people use her, gently and once.
//
// Ikiel's rule (8 Sep 2026): when a housekeeper uses the system in a way
// that will not record what she did, Maya should say so in the moment and
// remind her of the way that works — not leave it for Era, not leave it
// for the guide. Each tip is one or two Indonesian sentences, phrased as
// help rather than blame, and any one tip reaches a person at most once
// a week, so a pattern is corrected without a stream of reminders.
//
//   coach(db, wa, { person, key, extra })   sends TIPS[key] if it is due
//   coachDue(db, person, key)               would it be sent?
//
// State: settings.staff_coaching { <num>: { <key>: iso } }. Every tip sent
// is logged on her thread as category 'staff_coach', so the console and
// the weekly review can see what she was told and when.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { sendText } from './wa-interactive.js';

const KEY = 'staff_coaching';
const WEEK = 7 * 86400e3;
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');

export const TIPS = {
  // "siap" / "ok" sent in reply to a visit's message, no button tapped.
  ack_not_button: 'Sedikit tips: "siap" atau "ok" tidak mencatat tugasnya. Kalau sudah selesai, tekan tombol *Sudah selesai* di pesan villanya (atau tulis "sudah selesai") — itu yang masuk catatan pemilik villa 🙏',
  // "Sudah selesai" tapped minutes after the morning message.
  early_done: 'Tips: tombol *Sudah selesai* ditekan setelah benar-benar selesai di villa, bukan saat pesan diterima. Kalau tadi hanya konfirmasi, tidak apa-apa — kirim fotonya nanti setelah selesai ya 🙏',
  // Visit marked done, no photos by the afternoon.
  proof_missing: 'Tadi tercatat selesai, tapi belum ada fotonya. Kirim 2 foto (dapur dan kamar mandi) supaya catatannya lengkap untuk pemilik villa 🙏',
  // Photos with no caption, nothing open to put them on.
  photo_no_context: 'Tips: kalau kirim foto di luar jadwal, tulis villanya di caption ("B3") supaya masuk ke catatan yang benar. Kalau ada yang rusak, tulis juga apa yang rusak 🙏',
  // Fault photo sent without the villa or the fault in the caption.
  fault_no_caption: 'Tips: foto kerusakan paling cepat masuk kalau keterangannya di caption foto itu sendiri, contoh "B3 – kran wastafel bocor". Satu foto, satu keterangan 🙏',
  // Inspection photos sent, round never closed.
  round_not_closed: 'Tips: setelah foto terakhir pemeriksaan, balas "selesai" atau "semua bagus" supaya pemeriksaannya tertutup dan laporannya jalan ke pemilik villa 🙏',
  // Several villas in one message where a tap was ambiguous.
  which_villa: 'Tips: sebut villanya (A4, B3, HAUS 2) di setiap pesan, supaya saya tidak perlu bertanya lagi 🙏',
  // A schedule change given without a villa.
  schedule_no_villa: 'Tips: kalau ganti hari, sebut villanya sekalian, contoh "B3 dan B5 hari Senin dan Kamis" 🙏',
};

async function state(db) { return (await getSettingValue(db, KEY).catch(() => null)) || {}; }

export async function coachDue(db, person, key) {
  const st = await state(db);
  const last = st[digits(person?.wa_num)]?.[key];
  return !last || Date.now() - Date.parse(last) > WEEK;
}

// Every sighting of a pattern is remembered (<key>_seen, last 20 dates),
// tip or no tip, so the weekly review can tell whether a tip worked.
async function noteSeen(db, to, key) {
  try {
    const st = await state(db);
    const seen = [...((st[to] || {})[`${key}_seen`] || []), nowIso()].slice(-20);
    st[to] = { ...(st[to] || {}), [`${key}_seen`]: seen };
    await saveSettingValue(db, KEY, st);
  } catch { /* best effort */ }
}

// A tip the review reworded and Ikiel approved replaces the stock text.
let _over = { at: 0, map: {} };
async function tipText(db, key) {
  if (Date.now() - _over.at > 10 * 60e3) {
    _over.at = Date.now();
    try { _over.map = (await getSettingValue(db, 'staff_coaching_overrides')) || {}; } catch { /* keep */ }
  }
  return _over.map[key] || TIPS[key];
}

// Returns true when a tip went out.
export async function coach(db, wa, { person, key, extra = null, fromNum = null } = {}) {
  const to = digits(fromNum || person?.wa_num);
  if (!TIPS[key] || !to) return false;
  await noteSeen(db, to, key);
  const text = await tipText(db, key);
  if (!wa) return false;
  if (!(await coachDue(db, person || { wa_num: to }, key))) return false;
  const body = extra ? `${text}\n${extra}` : text;
  const mid = await sendText(wa, to, body).catch(() => null);
  if (!mid) return false;
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: to, direction: 'outbound', content: body, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'webhook', category: 'staff_coach', status: 'sent' }),
  }).catch(() => {});
  const st = await state(db);
  st[to] = { ...(st[to] || {}), [key]: nowIso() };
  await saveSettingValue(db, KEY, st).catch(() => {});
  return true;
}

// What each person has been told, for the console and the weekly review.
export async function coachingLog(db) { return state(db); }
