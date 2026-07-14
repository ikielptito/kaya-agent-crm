// Maya's weekly self-improvement loop.
//
// Once a week (Sunday, from the 9am-WITA cron in api/cron-followups.js) Maya
// reviews her own agent-facing replies from the past 7 days, grades them against
// her persona rules + the live knowledge base, and distils recurring problems
// into two things:
//   1. Proposed "lessons" — concrete DO/DON'T rules that, once YOU approve them,
//      get injected into her live reply prompt (settings.maya_playbook).
//   2. Open questions — cases where she couldn't tell if she was right because
//      the answer isn't in the KB. Your answers become durable facts she quotes.
//
// The review is AUTOMATIC; applying a lesson is one-tap approval in chat.html.
// Nothing here edits Maya's behaviour without Ikiel's sign-off (applyDecisions).
//
// Storage (settings jsonb, no schema change):
//   settings.maya_playbook        — approved lessons + facts, injected into systemHead
//   settings.maya_review_pending  — the latest staged review awaiting decisions
//   settings.maya_review_log      — capped history of applied reviews (metrics trend)

import { MAYA_PERSONA } from './kb.js';

const MODEL = 'claude-sonnet-4-6';
// Sonnet pricing (per-token, USD) — mirrors costOfUsage in cron-followups.js.
function costOfUsage(u) {
  if (!u) return 0;
  const i = (u.input_tokens || 0) / 1e6 * 3;
  const o = (u.output_tokens || 0) / 1e6 * 15;
  const cr = (u.cache_read_input_tokens || 0) / 1e6 * 0.30;
  const cw = (u.cache_creation_input_tokens || 0) / 1e6 * 3.75;
  return i + o + cr + cw;
}

// How much to feed the critic — bounded so one weekly call stays affordable.
const MAX_THREADS = 45;        // most-recently-active threads with a Maya reply
const MAX_MSGS_PER_THREAD = 14; // last N messages of each thread
const MSG_CHARS = 260;          // truncate each message body
const MAX_LESSONS = 8;          // proposals per review
const MAX_QUESTIONS = 6;
const PLAYBOOK_LESSON_CAP = 40; // consolidate when the approved list grows past this
const LOG_CAP = 16;

function witaDate(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
}
function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, MSG_CHARS);
}

// ── Settings helpers ─────────────────────────────────────────────────────────
async function getSetting(env, key, fallback = null) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value`, { headers: env.headers });
    const row = (await r.json())?.[0];
    return row && row.value != null ? row.value : fallback;
  } catch { return fallback; }
}
async function setSetting(env, key, value) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST',
    headers: { ...env.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}
async function chargeSpend(env, costUsd) {
  if (!costUsd) return;
  try {
    const usage = (await getSetting(env, 'daily_usage', {})) || {};
    const day = witaDate(0);
    usage[day] = +(((usage[day] || 0) + costUsd)).toFixed(6);
    await setSetting(env, 'daily_usage', usage);
  } catch { /* non-fatal */ }
}

const EMPTY_PLAYBOOK = { version: 0, updated_at: null, lessons: [], facts: [] };
export async function getPlaybook(env) {
  const pb = await getSetting(env, 'maya_playbook', null);
  if (!pb || typeof pb !== 'object') return { ...EMPTY_PLAYBOOK };
  return { version: pb.version || 0, updated_at: pb.updated_at || null,
    lessons: Array.isArray(pb.lessons) ? pb.lessons : [],
    facts: Array.isArray(pb.facts) ? pb.facts : [] };
}

// Render the approved playbook as a prompt block for systemHead. Byte-stable
// until a lesson/fact is added or removed, so it stays inside the prompt cache.
export function renderPlaybookBlock(pb) {
  if (!pb || (!pb.lessons?.length && !pb.facts?.length)) return '';
  const parts = [];
  if (pb.lessons?.length) {
    parts.push('LEARNED PLAYBOOK (lessons from reviewing your past conversations — follow these; they override nothing in HARD LIMITS but refine your judgement):');
    pb.lessons.forEach((l, i) => parts.push(`${i + 1}. ${l.rule}`));
  }
  if (pb.facts?.length) {
    parts.push('\nCONFIRMED FACTS (answered by Ikiel — quote these confidently, they are ground truth):');
    pb.facts.forEach((f) => parts.push(`- Q: ${f.q}\n  A: ${f.a}`));
  }
  return parts.join('\n');
}

// Convenience for the webhook: fetch + render in one call.
export async function loadPlaybookBlock(supabaseUrl, headers) {
  const pb = await getPlaybook({ SUPABASE_URL: supabaseUrl, headers });
  return renderPlaybookBlock(pb);
}

// ── Gather the week's agent-facing conversations ─────────────────────────────
// Only threads that contain at least one OUTBOUND Maya reply in the window are
// worth grading (scope = agent-facing replies). We pull inbound+outbound, group
// by agent, keep the most-recently-active MAX_THREADS, and truncate each.
async function gatherWeek(env, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = (path) => fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: env.headers }).then(r => r.json()).catch(() => []);

  const [agents, msgs] = await Promise.all([
    q('agents?select=id,name,agency,is_test'),
    // Maya's own replies are source api/webhook/cron; skip broadcasts & digests
    // (category-tagged) so we grade conversation, not campaigns.
    q(`wa_messages?timestamp=gte.${since}&select=agent_id,direction,content,source,category,template_name,timestamp&order=timestamp.asc&limit=4000`),
  ]);

  const A = Array.isArray(agents) ? agents : [];
  const nameOf = {}; const isTest = {};
  A.forEach(a => { nameOf[a.id] = a.name || a.agency || `#${a.id}`; isTest[a.id] = !!a.is_test; });

  const M = Array.isArray(msgs) ? msgs : [];
  // A Maya conversational reply = outbound, no campaign category (alerts, digests,
  // intros, broadcasts, owner briefings are campaign sends, not replies).
  const isCampaign = (m) => m.category && !['reply', 'followup', 'draft'].includes(m.category);
  const byAgent = new Map();
  for (const m of M) {
    if (!m.agent_id || isTest[m.agent_id]) continue;
    if (!byAgent.has(m.agent_id)) byAgent.set(m.agent_id, { msgs: [], mayaReplies: 0, lastTs: 0, inbound: 0 });
    const t = byAgent.get(m.agent_id);
    const conversational = m.direction === 'inbound' || (m.direction === 'outbound' && !isCampaign(m));
    if (!conversational) continue;
    t.msgs.push(m);
    t.lastTs = Math.max(t.lastTs, new Date(m.timestamp).getTime());
    if (m.direction === 'inbound') t.inbound++;
    if (m.direction === 'outbound') t.mayaReplies++;
  }

  const threads = [...byAgent.entries()]
    .filter(([, t]) => t.mayaReplies > 0 && t.inbound > 0) // needs a real exchange to grade
    .sort((a, b) => b[1].lastTs - a[1].lastTs)
    .slice(0, MAX_THREADS)
    .map(([id, t]) => {
      const tail = t.msgs.slice(-MAX_MSGS_PER_THREAD);
      const lines = tail.map(m => `${m.direction === 'inbound' ? 'AGENT' : 'MAYA'}: ${clean(m.content)}`);
      return { agent_id: id, agent: nameOf[id], replies: t.mayaReplies, transcript: lines.join('\n') };
    });

  const totalReplies = threads.reduce((n, t) => n + t.replies, 0);
  return { threads, thread_count: threads.length, reply_count: totalReplies, since };
}

// ── The critic call ──────────────────────────────────────────────────────────
async function critique(env, { threads, kbContext, playbook }) {
  const existing = (playbook.lessons || []).map((l, i) => `${i + 1}. ${l.rule}`).join('\n') || '(none yet)';
  const transcripts = threads.map((t, i) =>
    `── THREAD ${i + 1} · ${t.agent} ──\n${t.transcript}`).join('\n\n');

  const system = `You are a meticulous QA reviewer auditing "Maya", an AI listings coordinator who answers property-agent messages on WhatsApp for KAYA Developments and Samba Realty in Bali. Your job: grade Maya's replies from the past week and produce concrete, evidence-backed improvements.

You are given (1) Maya's operating rules (persona), (2) the live knowledge base she is supposed to quote from, (3) her current LEARNED PLAYBOOK of already-known lessons, and (4) transcripts of the week's conversations (AGENT = inbound, MAYA = her reply).

GRADE EACH MAYA REPLY against these failure modes:
- ACCURACY: a price / availability / commission / spec / location that CONTRADICTS the knowledge base, or a confident claim about something not in the KB (physical condition, dates, legal). Cross-check every number against the KB.
- ESCALATION: Maya answered something she was required to escalate (negotiation, discounts, holds/reservations, complaints, legal, "speak to Ikiel", visit confirmation), OR escalated something trivial she should have handled.
- VOICE: emojis (banned), em dashes, over-long messages (>6 sentences), multiple questions in one message, "guaranteed" language.
- LEAK: exposed backend/internal implementation ("in my database", "no photo key", "network issue on my end").
- LANE: mixed Samba rentals and KAYA sales in one reply, or pitched the wrong lane for how the agent arrived.
- ETIQUETTE: re-introduced herself mid-conversation, dumped the full portfolio on an auto-reply, kept following up after silence, ignored a question the agent actually asked.
- UNANSWERED: the agent asked a clear question Maya left unaddressed or deflected without reason.

Then DISTIL — do not list every instance. Find RECURRING patterns and turn each into ONE concrete lesson: a short imperative rule Maya can follow next time ("When an agent X, do Y, not Z"). Skip anything already covered by the current playbook. Each lesson needs a real quote as evidence.

Where you CANNOT tell if Maya was right because the ground truth isn't in the KB (a factual question about a property Maya deflected, an agent claim you can't verify), raise it as a QUESTION for Ikiel instead of a lesson. Questions should be answerable in one line and, once answered, would prevent a future miss.

Be strict but fair. A clean week should yield few or zero lessons — do not invent problems. Prioritise ACCURACY and ESCALATION misses (highest business risk) over minor voice nits.

Respond with ONLY a JSON object (no markdown):
{
  "scoreboard": {
    "grade": "A" | "B" | "C" | "D" | "F",
    "issues_found": <int>,
    "by_category": { "accuracy": <int>, "escalation": <int>, "voice": <int>, "leak": <int>, "lane": <int>, "etiquette": <int>, "unanswered": <int> },
    "headline": "<one sentence: the single most important takeaway this week>"
  },
  "lessons": [
    { "category": "accuracy|escalation|voice|leak|lane|etiquette|unanswered",
      "severity": "high|med|low",
      "rule": "<concrete imperative rule for Maya, <=240 chars>",
      "evidence": "<short real quote showing the problem>",
      "rationale": "<why this is wrong / the correct behaviour, <=200 chars>" }
  ],
  "questions": [
    { "question": "<one-line question whose answer fills a knowledge gap>",
      "context": "<what Maya faced / why it matters>",
      "agent": "<agent name from the transcript>" }
  ]
}
At most ${MAX_LESSONS} lessons and ${MAX_QUESTIONS} questions, ranked most-important first. Empty arrays are fine.`;

  const user = `MAYA'S OPERATING RULES (persona):
${MAYA_PERSONA}

LIVE KNOWLEDGE BASE (source of truth for all facts):
${kbContext}

MAYA'S CURRENT LEARNED PLAYBOOK (do not re-propose these):
${existing}

THIS WEEK'S CONVERSATIONS (${threads.length} threads):
${transcripts}

Produce the review JSON now.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, messages: [{ role: 'user', content: user }] }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || `Claude HTTP ${res.status}`);
  await chargeSpend(env, costOfUsage(d.usage));

  let parsed;
  try {
    const txt = (d.content?.[0]?.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(txt);
  } catch (e) {
    throw new Error('critic returned unparseable JSON: ' + e.message);
  }
  return parsed;
}

// ── Public: run the weekly review and STAGE it for Ikiel's approval ──────────
// Does NOT change Maya's behaviour. Writes settings.maya_review_pending.
// `preview` returns the review without staging (test hook).
export async function runReview(env, { days = 7, kbContext = '', preview = false } = {}) {
  const gathered = await gatherWeek(env, days);
  if (gathered.thread_count === 0) {
    const empty = { week_of: witaDate(0), generated_at: new Date().toISOString(),
      thread_count: 0, reply_count: 0,
      scoreboard: { grade: 'N/A', issues_found: 0, headline: 'No agent conversations to review this week.' },
      lessons: [], questions: [], decided: false };
    if (!preview) await setSetting(env, 'maya_review_pending', empty);
    return empty;
  }

  const playbook = await getPlaybook(env);
  const critic = await critique(env, { threads: gathered.threads, kbContext, playbook });

  // Stamp ids so the console can approve/reject/answer individual items.
  const lessons = (critic.lessons || []).slice(0, MAX_LESSONS).map(l => ({
    id: shortId('l'), category: l.category || 'etiquette', severity: l.severity || 'med',
    rule: clean(l.rule), evidence: clean(l.evidence), rationale: clean(l.rationale),
  })).filter(l => l.rule);
  const questions = (critic.questions || []).slice(0, MAX_QUESTIONS).map(qn => ({
    id: shortId('q'), question: clean(qn.question), context: clean(qn.context), agent: qn.agent || '',
  })).filter(qn => qn.question);

  const staged = {
    week_of: witaDate(0),
    generated_at: new Date().toISOString(),
    thread_count: gathered.thread_count,
    reply_count: gathered.reply_count,
    scoreboard: critic.scoreboard || { grade: '?', issues_found: lessons.length, headline: '' },
    lessons, questions, decided: false,
  };
  if (!preview) await setSetting(env, 'maya_review_pending', staged);
  return staged;
}

// ── Public: apply Ikiel's decisions (the ONLY thing that changes Maya) ───────
// approve: [lessonId], reject: [lessonId], answers: { questionId: "answer text" }.
// Approved lessons merge into maya_playbook.lessons; answered questions become
// maya_playbook.facts. Logs the outcome and consolidates if the list is large.
export async function applyDecisions(env, { approve = [], reject = [], answers = {} } = {}) {
  const pending = await getSetting(env, 'maya_review_pending', null);
  if (!pending) return { error: 'no pending review to apply' };

  const playbook = await getPlaybook(env);
  const approveSet = new Set(approve);
  const nowIso = new Date().toISOString();

  const approvedLessons = (pending.lessons || []).filter(l => approveSet.has(l.id));
  for (const l of approvedLessons) {
    playbook.lessons.push({ id: l.id, category: l.category, rule: l.rule, evidence: l.evidence, added_at: nowIso });
  }

  const answeredFacts = [];
  for (const qn of (pending.questions || [])) {
    const a = answers[qn.id];
    if (a && String(a).trim()) {
      const fact = { id: shortId('f'), q: qn.question, a: String(a).trim(), added_at: nowIso };
      playbook.facts.push(fact);
      answeredFacts.push(fact);
    }
  }

  // Consolidate lessons if the list has grown past the cap (dedupe/merge).
  let consolidated = false;
  if (playbook.lessons.length > PLAYBOOK_LESSON_CAP && env.ANTHROPIC_KEY) {
    try {
      playbook.lessons = await consolidateLessons(env, playbook.lessons);
      consolidated = true;
    } catch (e) { console.warn('playbook consolidation skipped:', e.message); }
  }

  playbook.version = (playbook.version || 0) + 1;
  playbook.updated_at = nowIso;
  await setSetting(env, 'maya_playbook', playbook);

  // Append to the metrics log (capped).
  const log = (await getSetting(env, 'maya_review_log', [])) || [];
  log.unshift({
    week_of: pending.week_of, applied_at: nowIso,
    grade: pending.scoreboard?.grade, issues_found: pending.scoreboard?.issues_found,
    approved: approvedLessons.length, rejected: (reject || []).length,
    answered: answeredFacts.length, playbook_size: playbook.lessons.length,
  });
  await setSetting(env, 'maya_review_log', log.slice(0, LOG_CAP));

  // Mark the pending review decided (keep for reference; the console hides it).
  pending.decided = true; pending.decided_at = nowIso;
  await setSetting(env, 'maya_review_pending', pending);

  return {
    ok: true, approved: approvedLessons.length, answered: answeredFacts.length,
    playbook_version: playbook.version, playbook_lessons: playbook.lessons.length,
    playbook_facts: playbook.facts.length, consolidated,
  };
}

// Merge/dedupe an over-cap lesson list into <= PLAYBOOK_LESSON_CAP concise rules.
async function consolidateLessons(env, lessons) {
  const list = lessons.map((l, i) => `${i + 1}. [${l.category}] ${l.rule}`).join('\n');
  const system = `You maintain Maya's LEARNED PLAYBOOK — a list of behavioural rules for an AI listings coordinator. The list has grown too long and has overlaps. Merge near-duplicates, combine related rules, drop anything now redundant, and keep the wording tight and imperative. Preserve every distinct behaviour — do not lose a rule's intent. Return AT MOST ${PLAYBOOK_LESSON_CAP} rules.
Respond with ONLY a JSON array: [{ "category": "...", "rule": "..." }]`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: list }] }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || `Claude HTTP ${res.status}`);
  await chargeSpend(env, costOfUsage(d.usage));
  const txt = (d.content?.[0]?.text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const merged = JSON.parse(txt);
  const nowIso = new Date().toISOString();
  return merged.slice(0, PLAYBOOK_LESSON_CAP).map(m => ({
    id: shortId('l'), category: m.category || 'etiquette', rule: clean(m.rule),
    evidence: '(consolidated)', added_at: nowIso,
  })).filter(l => l.rule);
}
