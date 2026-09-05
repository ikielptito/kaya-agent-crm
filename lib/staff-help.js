// Maya explains the housekeeping system to the people who run it.
//
// Until 5 Sep 2026 a housekeeper who asked "kenapa harus foto oven?" got
// silence: the staff branch claims replies to tasks, photos and fault
// reports, and logs everything else for a human. Era's questions ended the
// same way. Both are the moment the system is either understood or quietly
// ignored, so this answers them.
//
// Two things it has to do well:
//
//   HOW it works — the morning message, the buttons, the seven photos, the
//   consumables box, the deep clean, the inspection round, what Era sees.
//
//   WHY it matters — the housekeepers do not share the guests' standards,
//   and "because the checklist says so" changes nothing. Every explanation
//   ties the task to what the guest sees on day one and what it costs when
//   they don't: a bare sofa, an empty soap holder and a rusty oven produced
//   an eight-night guest's complaint and a bad review at Tropicana A5.
//
// Grounded in the SOP below and in the person's own open tasks, so the
// answer is about THEIR villa and THEIR day. Claims only messages that read
// as questions, so a fault report or a task reply is never swallowed.

import { staffByWa } from './staff.js';
import { getSettingValue } from './campaigns.js';
import { catalogNames } from './housekeeping.js';
import { KIND_ID, KIND_EN } from './housekeeping-sweep.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const MODEL = process.env.STAFF_HELP_MODEL || 'claude-sonnet-4-6';
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return null; }
}

// ── Is this a question? ─────────────────────────────────────────────
// Deliberately generous on question words and strict on everything else.
// "sudah", "besok saja", "lampu teras mati" and a photo caption are not
// questions and belong to the handlers that ran before this one; what
// reaches here is whatever they declined, so the cost of a false positive
// is one unwanted explanation, and the cost of a false negative is silence.
const Q_WORDS = /\b(kenapa|mengapa|bagaimana|gimana|gmn|apa(kah)?|apa itu|maksud(nya)?|artinya|kapan|di ?mana|siapa|berapa|haruskah|harus(kah)? ?(saya|aku)?|boleh(kah)?|bisa(kah)? ?(saya|aku)?|perlu(kah)?|tolong jelaskan|jelaskan|caranya|bagaimana cara|why|how|what|when|where|which|should i|do i|can i|could you explain|explain|what does|what is|remind me)\b/i;
// Any run of acknowledgement words, in any spelling: "Ok terimakasih",
// "baik siap 🙏", "oke makasih ya". Not a question, so not answered.
const ACK = /^\s*(?:(?:ok|oke|okay|okey|baik|siap|ya|yes|iya|yaa|terima\s?kasih|makasih|mksh|thanks|thank you|thx|sip|noted|mengerti|paham|sudah paham|kak|kaka|kakak|mbak|bu|pak|maya|ya kak|👍|🙏|😊|🙂)[\s.,!🙏👍😊🙂]*)+$/i;

export function looksLikeStaffQuestion(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 3 || t.length > 600) return false;
  if (ACK.test(t)) return false;
  if (/\?/.test(t)) return true;
  return Q_WORDS.test(t);
}

// ── The SOP, as Maya knows it ───────────────────────────────────────
// Kept in code rather than in a settings row so that a deploy that changes
// a rule changes the explanation with it. Indonesian first, because that is
// the language it is mostly asked in; Maya answers in whichever language the
// question came in.
export const SOP = `
SISTEM HOUSEKEEPING SAMBA (September 2026)

JADWAL
- Setiap pagi jam 09.00 WITA Maya mengirim tugas hari itu ke setiap housekeeper. Hari Senin: jadwal seminggu.
- Jenis tugas: bersih-bersih rutin (2x seminggu, hari tetap per villa, jalan terus walau villa kosong); turnover (tamu baru pergi, di hari check-out); persiapan sebelum tamu datang (sehari sebelum check-in, kalau villa kosong 5 hari atau lebih); pemeriksaan rutin dengan foto (tiap 2 minggu); deep clean / pembersihan menyeluruh (tiap 3 bulan per villa, DAN sehari setelah tamu yang menginap 21 malam atau lebih pergi).
- Jadwal dibuat otomatis dari kalender booking (Hostex). Era tidak mengetik jadwal; Era mengawasi di halaman Schedule dan mengubah kalau ada yang salah (ganti orang, pindah hari, tambah clean, lewati).
- Tiga tombol di pesan pagi: "Sudah selesai" (tekan saat masih di villa, setelah benar-benar selesai), "Besok saja" (pindah ke besok, Era diberi tahu; jangan dipakai kalau tamu datang hari ini), "Tidak bisa" (Era cari pengganti; tekan sepagi mungkin). Boleh juga menulis biasa.

FOTO SERAH TERIMA (readiness)
- Untuk turnover yang ada tamu berikutnya, persiapan sebelum tamu datang, dan deep clean: setelah tekan "Sudah selesai", Maya minta 7 foto: (1) ruang tamu dengan sarung sofa terpasang, (2) dapur: meja, kompor, dan bagian dalam oven KALAU ADA (belum semua villa punya oven atau microwave), (3) kamar mandi dengan sabun tangan dan sabun mandi terisi, (4) kamar tidur, tempat tidur rapi, (5) dinding yang tadinya paling kotor, (6) area kolam dan kursinya, (7) kotak perlengkapan dibuka.
- Tulis juga apa yang hampir habis. Lalu balas "selesai". Tunggu jawaban Maya sebelum pulang.
- Maya melihat semua foto. Kalau ada yang belum siap, Maya menyebutkan apa yang harus diperbaiki sekarang; perbaiki lalu foto lagi bagian itu. Kalau Maya keliru, tulis alasannya; Era yang memutuskan.
- Era hanya diberi tahu kalau ada masalah, foto kurang dari 4, atau ada yang hampir habis. Kalau semua beres, Era tidak diganggu.
- Bilang "selesai" tanpa mengirim foto: setelah 20 jam (atau sore sebelum tamu datang) Maya memberi tahu Era dan mencatatnya "tidak diperiksa". Itu dihitung.
- Bersih-bersih rutin dan turnover tanpa tamu berikutnya TIDAK minta foto.

ARTI "SIAP"
- Ruang tamu: sarung sofa terpasang dan bersih (ada sarung cadangan di tiap villa; sofa tidak boleh telanjang), lantai dipel termasuk bawah meja, dinding dan lis dilap.
- Dapur: meja dan kompor tanpa noda minyak, bagian dalam oven bersih, sabun cuci piring + spons + tisu dapur ada, kulkas kosong dan bersih, tempat sampah kosong dengan kantong baru, galon dispenser terisi + 2 botol air segel.
- Kamar mandi: sabun tangan dan sabun mandi TERISI (bukan hampir habis), sampo, tisu toilet minimal 2 gulung, cermin dan keran tanpa bercak, handuk bersih di rak.
- Kamar tidur: sprei dan sarung bantal bersih, tempat tidur rapi, lemari kosong dengan hanger, AC tidak bau, setrika dan papan ada.
- Luar: bantal dan kursi kolam bersih tanpa jamur, jemuran ada, kaca luar bersih termasuk lantai atas (kotoran burung), teras disapu.

KOTAK PERLENGKAPAN (saat penuh)
- Sabun tangan 2, sabun mandi 1, sampo 1, sabun cuci piring + spons 1, tisu dapur 2, tisu toilet 4, kantong sampah 10, galon + 2 botol air segel.
- Housekeeper menghitung di tiap turnover dan memberi tahu Maya yang hampir habis. Era yang membeli / mengisi; housekeeper tidak perlu membeli sendiri.
- Dispenser dibersihkan bagian dalamnya sebulan sekali (saat deep clean), tempel stiker tanggal.

DEEP CLEAN
- Lap semua dinding dan lis, bagian dalam oven, kaca luar termasuk lantai atas, nat kamar mandi disikat, bantal dan kursi kolam dicuci dan dijemur, dispenser dibersihkan, di bawah dan di belakang perabot. Butuh setengah hari; biasanya di hari villa kosong.
- Noda yang tidak hilang: foto dari dekat ke Maya dengan keterangan "perlu dicat" → jadi permintaan perbaikan ke pemilik.

PEMERIKSAAN 2 MINGGU SEKALI
- Foto: kamar mandi, langit-langit, dinding dekat AC, dapur, kolam. Jamur / rembes / rusak: foto dari dekat.
- Sambil jalan, COBA: engsel, kunci dan gagang pintu; semua colokan, saklar, lampu (termasuk teras); AC dan remote TV; gorden; keran, shower, selang, semprotan toilet; kompor, kulkas, dispenser; brankas; tanggal alat pemadam api; hanger lengkap; bantal kolam tidak berjamur.
- Yang tidak berfungsi: tulis saja → masuk daftar perbaikan, Era mengatur tukang. Semua baik: balas "semua bagus". Hasilnya masuk laporan mingguan ke pemilik villa.

KALAU VILLA TIDAK PUNYA SESUATU
- Tidak semua villa sama. Tidak ada oven → foto dapurnya tetap: meja dan kompor (setiap villa punya kompor), dan microwave kalau ada; tulis "tidak ada oven". Tidak ada kolam → foto teras/halaman. Satu kamar mandi → satu foto. Dua lantai → foto keduanya. Aturannya: foto bagian yang ADA, dan tulis keterangan singkat supaya Maya tahu. Ini tidak perlu ditanyakan ke Era.
- Yang penting bukan jumlah fotonya, tapi bahwa setiap ruangan yang dipakai tamu terlihat siap.

BARANG RUSAK
- Kapan saja: foto + nama villa + apa yang rusak, kirim ke Maya. Masuk daftar perbaikan (Maintenance); Era isi perkiraan biaya; pemilik menyetujui; tukang dikirim; Era menandai selesai.

KIT MINIMUM SETIAP VILLA (standar Samba)
- Ketel, microwave, cermin panjang, setrika + papan, rak handuk, jemuran dekat kolam, hairdryer, sarung sofa cadangan, dispenser panas-dingin dengan stiker tanggal, bantal kolam bersih. Era mengaudit sekali per villa di halaman Schedule → nama villa → "Villa standard"; yang Missing otomatis jadi permintaan ke pemilik.

UNTUK ERA (halaman Schedule di sambarentals.com/payouts)
- Huruf: R rutin, T turnover, P persiapan, I pemeriksaan, D deep clean. Label serah terima: Photos pending / Checked / Needs a look / Not checked. Tekan clean → lihat foto, ganti orang, pindah hari, Done, Skip.
- Tombol: Add a clean, Cleaning days, Rebuild from the calendar (aman; yang sudah dikirim tidak dihapus), Rounds ahead (6 bulan pemeriksaan + deep clean), Calendar feed (link untuk Google Calendar).
- Tekan nama housekeeper → 30 hari terakhirnya: kunjungan, selesai di harinya, dilewati, serah terima lolos / ditandai / tidak dijawab. Dibaca bersama sebulan sekali.
- "Needs a look": lihat foto, telepon housekeeper kalau masih di villa, kalau tamu datang hari ini pastikan ada yang memperbaiki sebelum check-in. "Not checked" lebih serius: anggap villa belum siap sampai ada yang melihat.
- Sisi tamu: pesan otomatis jam 18.00 di hari check-in ("semua beres?"); WhatsApp tamu sebelum kedatangan dibalas hari itu juga; balasan keluhan selalu: akui, perbaiki, sebut jam, jangan pernah menjelaskan kenapa tamu salah.

KENAPA INI PENTING (untuk menjelaskan ke housekeeper)
- Tamu membayar seperti hotel dan membandingkan dengan hotel dan dengan unit tetangga. Yang mereka lihat di 10 menit pertama menentukan ulasan: sofa tanpa sarung, sabun kosong, oven berkarat, dinding bernoda, kaca penuh kotoran burung. Satu ulasan buruk menurunkan booking berbulan-bulan.
- 4 September 2026, Tropicana A5: villa kosong 5 hari, sarung sofa dicuci dan tidak ada yang tahu, sabun kosong, oven kotor, dinding kotor → tamu 8 malam menulis keluhan panjang di hari pertama. Itu sebabnya ada foto serah terima.
- Bagian dalam oven: tamu membuka oven sebelum memasak; karat dan lemak lama terlihat langsung dan dianggap "villa tidak dirawat".
- Sabun terisi: tamu datang dari perjalanan panjang, hal pertama adalah mandi. Botol kosong = "tidak ada yang menyiapkan untuk saya".
- Dinding dan lis: mata tamu menangkap noda di dinding lebih dulu daripada lantai bersih. Lantai bersih tidak menutupi dinding kotor.
- Kaca lantai atas dan bantal kolam: kolam adalah alasan mereka memilih villa; kotoran burung dan bantal berjamur terlihat di foto yang mereka kirim ke teman.
- Foto: bukan untuk mencurigai. Foto membuktikan pekerjaan yang baik ke Era dan ke pemilik villa (masuk laporan mingguan), dan melindungi housekeeper kalau tamu mengeluh soal sesuatu yang sebenarnya sudah beres.
- Menunggu jawaban Maya sebelum pulang: memperbaiki 1 hal saat masih di villa = 5 menit; setelah tamu masuk = tamu kecewa + perjalanan ulang.
- Kotak perlengkapan: yang habis di tengah menginap tamu = tamu harus membeli sendiri dan menulisnya di ulasan.
`;

// ── Context about this person's day ─────────────────────────────────
async function personContext(db, person, role) {
  const today = witaToday();
  const names = await catalogNames(db).catch(() => ({}));
  const name = (s) => names[s] || s;
  const lines = [];
  if (role === 'housekeeper' && person?.id) {
    const tasks = (await sbGet(db,
      `housekeeping_tasks?assigned_staff_id=eq.${person.id}&task_date=gte.${plusDays(today, -1)}&task_date=lte.${plusDays(today, 7)}`
      + `&status=neq.skipped&select=slug,task_date,kind,status,guest_in_date,same_day&order=task_date.asc&limit=20`)) || [];
    if (tasks.length) {
      lines.push('Tugas orang ini (kemarin sampai 7 hari ke depan):');
      for (const t of tasks) lines.push(`- ${t.task_date}${t.task_date === today ? ' (hari ini)' : ''}: ${name(t.slug)} — ${KIND_ID[t.kind] || t.kind}${t.guest_in_date ? `, tamu datang ${t.guest_in_date}` : ''}${t.same_day ? ', tamu datang hari yang sama' : ''} [${t.status}]`);
    } else lines.push('Tidak ada tugas terjadwal untuk orang ini dalam 7 hari ke depan.');
    const open = (await sbGet(db,
      `housekeeping_readiness?by_staff_id=eq.${person.id}&status=eq.awaiting&select=slug,photos,asked_at&order=asked_at.desc&limit=1`))?.[0];
    if (open) lines.push(`Ada foto serah terima yang masih ditunggu dari orang ini untuk ${name(open.slug)}: ${(open.photos || []).length} foto sudah masuk, belum balas "selesai".`);
    lines.push(`Villa yang dia pegang: ${(person.slugs || []).map(name).join(', ') || 'belum diatur'}.`);
  }
  if (role === 'era') {
    const flagged = (await sbGet(db,
      `housekeeping_readiness?status=in.(flagged,unchecked)&asked_at=gte.${plusDays(today, -3)}T00:00:00Z&select=slug,status,flags,guest_in_date&order=asked_at.desc&limit=10`)) || [];
    if (flagged.length) {
      lines.push('Serah terima 3 hari terakhir yang ditandai:');
      for (const r of flagged) lines.push(`- ${name(r.slug)}: ${r.status}${(r.flags || []).length ? ' — ' + r.flags.join('; ') : ''}${r.guest_in_date ? ` (tamu ${r.guest_in_date})` : ''}`);
    }
    const todays = (await sbGet(db,
      `housekeeping_tasks?task_date=eq.${today}&status=neq.skipped&select=slug,kind,status,staff:assigned_staff_id(name)&limit=40`)) || [];
    if (todays.length) lines.push(`Hari ini (${today}): ` + todays.map(t => `${name(t.slug)} ${KIND_EN[t.kind] || t.kind} (${t.staff?.name || 'nobody'}, ${t.status})`).join('; '));
  }
  return lines.join('\n');
}

// Recent exchange with Maya, so "and the pool one?" has something to refer
// to. Both directions, newest last.
async function recentThread(db, waNum) {
  const rows = (await sbGet(db,
    `wa_messages?wa_num=eq.${encodeURIComponent(waNum)}&select=direction,content,timestamp&order=timestamp.desc&limit=8`)) || [];
  return rows.reverse()
    .filter(m => m.content && !/^\[/.test(m.content))
    .map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: String(m.content).slice(0, 600) }));
}

// ── The answer ──────────────────────────────────────────────────────
export async function answerStaffQuestion({ db, wa, fromNum, text, role, person = null, apiKey = process.env.ANTHROPIC_API_KEY, dryRun = false, force = false }) {
  if (!force && !looksLikeStaffQuestion(text)) return false;
  if (!apiKey) return false;

  const who = role === 'era' ? 'Era, villa manager Samba (mengawasi semua housekeeper dan halaman Schedule)'
    : `${person?.name || 'seorang housekeeper'}, housekeeper Samba`;
  const ctx = await personContext(db, person, role).catch(() => '');
  const std = (await getSettingValue(db, 'housekeeping').catch(() => null)) || {};

  const system = `Kamu Maya, asisten operasional Samba Realty (Bali) di WhatsApp. Kamu menjawab pertanyaan dari ${who} tentang cara kerja sistem housekeeping dan kenapa setiap tugas penting.

CARA MENJAWAB
- Bahasa: jawab dalam bahasa pesan yang masuk (Indonesia sehari-hari yang sopan dan sederhana untuk housekeeper; Era boleh Inggris atau Indonesia).
- Pendek: ini WhatsApp. Maksimal 6 baris atau 5 poin. Satu pertanyaan, satu jawaban. Tidak ada pembukaan panjang.
- Format WhatsApp, bukan markdown: tidak ada ** atau #. Tebal hanya dengan *satu bintang* dan jarang. Daftar dengan "•" atau angka.
- Selalu praktis: apa yang harus dilakukan, lalu KENAPA, dalam kalimat tentang tamu (apa yang tamu lihat, apa akibatnya). Untuk housekeeper, "kenapa" itu wajib disebut walau tidak ditanya, singkat.
- Hormati orangnya: tidak menggurui, tidak menyalahkan. Foto adalah bukti kerja yang baik, bukan kecurigaan.
- Pertanyaan tentang menyesuaikan aturan ke villanya (tidak ada oven, tidak ada kolam, satu kamar mandi, dua lantai): jawab langsung dengan akal sehat sesuai bagian "KALAU VILLA TIDAK PUNYA SESUATU". Jangan menyuruh tanya Era untuk hal seperti ini.
- Jangan mengarang aturan baru (jadwal, gaji, siapa yang membeli apa). Hanya untuk hal yang benar-benar di luar SOP, bilang kamu tidak yakin dan sarankan tanya Era (untuk housekeeper) atau Ikiel (untuk Era).
- Jangan mengubah jadwal atau menjanjikan perubahan; kalau dia minta pindah hari / tidak bisa, bilang balas pesan tugasnya dengan "besok saja" / "tidak bisa" atau hubungi Era.
- Nomor Era: +62 812 4635 7778.

${SOP}

PENGATURAN SAAT INI: deep clean tiap ${std.deep_clean_every_days || 90} hari dan setelah menginap ${std.deep_clean_after_nights || 21} malam; pemeriksaan tiap ${std.inspection_every_days || 14} hari; minimal foto serah terima ${std.readiness_min_photos || 4}; batas waktu foto ${std.readiness_timeout_hours || 20} jam.

KONTEKS ORANG INI
${ctx || '(tidak ada)'}`;

  const history = await recentThread(db, fromNum).catch(() => []);
  const messages = [...history.filter(m => m.content !== text), { role: 'user', content: String(text).slice(0, 1000) }];
  // Anthropic needs alternation starting with user.
  const msgs = [];
  for (const m of messages) {
    if (!msgs.length && m.role !== 'user') continue;
    if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n\n' + m.content;
    else msgs.push({ ...m });
  }

  let answer = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: msgs }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    answer = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch { return false; }
  if (!answer) return false;
  answer = answer.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#+\s*/gm, '').slice(0, 1500);

  if (dryRun) return { answer, system_chars: system.length, history: msgs.length - 1 };
  await sendText(wa, fromNum, answer);
  // The reply is logged like every other outbound so the next question can
  // refer back to it.
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: fromNum, direction: 'outbound', content: answer, timestamp: new Date().toISOString(),
      source: 'webhook', category: 'staff_help',
    }),
  }).catch(() => {});
  return true;
}

// Entry point for the webhook's staff branch: resolves the person first.
export async function handleStaffQuestion({ db, wa, fromNum, text }) {
  if (!looksLikeStaffQuestion(text)) return false;
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;
  const role = (person.roles || []).includes('housekeeper') ? 'housekeeper' : 'staff';
  return answerStaffQuestion({ db, wa, fromNum, text, role, person });
}
