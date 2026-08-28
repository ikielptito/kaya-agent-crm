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

export function looksLikeMaintenance(text, hasImage) {
  const t = String(text || '');
  if (/^\s*(maintenance|repair|issue|problem)\s*[:\-]/i.test(t)) return true;
  const hasWord = MAINT_WORDS.test(t);
  // With a photo we accept a weaker signal — the picture carries the detail.
  return hasImage ? (hasWord || t.trim().length > 12) : hasWord;
}

// ── New report → structured item ────────────────────────────────────
// `matched` is the result of matchProperty() so the model never invents a
// property; it only writes the title/description/urgency.
export async function extractReport(text, { matched, hasImage } = {}) {
  const raw = String(text || '').trim();
  const fallback = {
    title: raw.replace(/\s+/g, ' ').slice(0, 90) || (hasImage ? 'Maintenance issue (photo)' : 'Maintenance issue'),
    description: raw || null,
    urgency: /\b(urgent|asap|emergency|immediately|flood|no water|no power|dangerous)\b/i.test(raw) ? 'urgent' : 'normal',
  };
  if (!raw) return fallback;

  const out = await askClaude(
`A villa manager in Bali sent this maintenance report about ${matched?.unit_label || matched?.group?.name || 'a managed villa'}${hasImage ? ' (with a photo attached)' : ''}:

"${raw}"

Reply with ONLY a JSON object:
{"title": "short work-order title, max 70 chars, e.g. 'Bathroom wall paint touch-up'",
 "description": "one clean sentence of detail, or null if the title says it all",
 "urgency": "low" | "normal" | "urgent"}

Use "urgent" only for things that stop a guest staying or risk damage (flooding, no water, no power, broken lock, aircon dead in an occupied unit).`);

  if (!out?.title) return fallback;
  return {
    title: String(out.title).slice(0, 90),
    description: out.description ? String(out.description).slice(0, 800) : (raw.length > 90 ? raw.slice(0, 800) : null),
    urgency: ['low', 'normal', 'urgent'].includes(out.urgency) ? out.urgency : fallback.urgency,
  };
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
