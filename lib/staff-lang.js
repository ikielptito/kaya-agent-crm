// The words staff use, decided once.
//
// Until 8 Sep 2026 four modules each kept their own idea of what "siap"
// meant: an acknowledgement in staff-help.js and housekeeping-schedule.js,
// a completed clean in housekeeping-intake.js, a closed photo check in
// housekeeping-readiness.js. A polite "siap" to the 09:00 message marked
// the villa cleaned. So: one place, pure functions, and the rule that an
// acknowledgement is checked BEFORE anything that would change a record.
//
// Indonesian first, English tolerated. Everything is a whole-message test:
// "sudah selesai" closes, "sudah selesai kak, tapi kran bocor" does not —
// that sentence carries a report and goes to the classifier.

// Words the weekly review proposed and Ikiel approved (settings
// staff_lang_extra: { ack: [...], done: [...], all_fine, avail, restock,
// schedule }). Merged into the rules below without a deploy; the base
// lists stay in code. loadStaffLangExtras(db) refreshes every ten minutes.
const esc = (w) => String(w || '').trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const alt = (words) => (words || []).map(esc).filter(Boolean);
let EXTRA = { ack: [], done: [], all_fine: [], avail: [], restock: [], schedule: [] };
let _live = null; // rebuilt regexes
let _loadedAt = 0;
function build() {
  const a = alt(EXTRA.ack), d = alt(EXTRA.done), f = alt(EXTRA.all_fine), v = alt(EXTRA.avail), r = alt(EXTRA.restock), s = alt(EXTRA.schedule);
  const ackWord = a.length ? `(?:${ACK_WORD}|${a.join('|')})` : ACK_WORD;
  _live = {
    ack: new RegExp(`^\\s*${ackWord}(?:[\\s.,!]*${ackWord})*[\\s.,!🙏👍😊☺️👌❤️]*$`, 'i'),
    done: d.length ? new RegExp(`^\\s*(${DONE_CORE}|${d.join('|')})\\b[\\s.,!🙏👍✅😊]*$`, 'i') : DONE_RE,
    all_fine: f.length ? new RegExp(`^\\s*(${ALL_FINE_CORE}|${f.join('|')})\\b[\\s.,!🙏👍✅😊]*$`, 'i') : ALL_FINE_RE,
    avail: v.length ? new RegExp(`\\b(${AVAIL_CORE}|${v.join('|')})\\b`, 'i') : AVAIL_RE,
    restock: r.length ? new RegExp(`\\b(${RESTOCK_CORE}|${r.join('|')})\\b`, 'i') : RESTOCK_RE,
    schedule: s.length ? new RegExp(`\\b(${SCHEDULE_CORE}|${s.join('|')})\\b`, 'i') : SCHEDULE_WORD_RE,
  };
}
export function applyStaffLangExtras(extra = {}) {
  EXTRA = { ack: [], done: [], all_fine: [], avail: [], restock: [], schedule: [] };
  for (const k of Object.keys(EXTRA)) EXTRA[k] = Array.isArray(extra?.[k]) ? extra[k].map(String) : [];
  _live = null;
}
export const staffLangExtras = () => EXTRA;
export async function loadStaffLangExtras(db) {
  if (Date.now() - _loadedAt < 10 * 60e3) return EXTRA;
  _loadedAt = Date.now();
  try {
    const { getSettingValue } = await import('./campaigns.js');
    applyStaffLangExtras((await getSettingValue(db, 'staff_lang_extra')) || {});
  } catch { /* keep what we have */ }
  return EXTRA;
}
const live = () => { if (!_live) build(); return _live; };

// A bare acknowledgement: never changes a record, never needs a reply.
const ACK_WORD = '(?:ok(?:e|ay|ee)?|oke|baik|siap|sip|mantap|noted|ya|iya|yes|yup|thx|thanks?(?:\\s+you)?|terima\\s?kasih?|makasih|makasi|kak|kaka|maya|bu|mbak|bli|pak|👍|🙏|😊|☺️|👌|❤️)';
export const ACK_RE = new RegExp(`^\\s*${ACK_WORD}(?:[\\s.,!]*${ACK_WORD})*[\\s.,!🙏👍😊☺️👌❤️]*$`, 'i');
export const isAck = (t) => live().ack.test(String(t || ''));

// "It is done": only these, on their own. "siap" is NOT here on purpose —
// it is how people say "understood" — and neither is "ya".
const DONE_CORE = 'sudah( selesai)?|selesai( semua)?|udah( selesai)?|beres|kelar|done|finished|semua sudah|sudah semua|sudah beres';
export const DONE_RE = new RegExp(`^\\s*(${DONE_CORE})\\b[\\s.,!🙏👍✅😊]*$`, 'i');
export const isDone = (t) => live().done.test(String(t || ''));

// Closes an inspection round without a fault: "all fine".
const ALL_FINE_CORE = 'semua (bagus|ok|oke|aman|baik|bersih)|aman( semua)?|tidak ada (masalah|kerusakan|yang rusak)|nothing (wrong|broken)|all (good|fine|ok)';
export const ALL_FINE_RE = new RegExp(`^\\s*(${ALL_FINE_CORE})\\b[\\s.,!🙏👍✅😊]*$`, 'i');
export const isAllFine = (t) => live().all_fine.test(String(t || ''));

export const GREETING_RE = /^\s*(halo+|hallo+|hai|hi|hello|hey|selamat\s+(pagi|siang|sore|malam)|pagi|siang|sore|malam)(\s+(maya|kak|kaka|bu|mbak|bli))?[\s.!🙏😊☺️👋]*$/i;
export const isGreeting = (t) => GREETING_RE.test(String(t || ''));

export const QUESTION_RE = /\?|^\s*(kapan|apakah|bisakah|bolehkah|boleh|gimana|bagaimana|kenapa|mengapa|berapa|apa\b|dimana|di mana|siapa|why|when|what|how|where|can i|could i|should i)/i;
export const isQuestion = (t) => QUESTION_RE.test(String(t || ''));

// About her day rather than the villa: off, sick, cannot, a day she names.
const AVAIL_CORE = "libur|cuti|sakit|izin|ijin|tidak bisa|tdk bisa|gak bisa|ga bisa|nggak bisa|engga bisa|besok saja|besok aja|lusa|minggu depan|day off|off today|can'?t today|cannot today|not today|sick";
export const AVAIL_RE = new RegExp(`\\b(${AVAIL_CORE})\\b`, 'i');
export const isAvail = (t) => live().avail.test(String(t || ''));

// Supplies running low — the only free text a readiness check keeps.
const RESTOCK_CORE = 'habis|hampir habis|mau habis|kurang|tinggal|sisa|perlu|butuh|minta|stok|stock|sabun|tisu|tissue|galon|air|shampoo|sampo|kantong sampah|low on|running out|need more|out of';
export const RESTOCK_RE = new RegExp(`\\b(${RESTOCK_CORE})\\b`, 'i');
export const isRestock = (t) => live().restock.test(String(t || ''));

// A weekly pattern: needs the word for a schedule or a frequency, or a
// villa AND a weekday. A bare weekday ("Kamis saya ke dokter") is not one.
const SCHEDULE_CORE = 'jadwal|schedule|seminggu|per minggu|setiap|tiap|every|x seminggu|kali seminggu';
export const SCHEDULE_WORD_RE = new RegExp(`\\b(${SCHEDULE_CORE})\\b`, 'i');
export const isScheduleWord = (t) => live().schedule.test(String(t || ''));

// A caption that only says which villa the photo is of, greets, or
// acknowledges: "Ini unit 1 ya buk", "B3", "Foto A5". Not a finding, not a
// report, whatever the photo shows (9 Sep 2026: Putu's bed photo at HAUS 1
// became ticket #27 'Unit 1 inspection' because a caption longer than
// twelve characters counted as a fault when a photo came with it).
const UNIT_ONLY_RE = /^\s*(?:ini|itu|this is|foto|photo|nih)?\s*(?:unit|villa|kamar|room|haus|tropicana|lanehaus|rumah|no\.?)?\s*[a-z]?\s?\d{0,3}[a-z]?\s*(?:ya+|nih|nya|kak|kaka|buk|bu|mbak|maya|pak|bli)?\s*(?:ya+|buk|bu|kak|kaka|mbak|maya|pak|bli)?[\s.,!🙏😊👍]*$/i;
export const isNoiseCaption = (t) => { const s = String(t || '').trim(); return !s || isAck(s) || isGreeting(s) || UNIT_ONLY_RE.test(s); };

// The webhook substitutes a bracketed instruction for a captionless image.
// Nothing a person types starts with "[Agent sent".
export const realText = (t) => {
  const s = String(t || '').trim();
  if (/^\[(agent|guest|user|owner) sent an? /i.test(s)) return '';
  if (/^\[.*\]$/.test(s) && /image|photo|audio|video|document|sticker|unsupported|unknown/i.test(s)) return '';
  return s;
};

// Strip a trailing address ("kak", "maya") and punctuation for matching.
export const bare = (t) => String(t || '').trim().replace(/\s+(kak|kaka|maya|bu|mbak|bli|pak)\s*$/i, '').replace(/[\s.,!🙏👍✅😊]+$/g, '').trim();
