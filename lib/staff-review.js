// The staff lane of Maya's weekly review.
//
// The Sunday review (maya-review.js) grades Maya's sales replies and turns
// them into playbook lessons. The staff side is different in kind: most of
// it is deterministic (word rules, buttons, one small classifier) and a
// housekeeper's message is not judged for tone but for whether it became
// the right record. So this lane reads the structured trail instead of
// transcripts, and proposes settings rather than prose:
//
//   THE FUNNEL   staff_turns for the week — said → understood → recorded →
//                right (not corrected by a person afterwards), by layer,
//                by kind of message and by person.
//   THE METRICS  asks answered/ignored and how long they took, visits done
//                and evidenced, tips sent and whether the pattern came back,
//                Era's interventions (corrections + forwards + writes via
//                Maya). Logged every week (settings.staff_review_log) so
//                the trend shows.
//   PROPOSALS    one Sonnet call over the misses: words to add to the
//                rules, corrected messages to give the classifier as
//                examples, coaching verdicts (worked / persisted / confused),
//                and each person's real reply hours. Staged for Ikiel; only
//                approved items change anything, and only as settings the
//                code reads with tolerance for absence:
//                  staff_lang_extra          words per rule list
//                  staff_classifier_examples few-shot lines
//                  staff_coaching_overrides  reworded tips
//                  staff_profiles            per-person nudge hour
//
// The review never edits code, and nothing here reaches the owner or
// sales prompts.

import { turnsSince } from './staff-turns.js';
import { correctionsSince } from './corrections.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';
import { buildRecords } from './housekeeping-records.js';
import { TIPS } from './coaching.js';

const MODEL = 'claude-sonnet-4-6';
const RATES = { in: 3, out: 15 };
const LOG_KEY = 'staff_review_log';
const LOG_CAP = 16;
const MAX_PROPOSALS = 14;
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
const witaDay = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 10);
const witaHour = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).getUTCHours();
const shortId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pct = (a, b) => b ? Math.round(100 * a / b) : null;
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

async function sbGet(db, path) {
  try { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders }); return r.ok ? r.json() : []; } catch { return []; }
}

// ── The funnel (pure) ──────────────────────────────────────────────
// understood: Maya placed the message somewhere (a record, an ask back, a
// tip, an answer, a plain ack). Not understood: forwarded to a person, or
// an error. recorded: a record was written. right: recorded and no person
// changed that record afterwards.
const UNDERSTOOD = new Set(['recorded', 'asked', 'coached', 'answered', 'ack', 'parked']);
export function funnel(turns = []) {
  const f = { said: turns.length, understood: 0, recorded: 0, right: 0, corrected: 0, forwarded: 0, error: 0, by_kind: {}, by_layer: {}, by_outcome: {}, low_confidence: 0 };
  for (const t of turns) {
    const k = t.kind || 'text', l = t.layer || 'none', o = t.outcome || 'forwarded';
    f.by_kind[k] = (f.by_kind[k] || 0) + 1;
    f.by_layer[l] = f.by_layer[l] || { said: 0, recorded: 0, corrected: 0, forwarded: 0 };
    f.by_layer[l].said++;
    f.by_outcome[o] = (f.by_outcome[o] || 0) + 1;
    if (UNDERSTOOD.has(o)) f.understood++;
    if (o === 'forwarded') { f.forwarded++; f.by_layer[l].forwarded++; }
    if (o === 'error') f.error++;
    if (o === 'recorded') {
      f.recorded++; f.by_layer[l].recorded++;
      if (t.corrected_at) { f.corrected++; f.by_layer[l].corrected++; } else f.right++;
    }
    if (l === 'classifier' && t.confidence === 'low') f.low_confidence++;
  }
  f.rates = { understood: pct(f.understood, f.said), recorded: pct(f.recorded, f.said), right: pct(f.right, f.recorded) };
  return f;
}

export function perPerson(turns = [], staffById = {}) {
  const by = new Map();
  for (const t of turns) {
    const key = t.staff_id || t.wa_num;
    if (!by.has(key)) by.set(key, { staff_id: t.staff_id || null, wa_num: t.wa_num, name: staffById[t.staff_id]?.name || t.wa_num, turns: [], hours: {} });
    const p = by.get(key);
    p.turns.push(t);
    const h = witaHour(t.received_at); p.hours[h] = (p.hours[h] || 0) + 1;
  }
  return [...by.values()].map(p => {
    const f = funnel(p.turns);
    const hours = Object.entries(p.hours).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h, n]) => ({ hour: +h, n }));
    return { staff_id: p.staff_id, wa_num: p.wa_num, name: p.name, said: f.said, understood: f.understood, recorded: f.recorded, right: f.right, corrected: f.corrected, forwarded: f.forwarded, by_kind: f.by_kind, busiest_hours: hours };
  }).sort((a, b) => b.said - a.said);
}

// ── The metrics ────────────────────────────────────────────────────
export async function staffWeekMetrics(db, { days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString();
  const today = witaDay(now.toISOString());
  const from = witaDay(since);
  const [turns, corrections, staff, asks, coachMsgs, coachState, teamLog, records] = await Promise.all([
    turnsSince(db, { days }),
    correctionsSince(db, { days }),
    sbGet(db, 'staff?select=id,name,wa_num,roles,active&limit=100'),
    sbGet(db, `staff_asks?asked_at=gte.${encodeURIComponent(since)}&select=id,wa_num,staff_id,kind,asked_at,answered_at,expires_at&limit=1000`),
    sbGet(db, `wa_messages?category=eq.staff_coach&direction=eq.outbound&timestamp=gte.${encodeURIComponent(since)}&select=wa_num,content,timestamp&limit=300`),
    getSettingValue(db, 'staff_coaching').catch(() => null),
    getSettingValue(db, 'team_assistant_log').catch(() => null),
    buildRecords(db, { from, to: today, audience: 'era' }).catch(() => ({ records: [] })),
  ]);
  const staffById = {}; for (const s of (Array.isArray(staff) ? staff : [])) staffById[s.id] = s;
  const staffByNum = {}; for (const s of (Array.isArray(staff) ? staff : [])) if (s.wa_num) staffByNum[digits(s.wa_num)] = s;
  const nameOf = (num) => staffByNum[digits(num)]?.name || num;

  // Asks: answered, ignored (expired unanswered), still open; how long an
  // answer took, by kind.
  const A = Array.isArray(asks) ? asks : [];
  const askKinds = {};
  const latencies = [];
  for (const a of A) {
    const k = a.kind || 'other';
    askKinds[k] = askKinds[k] || { sent: 0, answered: 0, ignored: 0, open: 0 };
    askKinds[k].sent++;
    if (a.answered_at) { askKinds[k].answered++; latencies.push((Date.parse(a.answered_at) - Date.parse(a.asked_at)) / 60e3); }
    else if (a.expires_at && a.expires_at < nowIso()) askKinds[k].ignored++;
    else askKinds[k].open++;
  }
  const askTotals = Object.values(askKinds).reduce((s, k) => ({ sent: s.sent + k.sent, answered: s.answered + k.answered, ignored: s.ignored + k.ignored, open: s.open + k.open }), { sent: 0, answered: 0, ignored: 0, open: 0 });

  // Visits in the window, from the same builder the cockpit uses.
  const V = (records?.records || []).filter(r => r.type === 'visit' && r.date < today);
  const visits = { total: V.length, done: 0, photos: 0, reported: 0, reported_late: 0, not_done: 0, unconfirmed: 0, uncovered: 0, skipped: 0 };
  for (const r of V) {
    const s = r.visit_status || r.status;
    if (s === 'done') { visits.done++; if (r.evidence === 'photos') visits.photos++; else if (r.evidence === 'reported_late') visits.reported_late++; else visits.reported++; }
    else if (s === 'not_done') visits.not_done++;
    else if (s === 'unconfirmed') visits.unconfirmed++;
    else if (s === 'not_sent' || s === 'uncovered') visits.uncovered++;
    else if (s === 'skipped') visits.skipped++;
  }
  visits.rates = { done: pct(visits.done, visits.total - visits.skipped), photos: pct(visits.photos, visits.done), unconfirmed: pct(visits.unconfirmed, visits.total - visits.skipped) };

  // Coaching: tips sent this week (from the log) and, per person and
  // pattern, whether it was seen again after the tip.
  const CM = Array.isArray(coachMsgs) ? coachMsgs : [];
  const tipKeyOf = (content) => Object.keys(TIPS).find(k => content && content.startsWith(TIPS[k].slice(0, 40))) || 'other';
  const coaching = { tips_sent: CM.length, by_key: {}, people: [] };
  for (const m of CM) { const k = tipKeyOf(m.content); coaching.by_key[k] = (coaching.by_key[k] || 0) + 1; }
  const st = coachState && typeof coachState === 'object' ? coachState : {};
  for (const [num, keys] of Object.entries(st)) {
    for (const [k, v] of Object.entries(keys || {})) {
      if (!k.endsWith('_seen')) continue;
      const key = k.replace(/_seen$/, '');
      const seen = (Array.isArray(v) ? v : []).filter(d => Date.parse(d) >= Date.parse(since));
      const told = keys[key] ? Date.parse(keys[key]) : null;
      const after = told ? seen.filter(d => Date.parse(d) > told).length : 0;
      if (seen.length) coaching.people.push({ name: nameOf(num), wa_num: num, key, seen_this_week: seen.length, told_at: keys[key] || null, seen_after_tip: after, verdict: !told ? 'not_told' : after >= 2 ? 'persisted' : after === 1 ? 'once_more' : 'worked' });
    }
  }

  // Era's hand in it: corrections, messages nobody could place, and the
  // writes she made through Maya on visits and tickets.
  const TL = (Array.isArray(teamLog) ? teamLog : []).filter(e => e.at && Date.parse(e.at) >= Date.parse(since) && /^(hk_|maint_)/.test(e.tool || '') && e.ok);
  const fn = funnel(turns);
  const interventions = { corrections: corrections.length, forwarded: fn.forwarded, writes_via_maya: TL.length, total: corrections.length + fn.forwarded + TL.length };

  return {
    week_of: today, days, since, generated_at: nowIso(),
    funnel: fn,
    people: perPerson(turns, staffById),
    asks: { ...askTotals, by_kind: askKinds, median_minutes: median(latencies) },
    visits, coaching, interventions,
    corrections: corrections.slice(-40).map(c => ({ at: c.at, target: `${c.target_type}#${c.target_id}`, by: c.by, source: c.source, change: c.change, turn_text: c.turn_text || null, turn_layer: c.turn_layer || null, staff: c.staff_id ? (staffById[c.staff_id]?.name || null) : null })),
    _turns: turns, _staffByNum: staffByNum,
  };
}

// The trend line: one row per week, written when the review runs.
export async function logStaffWeek(db, m) {
  const log = (await getSettingValue(db, LOG_KEY).catch(() => null)) || [];
  const row = {
    week_of: m.week_of, at: m.generated_at,
    said: m.funnel.said, understood: m.funnel.rates.understood, recorded: m.funnel.rates.recorded, right: m.funnel.rates.right,
    forwarded: m.funnel.forwarded, corrected: m.funnel.corrected,
    asks_answered: pct(m.asks.answered, m.asks.sent), ask_minutes: m.asks.median_minutes,
    visits_done: m.visits.rates.done, visits_photos: m.visits.rates.photos, visits_unconfirmed: m.visits.unconfirmed,
    tips: m.coaching.tips_sent, persisted: m.coaching.people.filter(p => p.verdict === 'persisted').length,
    interventions: m.interventions.total,
  };
  const next = [row, ...(Array.isArray(log) ? log : []).filter(r => r.week_of !== row.week_of)].slice(0, LOG_CAP);
  await saveSettingValue(db, LOG_KEY, next).catch(() => {});
  return row;
}
export async function staffReviewLog(db) { return (await getSettingValue(db, LOG_KEY).catch(() => null)) || []; }

// ── Proposals ──────────────────────────────────────────────────────
// What the critic sees: the misses, not the successes. Forwarded and
// low-confidence turns with their text; corrected turns with what was
// recorded and what a person changed it to; the coaching verdicts; each
// person's busiest hours.
export function proposalInput(m) {
  const T = m._turns || [];
  const short = (t) => ({ who: m._staffByNum?.[t.wa_num]?.name || t.wa_num, kind: t.kind, text: (t.text || '').slice(0, 160), layer: t.layer, intent: t.intent, confidence: t.confidence, outcome: t.outcome, target: t.target_type ? `${t.target_type}#${t.target_id}` : null, corrected: t.correction ? t.correction.change : null });
  return {
    forwarded: T.filter(t => t.outcome === 'forwarded' && t.text).slice(-40).map(short),
    low_confidence: T.filter(t => t.layer === 'classifier' && t.confidence === 'low' && t.outcome !== 'forwarded').slice(-20).map(short),
    corrected: T.filter(t => t.corrected_at).slice(-20).map(short),
    coaching: m.coaching.people.filter(p => p.verdict !== 'worked').slice(0, 20),
    hours: m.people.map(p => ({ name: p.name, wa_num: p.wa_num, said: p.said, busiest_hours: p.busiest_hours })),
    tips: TIPS,
  };
}

export async function proposeStaff(env, m, { extras = {} } = {}) {
  const input = proposalInput(m);
  const nothing = !input.forwarded.length && !input.low_confidence.length && !input.corrected.length && !input.coaching.length;
  if (nothing || !env.ANTHROPIC_KEY) return { proposals: [], cost_usd: 0, summary: nothing ? 'Nothing missed this week.' : 'No model key.' };
  const prompt =
`You review one week of a housekeeping team's WhatsApp messages to Maya, an assistant that turns what they say into records (visits done, photos, faults, schedule changes). Maya understands them through, in order: button taps, replies to her own questions, fixed word rules (ack, done, all-fine, greeting, schedule words, availability, restock), and a small Indonesian intent classifier. Whatever none of those place is forwarded to a person.

Below are this week's MISSES. Propose changes that would have placed them, as JSON only.

Current extra words already approved (do not repeat): ${JSON.stringify(extras.lang || {})}
Current coaching tips (Indonesian): ${JSON.stringify(input.tips)}

FORWARDED (nothing understood them):
${JSON.stringify(input.forwarded, null, 0)}

LOW CONFIDENCE (classifier unsure, still acted on):
${JSON.stringify(input.low_confidence, null, 0)}

CORRECTED BY A PERSON (Maya recorded it, someone changed the record; "corrected" shows the change):
${JSON.stringify(input.corrected, null, 0)}

COACHING (a tip was sent; "persisted" = the pattern came back twice or more after the tip; "once_more" = came back once; "not_told" = pattern seen, tip not yet sent):
${JSON.stringify(input.coaching, null, 0)}

REPLY HOURS (Bali time, when each person actually writes):
${JSON.stringify(input.hours, null, 0)}

Proposal types:
- "vocab": a word or short phrase to add to one rule list ("ack" | "done" | "all_fine" | "avail" | "restock" | "schedule"). Only for whole-message forms a housekeeper wrote that the list clearly should match (e.g. "udah beres", "kelar semua"). Never a word that could also carry a report.
- "example": a message + the intent it should have had ("done" | "move" | "cannot" | "off" | "finding" | "restock" | "schedule" | "question" | "work_note" | "other"), to teach the classifier. Use the corrected and low-confidence cases. Include the villa words as written.
- "coaching": for a "persisted" pattern, verdict "escalate" with a one-line English note for Era to raise in person; for a pattern where the person's next message shows confusion, verdict "reword" with a new Indonesian tip (two sentences at most, warm, no blame).
- "timing": a person whose messages cluster late (busiest hour >= 18) so the 16:00 photo reminder lands before they work: propose "nudge_hour" (17-20).

Be strict: a clean week yields few or no proposals. Each needs the evidence quote. At most ${MAX_PROPOSALS}.

{"summary": "<two sentences, English, what the week's misses have in common>",
 "proposals": [
   {"type": "vocab", "list": "done", "word": "udah beres", "evidence": "<quote>", "why": "<one line>"},
   {"type": "example", "text": "<message>", "intent": "finding", "evidence": "<quote>", "why": "<one line>"},
   {"type": "coaching", "person": "<name>", "wa_num": "<digits>", "key": "<tip key>", "verdict": "escalate"|"reword", "note": "<English line for Era>", "text": "<new Indonesian tip when reword>", "evidence": "<quote>"},
   {"type": "timing", "person": "<name>", "wa_num": "<digits>", "nudge_hour": 18, "evidence": "<hours>", "why": "<one line>"}
 ]}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return { proposals: [], cost_usd: 0, summary: `model ${r.status}` };
    const d = await r.json();
    const cost = ((d.usage?.input_tokens || 0) * RATES.in + (d.usage?.output_tokens || 0) * RATES.out) / 1e6;
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const mm = text.match(/\{[\s\S]*\}/);
    const out = mm ? JSON.parse(mm[0]) : {};
    const LISTS = new Set(['ack', 'done', 'all_fine', 'avail', 'restock', 'schedule']);
    const INTENTS = new Set(['done', 'move', 'cannot', 'off', 'finding', 'restock', 'schedule', 'question', 'work_note', 'other']);
    const proposals = (Array.isArray(out.proposals) ? out.proposals : []).slice(0, MAX_PROPOSALS).map(p => {
      const base = { id: shortId('s'), type: p.type, evidence: String(p.evidence || '').slice(0, 200), why: String(p.why || p.note || '').slice(0, 200) };
      if (p.type === 'vocab' && LISTS.has(p.list) && p.word) return { ...base, list: p.list, word: String(p.word).trim().toLowerCase().slice(0, 40) };
      if (p.type === 'example' && INTENTS.has(p.intent) && p.text) return { ...base, text: String(p.text).slice(0, 200), intent: p.intent };
      if (p.type === 'coaching' && (p.verdict === 'escalate' || p.verdict === 'reword') && p.key) return { ...base, person: String(p.person || ''), wa_num: digits(p.wa_num), key: String(p.key), verdict: p.verdict, note: String(p.note || '').slice(0, 300), text: p.verdict === 'reword' ? String(p.text || '').slice(0, 400) : null };
      if (p.type === 'timing' && Number.isInteger(+p.nudge_hour) && +p.nudge_hour >= 12 && +p.nudge_hour <= 21) return { ...base, person: String(p.person || ''), wa_num: digits(p.wa_num), nudge_hour: +p.nudge_hour };
      return null;
    }).filter(Boolean);
    return { proposals, cost_usd: +cost.toFixed(4), summary: String(out.summary || '').slice(0, 400) };
  } catch (e) { return { proposals: [], cost_usd: 0, summary: `proposal failed: ${e.message}` }; }
}

// ── Staging and applying ───────────────────────────────────────────
export async function stageStaffReview(env, { days = 7, preview = false, propose = true } = {}) {
  const db = { SUPABASE_URL: env.SUPABASE_URL, sbHeaders: env.headers || env.sbHeaders };
  const m = await staffWeekMetrics(db, { days });
  const extras = { lang: (await getSettingValue(db, 'staff_lang_extra').catch(() => null)) || {} };
  const p = propose ? await proposeStaff(env, m, { extras }) : { proposals: [], cost_usd: 0, summary: '' };
  if (!preview) await logStaffWeek(db, m);
  const { _turns, _staffByNum, ...metrics } = m;
  return { metrics, proposals: p.proposals, summary: p.summary, cost_usd: p.cost_usd, generated_at: nowIso() };
}

// Only approved proposals change anything; each becomes a setting the
// runtime reads. Returns what was written and the lines Era should hear.
export async function applyStaffDecisions(db, staged, { approve = [], edits = {} } = {}) {
  const ids = new Set(approve);
  // An edit replaces the proposal's main text: the word, the example, the
  // reworded tip or the note for Era.
  const picked = (staged?.proposals || []).filter(p => ids.has(p.id)).map(p => {
    const e = edits && typeof edits[p.id] === 'string' && edits[p.id].trim() ? edits[p.id].trim() : null;
    if (!e) return p;
    if (p.type === 'vocab') return { ...p, word: e.toLowerCase().slice(0, 40) };
    if (p.type === 'example') return { ...p, text: e.slice(0, 200) };
    if (p.type === 'coaching') return p.verdict === 'reword' ? { ...p, text: e.slice(0, 400) } : { ...p, note: e.slice(0, 300) };
    return p;
  });
  const out = { vocab: 0, examples: 0, coaching: 0, timing: 0, era_lines: [] };
  if (!picked.length) return out;
  const lang = (await getSettingValue(db, 'staff_lang_extra').catch(() => null)) || {};
  const examples = (await getSettingValue(db, 'staff_classifier_examples').catch(() => null)) || [];
  const overrides = (await getSettingValue(db, 'staff_coaching_overrides').catch(() => null)) || {};
  const profiles = (await getSettingValue(db, 'staff_profiles').catch(() => null)) || {};
  for (const p of picked) {
    if (p.type === 'vocab') { lang[p.list] = [...new Set([...(lang[p.list] || []), p.word])].slice(0, 40); out.vocab++; }
    else if (p.type === 'example') { if (!examples.some(e => e.text === p.text)) examples.push({ text: p.text, intent: p.intent, added_at: nowIso() }); out.examples++; }
    else if (p.type === 'coaching') {
      if (p.verdict === 'reword' && p.text) overrides[p.key] = p.text;
      if (p.verdict === 'escalate') out.era_lines.push(`${p.person || p.wa_num}: ${p.note || `the "${p.key}" habit came back after Maya's tip; a word from you would help.`}`);
      out.coaching++;
    } else if (p.type === 'timing' && p.wa_num) { profiles[p.wa_num] = { ...(profiles[p.wa_num] || {}), nudge_hour: p.nudge_hour, set_at: nowIso() }; out.timing++; }
  }
  if (out.vocab) await saveSettingValue(db, 'staff_lang_extra', lang);
  if (out.examples) await saveSettingValue(db, 'staff_classifier_examples', examples.slice(-30));
  if (out.coaching) await saveSettingValue(db, 'staff_coaching_overrides', overrides);
  if (out.timing) await saveSettingValue(db, 'staff_profiles', profiles);
  return out;
}

// What the runtime currently has approved, for the console.
export async function staffLearned(db) {
  const [lang, examples, overrides, profiles] = await Promise.all([
    getSettingValue(db, 'staff_lang_extra').catch(() => null), getSettingValue(db, 'staff_classifier_examples').catch(() => null),
    getSettingValue(db, 'staff_coaching_overrides').catch(() => null), getSettingValue(db, 'staff_profiles').catch(() => null),
  ]);
  return { lang: lang || {}, examples: examples || [], overrides: overrides || {}, profiles: profiles || {} };
}
