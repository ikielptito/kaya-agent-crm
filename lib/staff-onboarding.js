// Maya onboards the housekeepers to the readiness system herself.
//
// Ikiel asked Era to hand out the guide, and Era is the busiest person in
// the company. So Maya introduces the change in each housekeeper's own
// chat, in Indonesian, and stays available for questions — which is the
// part a PDF cannot do.
//
// The shape is dictated by WhatsApp: a first message outside the 24-hour
// window must be a template, so samba_hk_onboarding carries the essentials
// and two buttons. Either button opens the window. "Saya mengerti" gets the
// fuller walk-through and the PDF guide; "Ada pertanyaan" gets an
// invitation to type it. For two days after the send, anything she writes
// that no other handler claims is treated as a question even without a
// question mark, because "foto oven juga" after an onboarding message is a
// question, and silence there is the failure this whole thing exists to
// remove.

import { listStaff, staffByWa } from './staff.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';
import { answerStaffQuestion } from './staff-help.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const TEMPLATE = 'samba_hk_onboarding';
const STATE_KEY = 'housekeeping_onboarding';
const GUIDE_URL = process.env.HK_GUIDE_URL || 'https://sambarentals.com/guides/Panduan-Housekeeper-Samba.pdf';
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');

async function post(wa, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return null; }
}
const sendText = (wa, to, text) => post(wa, { to, type: 'text', text: { body: text } });
const sendDoc = (wa, to, link, filename, caption) => post(wa, { to, type: 'document', document: { link, filename, caption } });

async function logOut(db, { waNum, content, mid, template = null, category = 'staff_onboard' }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: waNum, direction: 'outbound', content, timestamp: nowIso(),
      wa_message_id: typeof mid === 'string' ? mid : null, source: 'cron', category,
      template_name: template, status: 'sent',
    }),
  }).catch(() => {});
}

async function state(db) { return (await getSettingValue(db, STATE_KEY).catch(() => null)) || {}; }
async function patchState(db, wa, fields) {
  const s = await state(db);
  s[wa] = { ...(s[wa] || {}), ...fields };
  await saveSettingValue(db, STATE_KEY, s);
  return s[wa];
}

// ── The send ────────────────────────────────────────────────────────
// One template per active housekeeper with a number. Idempotent: a person
// already sent is skipped unless `again` is set, so re-running after a
// partial failure only reaches the ones missed.
export async function sendOnboarding({ db, wa, templatesMap = {}, only = null, again = false, dryRun = false }) {
  if (!dryRun && !templatesMap[TEMPLATE]) return { skipped: `${TEMPLATE} not approved yet` };
  const people = (await listStaff(db, { active_only: true, role: 'housekeeper' })) || [];
  const done = await state(db);
  const out = { sent: [], skipped: [], failed: [] };
  for (const p of people) {
    const to = digits(p.wa_num);
    if (!to) { out.skipped.push({ name: p.name, why: 'no number' }); continue; }
    if (only && !only.includes(p.name) && !only.includes(to)) { out.skipped.push({ name: p.name, why: 'not in list' }); continue; }
    if (done[to]?.sent_at && !again) { out.skipped.push({ name: p.name, why: `already sent ${done[to].sent_at.slice(0, 10)}` }); continue; }
    const first = String(p.name || '').split(' ')[0];
    if (dryRun) { out.sent.push({ name: p.name, to, first, dry: true }); continue; }
    const mid = await post(wa, {
      to, type: 'template',
      template: { name: TEMPLATE, language: { code: 'id' }, components: [{ type: 'body', parameters: [{ type: 'text', text: first }] }] },
    });
    if (!mid) { out.failed.push({ name: p.name, to }); continue; }
    await logOut(db, { waNum: to, mid, template: TEMPLATE, content: `[Onboarding — ${p.name}: the readiness system]` });
    await patchState(db, to, { name: p.name, sent_at: nowIso() });
    out.sent.push({ name: p.name, to, first });
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ── The fuller explanation, once the window is open ─────────────────
const DETAIL = (first) => `Terima kasih, ${first} 🙏 Ini ringkasannya, supaya jelas:

*Kapan foto diminta*
Hanya kalau tugasnya menyiapkan villa untuk tamu: turnover yang ada tamu berikutnya, persiapan sebelum tamu datang, dan pembersihan menyeluruh. Bersih-bersih rutin biasa tidak perlu foto.

*7 foto*
1. Ruang tamu, sofa dengan sarungnya
2. Dapur: meja, kompor, dan bagian dalam oven (buka pintunya)
3. Kamar mandi, sabun tangan dan sabun mandi terisi
4. Kamar tidur, tempat tidur rapi
5. Dinding yang tadinya paling kotor
6. Area kolam dan kursinya
7. Kotak perlengkapan, dibuka

Kirim satu per satu, tulis yang hampir habis, lalu balas "selesai". Tunggu jawaban saya sebelum pulang: kalau ada yang perlu diperbaiki, saya sebutkan, dan itu 5 menit selagi masih di villa.

*Kenapa*
Tamu melihat 10 menit pertama: sofa tanpa sarung, sabun kosong, oven kotor di dalam, dinding bernoda. Itu yang masuk ulasan, bukan lantai yang sudah bersih. Foto Anda membuktikan ke Era dan ke pemilik villa bahwa villanya dirawat, dan melindungi Anda kalau tamu mengeluh soal sesuatu yang sebenarnya sudah beres.

*Sarung sofa*
Setiap villa punya sarung cadangan. Kalau yang satu dicuci, pasang cadangannya. Sofa tidak boleh telanjang saat tamu masuk.

Panduan lengkapnya saya kirim di bawah. Kalau ada pertanyaan, kapan pun, tulis saja di sini.`;

// ── Her reply to the onboarding ─────────────────────────────────────
// Buttons first, before the cleaning-reply handler sees the text: "Saya
// mengerti" is not a task reply, and parseCleaningReply would otherwise be
// asked to make sense of it.
export async function handleOnboardingButton({ db, wa, fromNum, text, buttonPayload }) {
  const tap = String(buttonPayload || text || '').trim().toLowerCase();
  if (tap !== 'saya mengerti' && tap !== 'ada pertanyaan') return false;
  const to = digits(fromNum);
  const rec = (await state(db))[to];
  if (!rec?.sent_at) return false;
  const first = String(rec.name || '').split(' ')[0] || 'Kak';
  if (tap === 'saya mengerti') {
    const mid = await sendText(wa, to, DETAIL(first));
    await logOut(db, { waNum: to, mid, content: DETAIL(first).slice(0, 300) + '…' });
    const dm = await sendDoc(wa, to, GUIDE_URL, 'Panduan-Housekeeper-Samba.pdf', 'Panduan Housekeeper Samba (PDF). Simpan di HP ya.');
    if (dm) await logOut(db, { waNum: to, mid: dm, content: '[Document — Panduan Housekeeper Samba]' });
    await patchState(db, to, { understood_at: nowIso() });
  } else {
    const msg = `Silakan ${first}, tulis pertanyaannya di sini. Apa saja: soal foto, jadwal, kotak perlengkapan, atau kenapa sesuatu harus dilakukan. Saya jawab langsung.`;
    const mid = await sendText(wa, to, msg);
    await logOut(db, { waNum: to, mid, content: msg });
    await patchState(db, to, { asked_at: nowIso() });
  }
  return true;
}

// Last in the staff branch: for two days after the onboarding, whatever no
// other handler claimed is a question, question mark or not.
export async function handleOnboardingFollowup({ db, wa, fromNum, text }) {
  const body = String(text || '').trim();
  if (!body) return false;
  const to = digits(fromNum);
  const rec = (await state(db))[to];
  if (!rec?.sent_at || Date.now() - Date.parse(rec.sent_at) > 48 * 3600e3) return false;
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;
  const ok = await answerStaffQuestion({ db, wa, fromNum, text: body, role: 'housekeeper', person, force: true });
  if (ok) await patchState(db, to, { last_question_at: nowIso() });
  return !!ok;
}

export async function onboardingStatus(db) {
  const s = await state(db);
  const people = (await listStaff(db, { active_only: true, role: 'housekeeper' })) || [];
  return people.map(p => ({ name: p.name, wa: digits(p.wa_num), ...(s[digits(p.wa_num)] || {}) }));
}
