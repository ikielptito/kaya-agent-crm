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

// A bare acknowledgement: never changes a record, never needs a reply.
const ACK_WORD = '(?:ok(?:e|ay|ee)?|oke|baik|siap|sip|mantap|noted|ya|iya|yes|yup|thx|thanks?(?:\\s+you)?|terima\\s?kasih?|makasih|makasi|kak|kaka|maya|bu|mbak|bli|pak|👍|🙏|😊|☺️|👌|❤️)';
export const ACK_RE = new RegExp(`^\\s*${ACK_WORD}(?:[\\s.,!]*${ACK_WORD})*[\\s.,!🙏👍😊☺️👌❤️]*$`, 'i');
export const isAck = (t) => ACK_RE.test(String(t || ''));

// "It is done": only these, on their own. "siap" is NOT here on purpose —
// it is how people say "understood" — and neither is "ya".
export const DONE_RE = /^\s*(sudah( selesai)?|selesai( semua)?|udah( selesai)?|beres|kelar|done|finished|semua sudah|sudah semua|sudah beres)\b[\s.,!🙏👍✅😊]*$/i;
export const isDone = (t) => DONE_RE.test(String(t || ''));

// Closes an inspection round without a fault: "all fine".
export const ALL_FINE_RE = /^\s*(semua (bagus|ok|oke|aman|baik|bersih)|aman( semua)?|tidak ada (masalah|kerusakan|yang rusak)|nothing (wrong|broken)|all (good|fine|ok))\b[\s.,!🙏👍✅😊]*$/i;
export const isAllFine = (t) => ALL_FINE_RE.test(String(t || ''));

export const GREETING_RE = /^\s*(halo+|hallo+|hai|hi|hello|hey|selamat\s+(pagi|siang|sore|malam)|pagi|siang|sore|malam)(\s+(maya|kak|kaka|bu|mbak|bli))?[\s.!🙏😊☺️👋]*$/i;
export const isGreeting = (t) => GREETING_RE.test(String(t || ''));

export const QUESTION_RE = /\?|^\s*(kapan|apakah|bisakah|bolehkah|boleh|gimana|bagaimana|kenapa|mengapa|berapa|apa\b|dimana|di mana|siapa|why|when|what|how|where|can i|could i|should i)/i;
export const isQuestion = (t) => QUESTION_RE.test(String(t || ''));

// About her day rather than the villa: off, sick, cannot, a day she names.
export const AVAIL_RE = /\b(libur|cuti|sakit|izin|ijin|tidak bisa|tdk bisa|gak bisa|ga bisa|nggak bisa|engga bisa|besok saja|besok aja|lusa|minggu depan|day off|off today|can'?t today|cannot today|not today|sick)\b/i;
export const isAvail = (t) => AVAIL_RE.test(String(t || ''));

// Supplies running low — the only free text a readiness check keeps.
export const RESTOCK_RE = /\b(habis|hampir habis|mau habis|kurang|tinggal|sisa|perlu|butuh|minta|stok|stock|sabun|tisu|tissue|galon|air|shampoo|sampo|kantong sampah|low on|running out|need more|out of)\b/i;
export const isRestock = (t) => RESTOCK_RE.test(String(t || ''));

// A weekly pattern: needs the word for a schedule or a frequency, or a
// villa AND a weekday. A bare weekday ("Kamis saya ke dokter") is not one.
export const SCHEDULE_WORD_RE = /\b(jadwal|schedule|seminggu|per minggu|setiap|tiap|every|x seminggu|kali seminggu)\b/i;

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
