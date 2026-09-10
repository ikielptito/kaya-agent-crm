// One door for everything a housekeeper sends.
//
// Before 8 Sep 2026 a housekeeper's message ran down a chain of twelve
// handlers, each deciding from its own private state whether the message
// was "for it": a readiness check claimed every message for 24 hours, an
// inspection round claimed anything for two days, and the cleaning
// handler took whatever was left and closed her oldest task. She was
// answering a message; the code was answering a state.
//
// This module decides meaning in three layers, in order, and stops at the
// first that is sure:
//
//   1. THE REFERENCE. A tap on a template button and a reply that quotes a
//      message both carry the id of the message being answered. That id is
//      looked up in staff_asks (every question Maya sends is recorded with
//      its id) and the answer goes to THAT task, round or check — never to
//      the oldest one. Without the table, the quoted message's text is
//      read the old way.
//   2. THE WORDS, deterministically. A greeting is a greeting. "Siap" and
//      "ok" acknowledge and change nothing. "Sudah selesai" on its own
//      closes exactly one thing, and when two things could be meant she
//      is asked which with buttons. A photo goes where a photo can only
//      go (see routePhoto). A weekly pattern goes to the schedule parser.
//   3. THE CLASSIFIER, once. Anything else goes to one model call that
//      sees her open visits, her open round, her open check and the
//      questions Maya has asked her, and returns an intent and a target.
//      An intent the model is unsure about is not applied: the message is
//      forwarded to Era with a short reply, which is the floor.
//
// Every handler below is the existing one, called with the target pinned.

import { staffByWa } from './staff.js';
import { isAck, isDone, isAllFine, isGreeting, isQuestion, isAvail, isRestock, isScheduleWord, realText, loadStaffLangExtras } from './staff-lang.js';
import { askForWamid, openAsks, answerAsk, recordAsk, closeAsksFor } from './asks.js';
import { sendText, sendButtons, sendList, parseTap } from './wa-interactive.js';
import { hkEvent } from './events.js';
import * as photos from './photos.js';
import { coach } from './coaching.js';
import { trace } from './staff-turns.js';

const nowIso = () => new Date().toISOString();
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const MODEL = process.env.MAINTENANCE_LLM_MODEL || 'claude-haiku-4-5-20251001';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function logOut(db, { waNum, content, mid, category = 'housekeeping' }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: String(waNum).replace(/\D/g, ''), direction: 'outbound', content, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'webhook', category, status: mid ? 'sent' : 'failed' }),
  }).catch(() => {});
}
async function say(db, wa, to, body, { buttons = null, list = null, category = 'housekeeping' } = {}) {
  const mid = buttons ? await sendButtons(wa, to, body, buttons) : list ? await sendList(wa, to, list) : await sendText(wa, to, body);
  await logOut(db, { waNum: to, content: body, mid, category });
  return mid;
}
async function villaNames(db) {
  try { return await (await import('./housekeeping.js')).catalogNames(db); } catch { return {}; }
}
const ERA = () => String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
async function tellEra(db, wa, line) {
  const era = ERA(); if (!era) return;
  const mid = await sendText(wa, era, line).catch(() => null);
  await logOut(db, { waNum: era, content: line, mid, category: 'housekeeping' });
}

// ── What is open for this person ────────────────────────────────────
export async function openWork(db, person, { today = witaToday() } = {}) {
  const from = plusDays(today, -2), to = plusDays(today, 2);
  const tasks = (await sbGet(db,
    `housekeeping_tasks?assigned_staff_id=eq.${person.id}&task_date=gte.${from}&task_date=lte.${to}&status=in.(notified,confirmed)&select=*&order=task_date.asc&limit=20`)) || [];
  const cleans = tasks.filter(t => t.kind !== 'inspection');
  const yesterday = plusDays(today, -1);
  const round = tasks.find(t => t.kind === 'inspection' && t.task_date >= yesterday && t.task_date <= today) || null;
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const checks = (await sbGet(db,
    `housekeeping_readiness?by_staff_id=eq.${person.id}&status=eq.awaiting&asked_at=gte.${encodeURIComponent(since)}&select=*&order=asked_at.desc&limit=3`)) || [];
  // A check is open until the guest is in: after that, the record is closed
  // by the sweep and her late photos are just photos.
  const check = checks.find(c => !c.guest_in_date || c.guest_in_date >= today) || null;
  // Today's and yesterday's visits of any state, for proof photos.
  const recent = (await sbGet(db,
    `housekeeping_tasks?assigned_staff_id=eq.${person.id}&task_date=gte.${yesterday}&task_date=lte.${today}&status=in.(notified,confirmed,done)&select=*&order=task_date.desc&limit=12`)) || [];
  const asks = await openAsks(db, person.wa_num).catch(() => []);
  // Open repair tickets at her villas: the classifier's vocabulary for
  // "that leak has been fixed", so it is never read as a fresh finding.
  let tickets = [];
  try { const { openTicketsFor } = await import('./ticket-guard.js'); tickets = await openTicketsFor(db, { slugs: person.slugs || [] }); } catch { tickets = []; }
  return { tasks, cleans, round, check, recent, asks, tickets, today };
}

// ── Layer 1: the reference ──────────────────────────────────────────
// Returns { kind, ask, task, tasks, check, round } or null.
export async function resolveReference(db, { replyTo, buttonPayload, person, work }) {
  const tap = parseTap(buttonPayload);
  if (tap && ['pa', 'villa', 'hk', 'sched', 'team'].includes(tap.domain)) return { kind: `tap:${tap.domain}`, tap };
  if (!replyTo) return null;
  const ask = await askForWamid(db, replyTo);
  if (ask) {
    const ids = new Set([...(ask.target_ids || []), ask.target_id].filter(Boolean).map(Number));
    if (ask.kind === 'task' || ask.kind === 'chase') {
      const tasks = work.tasks.filter(t => ids.has(t.id));
      return { kind: ask.kind, ask, tasks, task: tasks[0] || null };
    }
    if (ask.kind === 'inspection') {
      const task = work.tasks.find(t => ids.has(t.id)) || null;
      return { kind: 'inspection', ask, round: task, task };
    }
    if (ask.kind === 'week' || ask.kind === 'proof' || ask.kind === 'backfill') {
      const tasks = work.tasks.filter(t => ids.has(t.id));
      return { kind: ask.kind, ask, tasks, task: tasks[0] || null };
    }
    if (ask.kind === 'readiness') {
      const check = ids.size ? (await sbGet(db, `housekeeping_readiness?id=in.(${[...ids].join(',')})&status=eq.awaiting&select=*&limit=1`))?.[0] : work.check;
      return { kind: 'readiness', ask, check: check || work.check };
    }
    return { kind: ask.kind, ask };
  }
  // No ask row (table missing, or an older message): read the quoted text.
  const quoted = (await sbGet(db, `wa_messages?wa_message_id=eq.${encodeURIComponent(replyTo)}&select=content,direction,category&limit=1`))?.[0];
  if (!quoted) return null;
  if (quoted.direction === 'inbound') {
    // She is replying to her own earlier message — usually a photo. The
    // photo handlers read that themselves.
    return { kind: 'own', quoted };
  }
  const c = String(quoted.content || '');
  const names = await villaNames(db);
  const { taskForQuoted } = await import('./housekeeping-intake.js');
  if (/inspection round|pemeriksaan rutin/i.test(c)) {
    const hit = taskForQuoted(c, work.tasks.filter(t => t.kind === 'inspection'), names) || work.round;
    return hit ? { kind: 'inspection', round: hit, task: hit } : null;
  }
  if (/foto serah terima|kirim foto|sebelum tamu datang/i.test(c) && work.check) return { kind: 'readiness', check: work.check };
  const hit = taskForQuoted(c, work.cleans, names);
  if (hit) return { kind: 'task', task: hit, tasks: [hit] };
  if (/evening chase|tadi pagi ada jadwal/i.test(c)) return { kind: 'chase', tasks: work.cleans };
  return null;
}

// ── Layer 3: the classifier ─────────────────────────────────────────
// Approved examples from the weekly review (settings
// staff_classifier_examples), refreshed every ten minutes.
let _examples = { at: 0, list: [] };
async function classifierExamples(db) {
  if (Date.now() - _examples.at < 10 * 60e3) return _examples.list;
  _examples.at = Date.now();
  try { const { getSettingValue } = await import('./campaigns.js'); const v = db ? await getSettingValue(db, 'staff_classifier_examples') : null; _examples.list = Array.isArray(v) ? v.slice(-30) : []; } catch { /* keep */ }
  return _examples.list;
}

export async function classifyStaffText({ apiKey = process.env.ANTHROPIC_API_KEY, body, person, work, names = {}, db = null }) {
  if (!apiKey || !body) return null;
  const today = work.today;
  const examples = await classifierExamples(db);
  const nm = (s) => names[s] || s;
  const lines = [];
  for (const t of work.tasks) lines.push(`  visit ${t.id}: ${nm(t.slug)} — ${t.kind.replace('_', ' ')} on ${t.task_date}${t.status === 'confirmed' ? ' (confirmed)' : ''}`);
  if (work.round) lines.push(`  inspection round open at ${nm(work.round.slug)} (photos expected)`);
  if (work.check) lines.push(`  handover photo check open at ${nm(work.check.slug)}${work.check.guest_in_date ? `, guest arrives ${work.check.guest_in_date}` : ''}`);
  for (const a of (work.asks || []).slice(0, 5)) lines.push(`  Maya asked (${a.kind}) at ${String(a.asked_at).slice(0, 16)}: ${JSON.stringify(a.payload || {}).slice(0, 120)}`);
  for (const t of (work.tickets || []).slice(0, 12)) lines.push(`  repair ticket #${t.id} at ${nm(t.slug || t.group_key)} (${t.status}): ${String(t.title).slice(0, 70)}`);
  const villas = (person.slugs || []).map(s => `${s} = ${nm(s)}`).join('; ');
  const prompt =
`Today is ${today} (Bali). ${person.name} is a housekeeper who covers: ${villas || 'unknown villas'}.
Open for her right now:
${lines.join('\n') || '  nothing'}

She wrote (Indonesian, sometimes English): """${String(body).slice(0, 800)}"""

Classify the message. Reply with ONLY JSON:
{"intent": "done" | "move" | "cannot" | "off" | "finding" | "ticket_update" | "restock" | "schedule" | "question" | "work_note" | "other",
 "task_id": <the visit id she means, or null>,
 "ticket_id": <the repair ticket number she means, or null>,
 "slug": "<villa slug she names, or null>",
 "date": "<YYYY-MM-DD when she names a day she CAN do it, else null>",
 "summary": "<at most 12 words, English>",
 "confidence": "high" | "low"}

Meanings:
- done: she has finished a visit ("A4 sudah saya bersihkan").
- move: she wants a visit on another day AND names the day ("besok saja", "bisa Kamis?"). Resolve forward from today: besok = ${plusDays(today, 1)}, lusa = ${plusDays(today, 2)}.
- cannot: she cannot do a visit and names no other day.
- off: she is off / sick / unavailable today or on a day she names (no specific visit).
- finding: something at the villa is broken, dirty, missing, leaking, mouldy, needs repair or replacement — a NEW report, not a question, and not about a repair ticket listed above.
- ticket_update: she says one of the repair tickets listed above is finished ("resleting sofa sudah diperbaiki"), or gives news about it (the tukang came, a part is on order, it is still leaking). Fill ticket_id. A fault that already has a ticket is ticket_update, never finding.
- restock: supplies running low (sabun, tisu, galon...).
- schedule: her regular weekly days ("A4 Senin dan Kamis", "jadwal saya Senin dan Jumat").
- question: she asks how something works, what to do, or asks Maya/Era something.
- work_note: describing work she did or is doing, with no request ("sudah saya coba spons magic", "ini foto A5").
- other: greetings, thanks, chit-chat, or unclear.
Pick task_id by the villa she names; when she names none and only one visit is open today, use it. When she names a villa not on her list, still fill slug with your best reading. Use "low" confidence whenever the villa or the intent is not clear from her words.${examples.length ? `\n\nMessages from this team and the intent they turned out to have (learned from corrections):\n${examples.map(e => `- "${e.text}" → ${e.intent}`).join('\n')}` : ''}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]) : null;
    if (!out?.intent) return null;
    const ids = new Set(work.tasks.map(t => t.id));
    const task_id = Number.isInteger(+out.task_id) && ids.has(+out.task_id) ? +out.task_id : null;
    const tids = new Set((work.tickets || []).map(t => t.id));
    const ticket_id = Number.isInteger(+out.ticket_id) && tids.has(+out.ticket_id) ? +out.ticket_id : null;
    let date = /^\d{4}-\d{2}-\d{2}$/.test(String(out.date || '')) ? out.date : null;
    if (date && (date < today || date > plusDays(today, 14))) date = null;
    return { intent: String(out.intent), task_id, ticket_id, slug: out.slug ? String(out.slug) : null, date, summary: out.summary ? String(out.summary).slice(0, 120) : null, confidence: out.confidence === 'low' ? 'low' : 'high' };
  } catch { return null; }
}

// ── "Which one?" ────────────────────────────────────────────────────
// When "sudah selesai" could mean two visits she is asked with buttons,
// and the ask is recorded so her tap comes straight back here.
async function askWhich(db, wa, { person, fromNum, tasks, names, verb = 'done' }) {
  const nm = (s) => names[s] || s;
  await coach(db, wa, { person, fromNum, key: 'which_villa' }).catch(() => {});
  const rows = tasks.slice(0, 9).map(t => ({ id: `hk:${verb}:${t.id}`, title: `${nm(t.slug)}`.slice(0, 24), description: `${KIND_ID_SHORT[t.kind] || t.kind} · ${t.task_date}` }));
  const body = verb === 'done' ? 'Yang mana yang sudah selesai? Pilih satu (bisa pilih lagi untuk yang lain).' : 'Yang mana yang dimaksud?';
  let mid;
  if (rows.length <= 3) mid = await say(db, wa, fromNum, body, { buttons: rows.map(r => ({ id: r.id, title: r.title.slice(0, 20) })) });
  else mid = await say(db, wa, fromNum, body, { list: { body, buttonLabel: 'Pilih villa', rows } });
  await recordAsk(db, { waNum: fromNum, staffId: person.id, kind: 'which', targetType: 'housekeeping_task', targetIds: tasks.map(t => t.id), wamid: mid, payload: { verb }, expiresInHours: 12 });
  return true;
}
const KIND_ID_SHORT = { regular: 'bersih-bersih rutin', turnover: 'turnover', pre_arrival: 'persiapan tamu', deep_clean: 'deep clean', inspection: 'pemeriksaan', during_stay: 'bersih-bersih', vacant_upkeep: 'bersih-bersih' };

// ── Photos ──────────────────────────────────────────────────────────
// Where a photo can go, in the only order that makes sense: the check she
// was just asked for, the round she is walking, a fault she describes, and
// otherwise proof of the visit she has today — which used to have no home
// at all, so Ana's routine-clean photos became an inspection record and
// then a maintenance ticket (7 Sep 2026).
export async function routePhoto(ctx, { ref, work, body }) {
  const { db, wa, person, fromNum, mediaType, mediaId, waToken, waMessageId, replyTo, staffSlugs } = ctx;
  const { handleReadiness } = await import('./housekeeping-readiness.js');
  const { handleInspection, attachProofPhoto } = await import('./housekeeping-intake.js');
  const { looksLikeMaintenance } = await import('./maintenance-intake.js');
  const { handleStaffMaintenance } = await import('./maintenance-staff.js');

  if (ref?.kind === 'readiness' && ref.check) {
    if (await handleReadiness({ ...ctx, text: body, pinned: ref.check })) return 'housekeeping';
  }
  if (ref?.kind === 'inspection' && ref.round) {
    if (await handleInspection({ ...ctx, text: body, pinned: ref.round, buttonPayload: null })) return 'housekeeping';
  }
  if (work.check && await handleReadiness({ ...ctx, text: body, pinned: work.check })) return 'housekeeping';
  if (work.round && await handleInspection({ ...ctx, text: body, pinned: work.round, buttonPayload: null })) return 'housekeeping';
  // A caption that reports a fault is a ticket, with the photo as evidence.
  if (body && looksLikeMaintenance(body, false)) {
    if (await handleStaffMaintenance({ ...ctx, text: body, staffSlugs: staffSlugs || person.slugs || [] })) return 'maintenance_staff';
  }
  // Proof of today's (or yesterday's) visit.
  const visit = pickVisitForProof(work, body, person);
  if (visit) {
    const ok = await attachProofPhoto({ db, wa, fromNum, person, task: visit, mediaId, waToken, waMessageId, caption: body });
    if (ok) return 'housekeeping';
  }
  // Nothing of hers is open: a report with the villa to be named, and a
  // tip so the next photo carries its villa and its fault in the caption.
  if (await handleStaffMaintenance({ ...ctx, text: body, staffSlugs: staffSlugs || person.slugs || [], force: !!body })) {
    if (!body) await coach(db, wa, { person, fromNum, key: 'photo_no_context' });
    return 'maintenance_staff';
  }
  return null;
}
function pickVisitForProof(work, caption, person) {
  const list = work.recent || [];
  if (!list.length) return null;
  // The visit Maya just asked photos for.
  const proofAsk = (work.asks || []).find(a => a.kind === 'proof');
  if (proofAsk) { const t = list.find(x => (proofAsk.target_ids || []).includes(x.id) || x.id === proofAsk.target_id); if (t) return t; }
  if (caption) {
    try {
      const { resolveUnits } = require_resolve();
      const hits = resolveUnits(caption, person.slugs || []);
      const named = list.find(t => hits.includes(t.slug));
      if (named) return named;
    } catch { /* fall through */ }
  }
  const today = work.today;
  const todays = list.filter(t => t.task_date === today);
  if (todays.length === 1) return todays[0];
  if (todays.length > 1) return todays.find(t => t.status !== 'done') || todays[0];
  return list[0];
}
let _resolve = null;
function require_resolve() { if (!_resolve) throw new Error('not loaded'); return _resolve; }

// ── The door ────────────────────────────────────────────────────────
// Returns the category to log the inbound under, or null when nothing
// claimed it (the webhook then logs it as 'staff' and forwards it).
export async function dispatchStaffMessage(ctx) {
  const { db, wa, person, fromNum, text, mediaType, mediaId, waMessageId, replyTo, buttonPayload, apiKey } = ctx;
  if (!_resolve) { try { _resolve = await import('./housekeeping-schedule.js'); } catch { /* optional */ } }
  const body = realText(text);
  const hasImage = mediaType === 'image' && !!mediaId;
  await loadStaffLangExtras(db).catch(() => {});
  const names = await villaNames(db);
  const work = await openWork(db, person);
  const ref = await resolveReference(db, { replyTo, buttonPayload, person, work }).catch(() => null);
  trace(ctx, { ref_kind: ref?.kind || null, layer: ref ? (ref.kind.startsWith('tap:') ? 'tap' : 'reference') : null });
  const intake = await import('./housekeeping-intake.js');
  const readiness = await import('./housekeeping-readiness.js');
  const schedule = await import('./housekeeping-schedule.js');

  // ── Taps with our own ids ─────────────────────────────────────────
  if (ref?.kind === 'tap:hk') {
    trace(ctx, { layer: 'tap', intent: `hk:${ref.tap.verb}`, target_type: 'housekeeping_task', target_id: Number(ref.tap.id) || null });
    const t = work.tasks.find(x => String(x.id) === String(ref.tap.id)) || (await sbGet(db, `housekeeping_tasks?id=eq.${Number(ref.tap.id)}&select=*&limit=1`))?.[0];
    if (!t) { await say(db, wa, fromNum, 'Tugas itu sudah tidak terbuka.'); return 'housekeeping'; }
    const nm = (s) => names[s] || s;
    if (ref.tap.verb === 'done') {
      if (t.kind === 'inspection') await intake.handleInspection({ ...ctx, text: 'selesai', pinned: t, buttonPayload: null, mode: 'close' });
      else if (t.task_date < work.today) {
        // A late "sudah": done, recorded as reported later — no photo check
        // is opened for a guest who has already arrived.
        await intake.closeTaskLate(db, { task: t, person, wamid: waMessageId });
        await say(db, wa, fromNum, `Terima kasih, ${nm(t.slug)} ${intake.dayLabelId(t.task_date)} sudah dicatat selesai 🙏`);
      } else await intake.handleCleaningReply({ ...ctx, text: '', pinned: t, preParsed: { intent: 'done', task_id: t.id } });
    } else if (ref.tap.verb === 'notdone') {
      await intake.markNotDone(db, { task: t, person, wamid: waMessageId });
      await say(db, wa, fromNum, `Baik, ${nm(t.slug)} ${intake.dayLabelId(t.task_date)} dicatat tidak dikerjakan. Terima kasih sudah jujur 🙏`);
      await tellEra(db, wa, `${person.name} says the ${t.kind.replace('_', ' ')} at ${nm(t.slug)} on ${t.task_date} was NOT done.`);
    } else if (ref.tap.verb === 'unsure') {
      await intake.noteOnTask(db, t, `${person.name}: tidak ingat (asked ${work.today})`);
      await say(db, wa, fromNum, 'Baik, tidak apa-apa 🙏 Lain kali tekan "Sudah selesai" di hari itu ya, supaya tercatat.');
    } else if (ref.tap.verb === 'move') {
      await intake.handleCleaningReply({ ...ctx, text: '', pinned: t, preParsed: { intent: 'move', task_id: t.id, date: ref.tap.date || plusDays(work.today, 1) } });
    } else if (ref.tap.verb === 'cannot') {
      await intake.handleCleaningReply({ ...ctx, text: '', pinned: t, preParsed: { intent: 'cannot', task_id: t.id } });
    }
    await closeAsksFor(db, 'housekeeping_task', t.id, { tap: ref.tap.verb });
    return 'housekeeping';
  }
  if (ref?.kind === 'tap:sched') {
    if (await schedule.handleSchedulePick({ db, wa, fromNum, person, tap: ref.tap })) return 'housekeeping_schedule';
  }
  if (ref?.kind === 'tap:villa') {
    const { handleStaffMaintenance } = await import('./maintenance-staff.js');
    if (await handleStaffMaintenance({ ...ctx, text: body, staffSlugs: person.slugs || [] })) return 'maintenance_staff';
  }

  // ── Template quick replies (the three buttons) ────────────────────
  const BUTTON_INTENT = { 'sudah selesai': 'done', 'besok saja': 'tomorrow', 'tidak bisa': 'cannot' };
  const tapped = BUTTON_INTENT[String(buttonPayload || '').trim().toLowerCase()] || null;
  if (tapped) {
    trace(ctx, { layer: 'button', intent: tapped });
    const targets = ref?.tasks?.length ? ref.tasks : (ref?.task ? [ref.task] : null);
    if (ref?.kind === 'inspection' && ref.round && tapped === 'done') {
      await intake.handleInspection({ ...ctx, text: 'selesai', pinned: ref.round, buttonPayload: null, mode: 'close' });
      if (ref.ask) await answerAsk(db, ref.ask.id, { tap: tapped }, { wamid: waMessageId });
      return 'housekeeping';
    }
    if (targets?.length > 1 && tapped === 'done') {
      // The chase names two villas; one tap is one villa. Ask which.
      const open = targets.filter(t => ['notified', 'confirmed'].includes(t.status));
      if (open.length > 1) { await askWhich(db, wa, { person, fromNum, tasks: open, names }); return 'housekeeping'; }
      if (open.length === 1) targets.splice(0, targets.length, open[0]);
    }
    // A visit's message can carry a clean and a round: the tap answers the
    // clean; the round stays open for its photos, and she is told so.
    const cleanTargets = (targets || []).filter(t => t.kind !== 'inspection');
    const roundOnVisit = (targets || []).find(t => t.kind === 'inspection' && ['notified', 'confirmed'].includes(t.status)) || null;
    const pinned = cleanTargets[0] || targets?.[0] || null;
    if (!pinned && work.cleans.length > 1 && tapped === 'done') { await askWhich(db, wa, { person, fromNum, tasks: work.cleans, names }); return 'housekeeping'; }
    if (await intake.handleCleaningReply({ ...ctx, text: '', buttonPayload, pinned, tapOnly: true })) {
      if (ref?.ask) await answerAsk(db, ref.ask.id, { tap: tapped }, { wamid: waMessageId });
      if (tapped === 'done' && roundOnVisit) await say(db, wa, fromNum, `Untuk pemeriksaan rutin di ${names[roundOnVisit.slug] || roundOnVisit.slug}: kirim fotonya ke sini, lalu balas "selesai" (atau "semua bagus") 🙏`);
      if (tapped !== 'done' && roundOnVisit) {
        // Besok saja / Tidak bisa apply to the round as well.
        await intake.handleInspection({ ...ctx, text: tapped === 'tomorrow' ? 'besok saja' : 'tidak bisa', pinned: roundOnVisit, buttonPayload: null, mode: 'avail', date: tapped === 'tomorrow' ? plusDays(work.today, 1) : null });
      }
      return 'housekeeping';
    }
    if (!work.cleans.length) { await say(db, wa, fromNum, 'Tidak ada tugas yang terbuka untuk tombol itu. Kalau ada yang mau disampaikan, tulis saja ya 🙏'); return 'housekeeping'; }
  }

  // ── A reply to a specific ask ─────────────────────────────────────
  if (ref?.kind === 'readiness' && ref.check) {
    trace(ctx, { target_type: 'housekeeping_readiness', target_id: ref.check.id });
    if (hasImage || isDone(body) || isRestock(body)) {
      if (await readiness.handleReadiness({ ...ctx, text: body, pinned: ref.check })) { if (ref.ask) await answerAsk(db, ref.ask.id, { text: body.slice(0, 200) }, { wamid: waMessageId }); return 'housekeeping'; }
    }
    if (isAck(body)) return 'staff_ack';
    // Anything else said to the check is kept on it and Era hears it.
    if (body && !isQuestion(body)) { await readiness.noteOnCheck(db, ref.check, body); await say(db, wa, fromNum, 'Dicatat 🙏 Kirim fotonya juga ya, lalu balas "selesai".'); return 'housekeeping'; }
  }
  if (ref?.kind === 'inspection' && ref.round) {
    trace(ctx, { target_type: 'housekeeping_task', target_id: ref.round.id });
    if (isAck(body) && !hasImage) return 'staff_ack';
    const mode = hasImage ? 'photo' : (isDone(body) || isAllFine(body)) ? 'close' : isAvail(body) ? 'avail' : isQuestion(body) ? null : 'finding';
    if (mode && await intake.handleInspection({ ...ctx, text: body, pinned: ref.round, buttonPayload: null, mode })) {
      if (ref.ask && mode !== 'photo') await answerAsk(db, ref.ask.id, { mode, text: body.slice(0, 200) }, { wamid: waMessageId });
      return 'housekeeping';
    }
  }
  if ((ref?.kind === 'task' || ref?.kind === 'chase') && !hasImage && body) {
    if (isAck(body)) { await coach(db, wa, { person, fromNum, key: 'ack_not_button' }); return 'staff_ack'; }
    const targets = ref.tasks?.length ? ref.tasks : [ref.task].filter(Boolean);
    if (isDone(body)) {
      const open = targets.filter(t => ['notified', 'confirmed'].includes(t.status));
      if (open.length > 1) { await askWhich(db, wa, { person, fromNum, tasks: open, names }); return 'housekeeping'; }
      if (await intake.handleCleaningReply({ ...ctx, text: body, pinned: open[0] || targets[0], preParsed: { intent: 'done', task_id: (open[0] || targets[0])?.id } })) { if (ref.ask) await answerAsk(db, ref.ask.id, { text: body.slice(0, 200) }, { wamid: waMessageId }); return 'housekeeping'; }
    }
    if (await intake.handleCleaningReply({ ...ctx, text: body, pinned: targets[0], pinnedTasks: targets })) { if (ref.ask) await answerAsk(db, ref.ask.id, { text: body.slice(0, 200) }, { wamid: waMessageId }); return 'housekeeping'; }
  }
  if (ref?.kind === 'which' && ref.ask && !hasImage && body) {
    // She typed instead of tapping: try the villa name.
    const targets = work.tasks.filter(t => (ref.ask.target_ids || []).includes(t.id));
    const hit = _resolve ? targets.filter(t => _resolve.resolveUnits(body, [t.slug]).length) : [];
    if (hit.length === 1 && await intake.handleCleaningReply({ ...ctx, text: body, pinned: hit[0], preParsed: { intent: ref.ask.payload?.verb === 'done' ? 'done' : 'note', task_id: hit[0].id } })) { await answerAsk(db, ref.ask.id, { text: body }, { wamid: waMessageId }); return 'housekeeping'; }
  }

  // ── The week as a plan ────────────────────────────────────────────
  // An "ok" to the Monday list (quoted, or within a day and a half of it)
  // confirms every visit on it. Anything else said to it is a change and
  // goes to the schedule reader like any other text.
  const weekAsk = ref?.kind === 'week' ? ref.ask : (work.asks || []).find(a => a.kind === 'week');
  if (weekAsk && !hasImage && body && isAck(body)) {
    trace(ctx, { layer: 'reference', ref_kind: 'week', intent: 'plan_confirmed' });
    const ids = (weekAsk.target_ids || []).map(Number);
    for (const id of ids) {
      await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_tasks?id=eq.${id}&status=eq.planned`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify({ confirmed_at: nowIso(), updated_at: nowIso() }) }).catch(() => {});
      await hkEvent(db, id, 'plan_confirmed', { actor: person.name, wamid: waMessageId });
    }
    await answerAsk(db, weekAsk.id, { confirmed: ids.length }, { wamid: waMessageId });
    await say(db, wa, fromNum, `Siap, jadwal minggu ini dikonfirmasi 🙏 Kalau ada yang berubah, tulis saja kapan pun.`);
    return 'housekeeping';
  }

  // ── Layer 2: the words ────────────────────────────────────────────
  if (!hasImage) {
    if (!body) return null;
    // "Halo Maya, saya Putu": a self-introduction gets the welcome and the
    // summary, never "belum saya paham".
    try { const { handleSelfIntro } = await import('./staff-onboarding.js'); if (await handleSelfIntro({ db, wa, fromNum, text: body, person })) { trace(ctx, { layer: 'rule', intent: 'self_intro' }); return 'staff_onboard'; } } catch { /* optional */ }
    if (isGreeting(body)) { trace(ctx, { layer: 'rule', intent: 'greeting' }); if (await schedule.handleGreeting({ db, wa, fromNum, text: body })) return 'housekeeping'; }
    if (isAck(body)) {
      trace(ctx, { layer: 'rule', intent: 'ack' });
      // An "ok" with a visit still open today, within an hour of its
      // message, is probably meant as "done": the button is the record.
      const fresh = work.cleans.find(t => t.task_date === work.today && t.notified_at && Date.now() - Date.parse(t.notified_at) < 3600e3);
      if (fresh) await coach(db, wa, { person, fromNum, key: 'ack_not_button' });
      return 'staff_ack';
    }
  }
  if (hasImage) {
    if (!ctx.trace?.layer || ctx.trace.layer === 'reference') trace(ctx, { layer: 'photo' });
    const cat = await routePhoto(ctx, { ref, work, body });
    return cat;
  }

  // "Resleting sofa A4 sudah diperbaiki": completion about a fault, not a
  // visit. Resolved against the open tickets at her villas by the guard —
  // a note on the ticket and Era's buttons — and never a new ticket. Falls
  // through when nothing open matches (10 Sep 2026).
  if (!isDone(body) && !isAllFine(body)) {
    try {
      const { handleStaffCompletion } = await import('./ticket-guard.js');
      if (await handleStaffCompletion({ db, wa, fromNum, person, body, apiKey })) { trace(ctx, { layer: 'rule', intent: 'ticket_update' }); return 'maintenance_staff'; }
    } catch (e) { console.warn('staff completion guard failed:', e.message); }
  }

  if (isDone(body) || isAllFine(body)) {
    trace(ctx, { layer: 'rule', intent: isDone(body) ? 'done' : 'all_fine' });
    if (work.check) { if (await readiness.handleReadiness({ ...ctx, text: body, pinned: work.check })) return 'housekeeping'; }
    const opts = [...work.cleans.filter(t => t.task_date <= work.today), ...(work.round ? [work.round] : [])];
    if (opts.length === 1) {
      const t = opts[0];
      if (t.kind === 'inspection') await intake.handleInspection({ ...ctx, text: body, pinned: t, buttonPayload: null, mode: 'close' });
      else await intake.handleCleaningReply({ ...ctx, text: body, pinned: t, preParsed: { intent: 'done', task_id: t.id } });
      return 'housekeeping';
    }
    if (opts.length > 1) { await askWhich(db, wa, { person, fromNum, tasks: opts, names }); return 'housekeeping'; }
    if (work.cleans.length === 1) { await intake.handleCleaningReply({ ...ctx, text: body, pinned: work.cleans[0], preParsed: { intent: 'done', task_id: work.cleans[0].id } }); return 'housekeeping'; }
    await say(db, wa, fromNum, 'Terima kasih 🙏 Tidak ada tugas hari ini yang masih terbuka atas nama Anda; sudah saya catat pesannya.');
    return 'housekeeping';
  }

  // A weekly pattern, only when it says so or names a villa with a day.
  if (isScheduleWord(body) || (schedule.looksLikeSchedule(body) && _resolve && _resolve.resolveUnits(body, person.slugs || []).length)) {
    trace(ctx, { layer: 'rule', intent: 'schedule' });
    if (await schedule.handleScheduleStatement({ db, wa, fromNum, text: body, waMessageId, person })) return 'housekeeping_schedule';
  }

  // ── Layer 3: the classifier ───────────────────────────────────────
  const cls = await classifyStaffText({ apiKey, body, person, work, names, db }).catch(() => null);
  trace(ctx, { layer: 'classifier', intent: cls?.intent || null, confidence: cls ? cls.confidence : 'none', detail: { ...(ctx.trace?.detail || {}), summary: cls?.summary || null, cls_task: cls?.task_id || null, cls_slug: cls?.slug || null } });
  const { handleStaffMaintenance } = await import('./maintenance-staff.js');
  const { handleStaffQuestion } = await import('./staff-help.js');
  if (cls && cls.confidence === 'high') {
    const target = cls.task_id ? work.tasks.find(t => t.id === cls.task_id) : null;
    if (cls.intent === 'done' && target) { await intake.handleCleaningReply({ ...ctx, text: body, pinned: target, preParsed: { intent: 'done', task_id: target.id } }); return 'housekeeping'; }
    if (cls.intent === 'move' && cls.date) {
      const t = target || (work.cleans.length === 1 ? work.cleans[0] : null) || (work.round && !work.cleans.length ? work.round : null);
      if (t?.kind === 'inspection') { await intake.handleInspection({ ...ctx, text: body, pinned: t, buttonPayload: null, mode: 'avail', date: cls.date }); return 'housekeeping'; }
      if (t) { await intake.handleCleaningReply({ ...ctx, text: body, pinned: t, preParsed: { intent: 'move', task_id: t.id, date: cls.date } }); return 'housekeeping'; }
      if (work.cleans.length > 1) { await askWhich(db, wa, { person, fromNum, tasks: work.cleans, names, verb: 'move' }); return 'housekeeping'; }
    }
    if (cls.intent === 'cannot') {
      const t = target || (work.cleans.length === 1 ? work.cleans[0] : null);
      if (t) { await intake.handleCleaningReply({ ...ctx, text: body, pinned: t, preParsed: { intent: 'cannot', task_id: t.id } }); return 'housekeeping'; }
    }
    if (cls.intent === 'off') {
      // A day off moves everything she has that day, once, and Era hears.
      const date = cls.date || plusDays(work.today, 1);
      const todays = work.tasks.filter(t => t.task_date === work.today);
      if (todays.length) {
        for (const t of todays) await intake.moveTaskById(db, { task: t, date, person, body });
        const nm = (s) => names[s] || s;
        await say(db, wa, fromNum, `Baik, selamat istirahat 🙏 ${todays.map(t => nm(t.slug)).join(', ')} saya pindah ke ${intake.dayLabelId(date)}. Saya ingatkan lagi hari itu.`);
        await tellEra(db, wa, `${person.name} is off today: "${body.slice(0, 120)}". Moved ${todays.map(t => `${nm(t.slug)} ${t.kind.replace('_', ' ')}`).join(', ')} to ${date}.`);
        return 'housekeeping';
      }
      await say(db, wa, fromNum, 'Baik, sudah saya catat 🙏');
      await tellEra(db, wa, `${person.name}: "${body.slice(0, 160)}"`);
      return 'housekeeping';
    }
    if (cls.intent === 'ticket_update') {
      // News about a ticket that exists: a note on it and Era's buttons,
      // through the guard, whatever the words. Never a new ticket.
      const { guardTicketCreate } = await import('./ticket-guard.js');
      const t = (cls.ticket_id && work.tickets.find(x => x.id === cls.ticket_id)) || null;
      const matched = t
        ? { group_key: t.group_key, slug: t.slug, unit_label: t.unit_label, group: { name: t.statement_groups?.name } }
        : (cls.slug && work.tickets.find(x => x.slug === cls.slug)) ? (({ group_key, slug, unit_label, statement_groups }) => ({ group_key, slug, unit_label, group: { name: statement_groups?.name } }))(work.tickets.find(x => x.slug === cls.slug)) : null;
      if (matched) { await guardTicketCreate({ db, wa, fromNum, who: person.name, lang: 'id', body, matched, apiKey }); return 'maintenance_staff'; }
    }
    if (cls.intent === 'finding') {
      // Inside her round and about that villa: a finding on the round.
      // Naming another villa: a plain report, filed at the villa named.
      const namesOther = cls.slug && work.round && cls.slug !== work.round.slug;
      if (work.round && !namesOther) { if (await intake.handleInspection({ ...ctx, text: body, pinned: work.round, buttonPayload: null, mode: 'finding' })) return 'housekeeping'; }
      if (await handleStaffMaintenance({ ...ctx, text: body, staffSlugs: person.slugs || [], force: true })) return 'maintenance_staff';
    }
    if (cls.intent === 'restock') {
      if (work.check) { if (await readiness.handleReadiness({ ...ctx, text: body, pinned: work.check, asRestock: true })) return 'housekeeping'; }
      await say(db, wa, fromNum, 'Dicatat, saya sampaikan ke Era 🙏');
      await tellEra(db, wa, `Restock — ${person.name}${cls.slug ? ` (${names[cls.slug] || cls.slug})` : ''}: "${body.slice(0, 200)}"`);
      return 'housekeeping';
    }
    if (cls.intent === 'schedule') { if (await schedule.handleScheduleStatement({ db, wa, fromNum, text: body, waMessageId, person })) return 'housekeeping_schedule'; }
    if (cls.intent === 'question') { if (await handleStaffQuestion({ db, wa, fromNum, text: body })) return 'staff_help'; }
    if (cls.intent === 'work_note') {
      const t = target || work.recent.find(x => x.task_date === work.today) || null;
      if (t) { await intake.noteOnTask(db, t, `${person.name}: ${body.slice(0, 300)}`); }
      await say(db, wa, fromNum, 'Terima kasih, sudah saya catat 🙏');
      return 'housekeeping';
    }
  }
  // Low confidence, or an intent with nothing to land on: a question is
  // still worth answering; a report by vocabulary ("bocor", "pecah",
  // "rusak") is still filed, at the villa she is at or the one she names;
  // the rest goes to a person.
  if (isQuestion(body) || cls?.intent === 'question') { if (await handleStaffQuestion({ db, wa, fromNum, text: body })) return 'staff_help'; }
  if (cls?.intent === 'finding' || cls?.intent === 'restock' || cls?.intent === 'work_note') {
    const { looksLikeMaintenance } = await import('./maintenance-intake.js');
    if (looksLikeMaintenance(body, false)) {
      trace(ctx, { layer: 'vocab' });
      if (work.round && await intake.handleInspection({ ...ctx, text: body, pinned: work.round, buttonPayload: null, mode: 'finding' })) return 'housekeeping';
      if (await handleStaffMaintenance({ ...ctx, text: body, staffSlugs: person.slugs || [] })) return 'maintenance_staff';
    }
  }
  trace(ctx, { layer: ctx.trace?.layer === 'classifier' ? 'classifier' : 'none', outcome: 'forwarded' });
  return null;
}

// The floor: nothing claimed it. She hears that a person will read it, once
// per half hour so a burst does not get five apologies; Era gets the text.
export async function forwardUnmatched({ db, wa, person, fromNum, text }) {
  const body = realText(text) || String(text || '');
  const key = `staff_fwd:${fromNum}`;
  const { getSettingValue, saveSettingValue } = await import('./campaigns.js');
  const last = (await getSettingValue(db, key).catch(() => null)) || {};
  const quiet = last.at && Date.now() - Date.parse(last.at) < 30 * 60e3;
  if (!quiet) {
    await say(db, wa, fromNum, 'Maaf, yang ini belum saya paham 🙏 Saya teruskan ke Era ya.');
    await saveSettingValue(db, key, { at: nowIso() }).catch(() => {});
  }
  await tellEra(db, wa, `${person.name} wrote something I could not place: "${body.slice(0, 300)}"`);
  try { const { postToTelegram } = await import('./telegram.js'); await postToTelegram(`🧹 <b>${person.name}</b> (unplaced): ${body.slice(0, 300)}`); } catch { /* optional */ }
}
