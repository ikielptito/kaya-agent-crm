// Turning what Era and the cleaners actually send into maintenance records.
//
// They don't fill in forms — they send a photo with "Haus unit 1 bathroom
// wall needs paint touch up", or answer a nudge with "next tuesday". This
// module reads those two kinds of message: a NEW report, or a REPLY about
// an item Maya is already chasing.
//
// Deterministic first, LLM second: the property is matched against the real
// statement groups (lib/maintenance.js matchProperty), and Claude is only
// asked for the parts a regex genuinely can't do — a tidy title, and what
// "next tuesday" means in WITA. If the LLM is unavailable the fallbacks
// still produce a usable item, because losing a maintenance report is worse
// than filing an imperfect one.

const MODEL = process.env.MAINTENANCE_LLM_MODEL || 'claude-haiku-4-5-20251001';

// WITA (UTC+8) — the calendar Era lives in.
export function witaToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

async function askClaude(prompt, maxTokens = 400) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

// ── Is this a maintenance report at all? ────────────────────────────
// Cheap gate so Era's ordinary team chatter never becomes a work order.
// A photo alone isn't enough — she also sends guest photos and receipts.
const MAINT_WORDS = /\b(broken|break|leak|leaking|crack|cracked|damage[ds]?|repair|fix|fixing|replace|replacement|not working|doesn'?t work|stopped working|paint|touch[- ]?up|clean(ing)?\s+needed|mould|mold|rust|rusty|blocked|clog(ged)?|burnt?( out)?|dead|loose|stuck|jammed|torn|stain(ed)?|missing|faulty|maintenance|service|aircon|ac\b|water heater|pump|wifi|router|light bulb|bulb|door|window|tap|faucet|shower|toilet|sink|drain|pool|chair|table|sofa|bed|mattress|fridge|oven|stove|kettle|washing machine)\b/i;

// The same vocabulary in Indonesian. This gate was written when Era, who
// writes English, was the only person who could file a report. Once the
// housekeepers and the tukang were let in, it silently swallowed almost
// everything they sent: "kran kamar mandi bocor" matched nothing, so a
// leaking tap never reached the model at all. A gate that drops real reports
// is worse than one that occasionally lets chatter through — Era can delete
// a spurious ticket, but nobody can act on a report that was never filed.
const MAINT_WORDS_ID = /\b(rusak|patah|pecah|retak|bocor|mampet|tersumbat|macet|mati|jamur|lembab|lembap|rembes|karat|berkarat|kotor|bau|sobek|robek|lepas|copot|goyang|hilang|ganti|diganti|perbaiki|perbaikan|diperbaiki|servis|benerin|betulin|ngadat|kran|keran|wastafel|kloset|closet|toilet|kamar mandi|lampu|listrik|stopkontak|saklar|kabel|pintu|jendela|lemari|kursi|meja|kasur|tempat tidur|kulkas|kompor|mesin cuci|pemanas|air panas|kolam|pompa|atap|plafon|langit-langit|dinding|lantai|kunci|gorden|tirai)\b/i;
// "AC tidak dingin", "airnya tidak panas", "lampu tidak menyala" — the fault
// is the negation, not any single noun. Kept narrow on purpose: a bare
// "tidak bisa" is someone declining a job, which other handlers claim first.
const MAINT_NEGATION_ID = /\b(tidak|tdk|ga|gak|nggak|engga|belum)\s+(dingin|panas|nyala|menyala|hidup|jalan|berfungsi|keluar|ngalir|mengalir|bunyi|kencang)\b/i;

export function looksLikeMaintenance(text, hasImage) {
  const t = String(text || '');
  if (/^\s*(maintenance|repair|issue|problem|rusak|perbaikan)\s*[:\-]/i.test(t)) return true;
  const hasWord = MAINT_WORDS.test(t) || MAINT_WORDS_ID.test(t) || MAINT_NEGATION_ID.test(t);
  // With a photo we accept a weaker signal — the picture carries the detail.
  return hasImage ? (hasWord || t.trim().length > 12) : hasWord;
}

// ── New report → one or more structured items ───────────────────────
// `matched` is the result of matchProperty() so the model never invents a
// property; it only writes the title/description/urgency/cost.
//
// Two things this has to get right, because they're what people actually
// send: ONE message often describes SEVERAL jobs ("the wardrobe door and
// the patio chairs"), and the price is written the Indonesian way —
// "1.1jt each", "500rb", "2 juta". A quoted unit price with a quantity has
// to become the total, or Era would publish a number that's half the bill.
const money = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : null);

// Last-resort price reader for when the model is unavailable.
function sniffCost(raw) {
  const m = String(raw).match(/(?:rp\s*)?(\d+(?:[.,]\d+)?)\s*(jt|juta|m(?:io)?\b|rb|ribu|k\b)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  const mult = /^(jt|juta|m)/.test(unit) ? 1e6 : 1e3;
  return money(n * mult);
}

export async function extractReports(text, { matched, hasImage } = {}) {
  const raw = String(text || '').trim();
  const fallback = [{
    title: raw.replace(/\s+/g, ' ').slice(0, 90) || (hasImage ? 'Maintenance issue (photo)' : 'Maintenance issue'),
    description: raw || null,
    urgency: /\b(urgent|asap|emergency|immediately|flood|no water|no power|dangerous)\b/i.test(raw) ? 'urgent' : 'normal',
    estimated_cost: sniffCost(raw),
  }];
  if (!raw) return fallback;

  const out = await askClaude(
`A villa manager in Bali sent this maintenance report about ${matched?.unit_label || matched?.group?.name || 'a managed villa'}${hasImage ? ' (with photos attached)' : ''}:

"${raw}"

Split it into separate work orders ONLY if it clearly describes distinct jobs (for example a door repair AND replacing chairs). Otherwise return exactly one.

Reply with ONLY a JSON object:
{"items": [
  {"title": "short work-order title, max 70 chars, e.g. 'Wardrobe door repair'",
   "description": "one clean sentence of detail, or null if the title says it all",
   "urgency": "low" | "normal" | "urgent",
   "estimated_cost": number or null}
]}

estimated_cost rules — this is money, so be exact:
· Only fill it when the message actually states a price. Never guess a price.
· Indonesian shorthand: "jt" and "juta" mean million, "rb"/"ribu"/"k" mean thousand. So 1.1jt = 1100000, 500rb = 500000.
· If a price is per-item and a quantity is given, return the TOTAL. "two chairs ... 1.1jt each" = 2200000.
· Give the number in plain IDR with no separators.
· If the message gives one price covering several jobs you split, put the whole amount on the job it belongs to and null on the others.

Use "urgent" only for things that stop a guest staying or risk damage (flooding, no water, no power, broken lock, aircon dead in an occupied unit).`, 900);

  const items = Array.isArray(out?.items) ? out.items.filter(i => i && i.title) : [];
  if (!items.length) return fallback;
  return items.slice(0, 4).map(i => ({
    title: String(i.title).slice(0, 90),
    description: i.description ? String(i.description).slice(0, 800) : null,
    urgency: ['low', 'normal', 'urgent'].includes(i.urgency) ? i.urgency : 'normal',
    estimated_cost: money(Number(i.estimated_cost)),
  }));
}

// Kept for callers that only ever want one item.
export async function extractReport(text, opts) {
  return (await extractReports(text, opts))[0];
}

// ── Which job is this photo of? ─────────────────────────────────────
// One message can create several tickets, and the pictures belong to
// particular ones — a wardrobe door and a broken chair should not both end
// up on both tickets. Maya looks at the photo and picks. She is asked to
// answer null when unsure, because attaching to the wrong job is worse than
// admitting she can't tell.
export async function classifyPhoto({ base64, mime }, titles) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !base64 || titles.length < 2) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MAINTENANCE_VISION_MODEL || 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text:
`This photo was sent with a villa maintenance report that produced these separate jobs:
${titles.map((t, i) => `${i}: ${t}`).join('\n')}

Which job is this photo showing? Reply with ONLY JSON:
{"index": <number or null>, "confident": true|false, "why": "at most 8 words"}

Use null when the photo could plausibly be any of them, or shows something else entirely. Only set confident when the photo clearly shows that specific item.` },
          ],
        }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const out = JSON.parse(m[0]);
    const idx = Number.isInteger(out.index) && out.index >= 0 && out.index < titles.length ? out.index : null;
    return { index: out.confident ? idx : null, why: out.why || null };
  } catch { return null; }
}

// ── Reply to a nudge → what should happen to the item ───────────────
// Era answers in her own words: "done", "finished yesterday", "next
// tuesday", "waiting for the part". We need: is it finished, and if not,
// when should Maya ask again?
export async function parseStaffReply(text, { itemTitle } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'note' };

  // Unambiguous completions shouldn't need a model call.
  if (/^\s*(done|finished|completed?|complete|sudah|selesai|beres|fixed|all done|it'?s done)\b[\s.!👍✅]*$/i.test(raw)) {
    return { intent: 'done', note: raw };
  }

  const today = witaToday();
  const out = await askClaude(
`Today is ${today} (Bali/WITA). A villa manager was asked about this repair: "${itemTitle || 'a maintenance item'}".

She replied: "${raw}"

Reply with ONLY a JSON object:
{"intent": "done" | "scheduled" | "blocked" | "note",
 "date": "YYYY-MM-DD or null — when she expects it finished, resolving words like 'next tuesday', 'besok', 'tomorrow', 'end of the week' against today's date",
 "summary": "at most 12 words describing her answer"}

"done" = the work is already finished.
"scheduled" = it will be finished on/by a date.
"blocked" = she's waiting on something (a part, a supplier, the guest checking out) with no firm date.
"note" = anything else.`, 300);

  if (!out?.intent) return { intent: 'note', note: raw };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(out.date || '')) ? out.date : null;
  return {
    intent: ['done', 'scheduled', 'blocked', 'note'].includes(out.intent) ? out.intent : 'note',
    // Never schedule a nudge in the past — that would fire immediately.
    date: date && date >= today ? date : null,
    summary: out.summary ? String(out.summary).slice(0, 120) : null,
    note: raw,
  };
}

// ── Tukang reply → can he come, and when ────────────────────────────
// The other half of the repair conversation. A tukang answers in Indonesian,
// briefly, and usually with a time: "bisa besok pagi jam 9", "hari ini sore",
// "sudah selesai". Two things matter: what he means, and which concrete
// instant he named. An appointment resolved wrongly wastes his trip and the
// tenant's morning, so an unclear answer gives a null time and Maya asks
// again rather than inventing a slot.
export async function parseTukangReply(text, { itemTitle, place } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'note' };

  // The common one-word answers, without paying for a model call.
  if (/^\s*(sudah|selesai|beres|done|finished|udah|kelar)\b[\s.!👍✅]*$/i.test(raw)) return { intent: 'done', note: raw };
  if (/^\s*(sudah sampai|otw|on the way|saya di sini|sampai|tiba)\b[\s.!]*$/i.test(raw)) return { intent: 'arrived', note: raw };
  if (/^\s*(tidak bisa|ga bisa|gak bisa|nggak bisa|maaf tidak bisa|can'?t|cannot|no)\b/i.test(raw)) return { intent: 'decline', note: raw };

  const today = witaToday();
  const out = await askClaude(
`Today is ${today} (Bali, WITA, UTC+08:00). A tukang (repairman) was sent this job: "${itemTitle || 'a repair'}"${place ? ` at ${place}` : ''}.

He replied (Indonesian or English): "${raw}"

Reply with ONLY a JSON object:
{"intent": "accept" | "decline" | "arrived" | "done" | "question" | "note",
 "at": "ISO 8601 datetime with the +08:00 offset for the day AND time he can come, or null",
 "summary": "at most 12 words, in English, describing his answer"}

"accept" = he will come. Set "at" only if he named a day AND a time.
  Resolve relative days forward from today: "besok"=tomorrow, "lusa"=day after,
  "senin"=the coming Monday. Map vague times to the middle of that window:
  "pagi"=09:00, "siang"=12:00, "sore"=16:00, "malam"=19:00.
  If he named a day but no time at all, use 09:00. If he named neither, null.
"decline" = he cannot take the job.
"arrived" = he is at the property now.
"done" = the repair is finished.
"question" = he asked something and did not commit.
"note" = anything else.`, 300);

  if (!out?.intent) return { intent: 'note', note: raw };
  const intent = ['accept', 'decline', 'arrived', 'done', 'question', 'note'].includes(out.intent) ? out.intent : 'note';
  let at = null;
  if (out.at && !Number.isNaN(Date.parse(out.at))) {
    const iso = new Date(out.at).toISOString();
    // Never book into the past. A model that misreads "senin" and lands on
    // last Monday would otherwise fire the day-of reminder immediately.
    if (Date.parse(iso) > Date.now() - 3600e3) at = iso;
  }
  return { intent, at, summary: out.summary ? String(out.summary).slice(0, 120) : null, note: raw };
}

// ── Housekeeper reply → move the clean, or escalate ─────────────────
// She was asked to clean a villa today. Two answers matter: a different day
// she CAN do it, or that she cannot and needs Era. Anything else falls
// through to a human — a cleaner's chat is not a form.
export async function parseCleaningReply(text, { villa } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'none' };

  const today = witaToday();
  const out = await askClaude(
`Today is ${today} (Bali, WITA). A housekeeper was asked to clean ${villa || 'a villa'} today.

She replied (Indonesian or English): "${raw}"

Reply with ONLY a JSON object:
{"intent": "move" | "cannot" | "done" | "note",
 "date": "YYYY-MM-DD, only when she named a day she CAN do it, else null",
 "summary": "at most 12 words, in English"}

"move" = she wants a different day AND named one. Resolve relative days
  forward from today: "besok"=tomorrow, "lusa"=day after, "senin"=the coming
  Monday, "nanti sore"=today.
"cannot" = she cannot do it and named no alternative day.
"done" = she has already done it.
"note" = anything else, including a question.`, 250);

  if (!out?.intent) return { intent: 'note', note: raw };
  const intent = ['move', 'cannot', 'done', 'note'].includes(out.intent) ? out.intent : 'note';
  // Never move a clean into the past, and never further out than a fortnight:
  // a model misreading "senin" should not park the villa's cleaning in March.
  let date = /^\d{4}-\d{2}-\d{2}$/.test(String(out.date || '')) ? out.date : null;
  if (date && (date < today || date > new Date(Date.parse(today) + 14 * 86400e3).toISOString().slice(0, 10))) date = null;
  return { intent, date, summary: out.summary ? String(out.summary).slice(0, 120) : null, note: raw };
}

// ── Owner reply → approve / decline ─────────────────────────────────
// Owners can answer Maya directly instead of opening the link.
export async function parseOwnerDecision(text) {
  const raw = String(text || '').trim();
  if (!raw) return { decision: null };
  if (/^\s*(yes|yep|yeah|ok|okay|approved?|go ahead|do it|please do|proceed|sure|setuju|silakan)\b/i.test(raw)) {
    return { decision: 'approve', note: raw };
  }
  if (/^\s*(no|nope|don'?t|do not|decline|reject|not now|hold off|wait)\b/i.test(raw)) {
    return { decision: 'decline', note: raw };
  }
  const out = await askClaude(
`A villa owner was asked to approve a maintenance repair and replied: "${raw}"

Reply with ONLY: {"decision": "approve" | "decline" | "unclear", "note": "at most 12 words"}
Use "unclear" if they asked a question or didn't actually decide.`, 200);
  const d = out?.decision;
  return { decision: d === 'approve' || d === 'decline' ? d : null, note: raw };
}
