// The inspection round, as it actually arrives: a housekeeper's photos.
//
// Every fortnight Maya asks each housekeeper to walk her villa and photograph
// the bathroom, the ceiling, the wall behind the aircon, the kitchen and the
// pool. What comes back is a burst of images and a sentence or two.
//
// Two things are made of that:
//
//   AN INSPECTION RECORD, kept even when nothing is wrong. "We looked and it
//   is fine" is the point — it is what the owner sees on their weekly report,
//   and it is the difference between a cleaning bill and visible care.
//
//   A MAINTENANCE ITEM, but only when she actually reports a problem. Mould
//   on a ceiling becomes a normal work order and inherits everything that
//   already exists: an estimate, the owner's approval, a tukang dispatched
//   to fix it. The inspection keeps the link so the report can show that the
//   thing found on the 3rd was repaired by the 9th.
//
// Like every other staff handler this one CLAIMS or FALLS THROUGH. It only
// claims a message when the person has an inspection round open today, so a
// housekeeper's ordinary chat is never swallowed.

import { uploadPhoto, createItem, matchProperty, appendThread, attachPhotoPaths } from './maintenance.js';
import { fetchMediaBase64 } from './maintenance-staff.js';
import { looksLikeMaintenance, extractReports } from './maintenance-intake.js';
import { staffByWa } from './staff.js';
import { rememberPhoto, photoForWamid } from './photo-assign.js';
import { isDone as isDoneWord, isAck, isQuestion, isAvail, isAllFine, realText as realTextShared } from './staff-lang.js';
import { recordAsk, closeAsksFor } from './asks.js';
import { hkEvent } from './events.js';
import * as photoStore from './photos.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) });
}
// Every reply is also written to wa_messages. Until 7 Sep 2026 these sends
// were invisible: Era's staff console and any thread dump showed a
// housekeeper asking and Maya silent, when Maya had in fact answered — and
// the corrections the housekeepers then typed made no sense to anyone.
let _logDb = null;
export function bindLog(db) { _logDb = db; }
async function sendText(wa, to, body, category = 'housekeeping') {
  if (!wa?.phoneId || !wa?.token) return null;
  const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  const d = r.ok ? await r.json().catch(() => ({})) : {};
  const mid = d.messages?.[0]?.id || null;
  if (_logDb) await logOutbound(_logDb, { waNum: to, content: body, mid, category, status: r.ok ? 'sent' : 'failed' });
  return r.ok ? (mid || true) : null;
}
export async function logOutbound(db, { waNum, content, mid = null, category = 'housekeeping', status = 'sent' }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: String(waNum).replace(/\D/g, ''), direction: 'outbound', content, wa_message_id: mid,
      timestamp: nowIso(), source: 'webhook', category, status,
    }),
  }).catch(() => {});
}

// One record per villa per day. The unique constraint means a burst of eight
// photos across eight lambdas produces one inspection, not eight.
async function openInspection(db, { slug, taskId, staffId }) {
  const on = witaToday();
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_inspections?on_conflict=slug,inspected_on`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ slug, inspected_on: on, task_id: taskId ?? null, by_staff_id: staffId ?? null }),
  });
  const rows = r.ok ? await r.json().catch(() => []) : [];
  if (rows?.[0]) return rows[0];
  // Lost the race: read the row the other lambda wrote.
  return (await sbGet(db, `housekeeping_inspections?slug=eq.${encodeURIComponent(slug)}&inspected_on=eq.${on}&select=*&limit=1`))?.[0] || null;
}

// Appending to a jsonb array from parallel lambdas can lose a photo if two
// read the same "before" value. Re-reading immediately before the write keeps
// the window to milliseconds, and a lost photo out of eight is survivable in
// a way that a lost work order is not.
// Ana sent ten photos on 7 Sep 2026 and six survived, so the write is now
// read back and repeated until the path is really there.
async function attachInspectionPhoto(db, inspectionId, path) {
  let n = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = (await sbGet(db, `housekeeping_inspections?id=eq.${inspectionId}&select=photos&limit=1`))?.[0];
    const have = row?.photos || [];
    if (have.includes(path)) return have.length;
    const photos = [...have, path];
    await sbPatch(db, `housekeeping_inspections?id=eq.${inspectionId}`, { photos });
    n = photos.length;
    await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 200)));
    const after = (await sbGet(db, `housekeeping_inspections?id=eq.${inspectionId}&select=photos&limit=1`))?.[0];
    if ((after?.photos || []).includes(path)) return (after.photos || []).length;
  }
  return n;
}

// ── Her reply to a cleaning task ────────────────────────────────────
// "sudah" closes it. "tidak bisa hari ini, besok bisa" moves it. Cleaners
// juggle their own lives and ask to shift a day; before this the only way to
// honour that was for Era to hear it and edit the schedule herself, which
// meant it usually just did not happen and the task sat there marked as sent.
//
// Moving writes task_date only. origin_date stays put, so the generator still
// recognises the task as the one its rule produced and does not helpfully
// recreate the original day.
// A quick-reply tap arrives as the button's own text, so the three labels on
// samba_hk_task_v2 map straight onto the three intents. Which TASK it answers
// still comes from the open-task lookup below, exactly as the free-text path
// works — the tap says what, the schedule says which.
const BUTTON_INTENT = {
  'sudah selesai': 'done',
  'besok saja': 'tomorrow',
  'tidak bisa': 'cannot',
};

// Which task a tap answers. The morning template names one villa, and the
// tap comes back quoting that message, so the villa is read off the message
// she tapped rather than guessed as "her oldest open task" — which on 7 Sep
// 2026 marked Ita's A4 clean done by closing the B4 inspection instead.
// The evening chase names several villas in one message; there the tap
// still closes the oldest, as its text tells her.
export function taskForQuoted(content, tasks, names = {}) {
  const c = String(content || '').toLowerCase();
  if (!c) return null;
  const hits = (tasks || []).filter(t => {
    const nm = String(names[t.slug] || '').toLowerCase();
    return nm && c.includes(nm);
  });
  const slugs = new Set(hits.map(t => t.slug));
  return slugs.size === 1 ? hits[0] : null;
}

// What her last move did, so a correction can put it back.
export function revertPlanFor(task) {
  const last = [...(task?.thread || [])].reverse().find(e => e && e.from_date);
  if (!last) return null;
  return {
    task_date: last.from_date,
    status: last.prev_status && last.prev_status !== 'planned' ? last.prev_status : (last.prev_notified_at ? 'notified' : 'planned'),
    notified_at: last.prev_notified_at || null,
  };
}

async function openTasksFor(db, person, { today, kinds = 'neq.inspection' } = {}) {
  const from = plusDays(today, -2);
  return (await sbGet(db,
    `housekeeping_tasks?assigned_staff_id=eq.${person.id}&kind=${kinds}`
    + `&task_date=gte.${from}&task_date=lte.${plusDays(today, 2)}&status=in.(notified,confirmed)`
    + `&select=*&order=task_date.asc&limit=12`)) || [];
}

async function moveTask(db, { task, date, person, body, status = 'planned' }) {
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    task_date: date, status, notified_at: status === 'planned' ? null : task.notified_at,
    moved_by: person.name, moved_at: nowIso(), updated_at: nowIso(),
    thread: [...(task.thread || []), {
      at: nowIso(), who: person.name, text: body || 'Tapped "Besok saja"',
      from_date: task.task_date, to_date: date, prev_status: task.status, prev_notified_at: task.notified_at,
    }].slice(-50),
  });
  await hkEvent(db, task.id, 'moved', { actor: person.name, payload: { from: task.task_date, to: date, said: body || null } });
  await closeAsksFor(db, 'housekeeping_task', task.id, { moved_to: date });
}
// For the dispatcher: a day off moves every visit of the day.
export async function moveTaskById(db, { task, date, person, body }) { return moveTask(db, { task, date, person, body }); }
export async function noteOnTask(db, task, line) {
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    notes: [task.notes, line].filter(Boolean).join(' · ').slice(0, 500), updated_at: nowIso(),
    thread: [...(task.thread || []), { at: nowIso(), who: String(line).split(':')[0], text: line }].slice(-50),
  });
  await hkEvent(db, task.id, 'note', { payload: { text: String(line).slice(0, 300) } });
}

async function closeTask(db, wa, { task, person, fromNum, villa, wamid = null }) {
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    status: 'done', done_at: nowIso(), updated_at: nowIso(),
  });
  await hkEvent(db, task.id, 'done', { actor: person.name, wamid });
  await closeAsksFor(db, 'housekeeping_task', task.id, { done: true });
  // A handover is not finished when she says so; it is finished when the
  // photos say so. Turnovers with a guest behind them, pre-arrivals and
  // deep cleans get the readiness ask instead of a plain thank-you.
  try {
    const { openReadiness } = await import('./housekeeping-readiness.js');
    const ask = await openReadiness(db, { task, person, villa });
    if (ask) {
      const mid = await sendText(wa, fromNum, ask.text || ask);
      await hkEvent(db, task.id, 'readiness_opened', { actor: 'Maya', payload: { readiness_id: ask.id || null } });
      // The check is open until the guest is in, or 20 hours, whichever first.
      const until = task.guest_in_date ? `${task.guest_in_date}T10:00:00.000Z` : new Date(Date.now() + 20 * 3600e3).toISOString();
      await recordAsk(db, { waNum: fromNum, staffId: person.id, kind: 'readiness', targetType: 'housekeeping_readiness', targetId: ask.id || null, wamid: mid, payload: { slug: task.slug, task_id: task.id }, expiresAt: until });
      return;
    }
  } catch { /* the thank-you below still goes out */ }
  // Every other visit: two photos, so "done" is evidenced and not just
  // said. The ask lasts until the evening; photos that arrive land on the
  // visit through the dispatcher's photo routing.
  if ((task.photos || []).length) { await sendText(wa, fromNum, `Terima kasih, ${villa} sudah dicatat selesai.`); return; }
  // An inspection at the same villa today wants photos of its own; asking
  // for two more for the clean is the same trip photographed twice (Ita,
  // B4, 8 Sep 2026). The round's photos are the visit's evidence.
  const roundOpen = (await sbGet(db, `housekeeping_tasks?assigned_staff_id=eq.${person.id}&slug=eq.${encodeURIComponent(task.slug)}&kind=eq.inspection&task_date=eq.${task.task_date}&status=in.(notified,confirmed)&select=id&limit=1`))?.[0];
  if (roundOpen) { await sendText(wa, fromNum, `Terima kasih, ${villa} sudah dicatat selesai. Foto pemeriksaannya kirim ke sini ya 🙏`); return; }
  const { PROOF_SPOTS_ID, PROOF_MIN_PHOTOS } = await import('./glossary.js');
  const mid = await sendText(wa, fromNum, `Terima kasih, ${villa} sudah dicatat selesai. Kirim ${PROOF_MIN_PHOTOS} foto ya (${PROOF_SPOTS_ID}) supaya tercatat 🙏`);
  await recordAsk(db, { waNum: fromNum, staffId: person.id, kind: 'proof', targetType: 'housekeeping_task', targetId: task.id, wamid: mid, payload: { slug: task.slug }, expiresAt: `${task.task_date}T15:00:00.000Z` });
}

// A "sudah" given days later, to Maya's backfill question. The visit is
// done, but the record says it was reported later, not on the day — the
// difference between evidence and recollection (see housekeeping-records).
export async function closeTaskLate(db, { task, person, wamid = null }) {
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    status: 'done', done_at: nowIso(), updated_at: nowIso(),
    notes: [task.notes, `Reported done on ${witaToday()} (asked later)`].filter(Boolean).join(' · ').slice(0, 500),
  });
  await hkEvent(db, task.id, 'done', { actor: person.name, payload: { late: true, asked_on: witaToday() }, wamid });
  await closeAsksFor(db, 'housekeeping_task', task.id, { done: true, late: true });
}
// "Tidak": the visit did not happen. Kept as its own outcome, never as a
// silent skip.
export async function markNotDone(db, { task, person, wamid = null }) {
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    status: 'skipped', updated_at: nowIso(),
    notes: [task.notes, `Not done — ${person.name} said so on ${witaToday()}`].filter(Boolean).join(' · ').slice(0, 500),
  });
  await hkEvent(db, task.id, 'not_done', { actor: person.name, wamid });
  await closeAsksFor(db, 'housekeeping_task', task.id, { not_done: true });
}

// pinned: the task the dispatcher resolved from the message she answered.
// pinnedTasks: the set a chase message named. preParsed: an intent the
// dispatcher already knows (a tap, or the classifier's reading), so no
// second model call is made.
export async function handleCleaningReply({ db, wa, fromNum, text, buttonPayload = null, replyTo = null, tapOnly = false, pinned = null, pinnedTasks = null, preParsed = null, waMessageId = null }) {
  const body = realTextShared(text);
  const tapped = BUTTON_INTENT[String(buttonPayload || '').trim().toLowerCase()] || null;
  if (!body && !tapped && !preParsed) return false;
  if (tapOnly && !tapped) return false;
  if (!tapped && !preParsed && isAck(body)) return false;

  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;

  const today = witaToday();
  let tasks = await openTasksFor(db, person, { today });
  if (pinnedTasks?.length) { const ids = new Set(pinnedTasks.map(t => t.id)); const sub = tasks.filter(t => ids.has(t.id)); if (sub.length) tasks = sub; }
  if (pinned && !tasks.some(t => t.id === pinned.id)) tasks = [pinned, ...tasks];
  if (!tasks.length) return false;
  const names = await (await import('./housekeeping.js')).catalogNames(db).catch(() => ({}));
  const nameOf = (slug) => names[slug] || slug;

  // Which task: the one the dispatcher pinned, else the one named by the
  // message she tapped, else the oldest.
  let open = pinned ? (tasks.find(t => t.id === pinned.id) || pinned) : tasks[0];
  if (!pinned && tapped && replyTo) {
    const quoted = (await sbGet(db, `wa_messages?wa_message_id=eq.${encodeURIComponent(replyTo)}&select=content&limit=1`))?.[0];
    const hit = taskForQuoted(quoted?.content, tasks, names);
    if (hit) open = hit;
  }

  if (tapped === 'done' || preParsed?.intent === 'done' || (!preParsed && isDoneWord(body))) {
    const target = preParsed?.task_id ? (tasks.find(t => t.id === preParsed.task_id) || open) : open;
    await closeTask(db, wa, { task: target, person, fromNum, villa: nameOf(target.slug), wamid: waMessageId });
    return true;
  }

  // A tap carries no prose to parse, so the intent is already known and the
  // model is skipped entirely. "Besok saja" means exactly tomorrow. Free
  // text goes to the model WITH her open tasks, so "A4 sudah saya bersihkan"
  // closes A4 and "bukan A4, tetapi B4" is read as the correction it is.
  let parsed;
  if (preParsed) parsed = { ...preParsed, task_id: preParsed.task_id || open.id };
  else if (tapped === 'tomorrow') parsed = { intent: 'move', date: plusDays(today, 1), task_id: open.id };
  else if (tapped === 'cannot') parsed = { intent: 'cannot', task_id: open.id };
  else {
    const inspections = await openTasksFor(db, person, { today, kinds: 'eq.inspection' });
    const { parseCleaningReply } = await import('./maintenance-intake.js');
    parsed = await parseCleaningReply(body, {
      villa: nameOf(open.slug),
      tasks: [...tasks, ...inspections].map(t => ({ id: t.id, villa: nameOf(t.slug), date: t.task_date, kind: t.kind })),
    });
  }
  const target = [...tasks].find(t => t.id === parsed.task_id) || open;
  const villa = nameOf(target.slug);

  if (parsed.intent === 'correction' && parsed.task_id) {
    // Put back what her previous message moved (within the last quarter
    // hour), then do the same thing to the villa she meant.
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    const moved = (await sbGet(db,
      `housekeeping_tasks?moved_by=eq.${encodeURIComponent(person.name)}&moved_at=gte.${encodeURIComponent(since)}&select=*&order=moved_at.desc&limit=3`)) || [];
    const last = moved[0];
    const plan = last ? revertPlanFor(last) : null;
    const wanted = (await sbGet(db, `housekeeping_tasks?id=eq.${parsed.task_id}&select=*&limit=1`))?.[0];
    if (last && plan && wanted && wanted.id !== last.id) {
      await sbPatch(db, `housekeeping_tasks?id=eq.${last.id}`, {
        ...plan, moved_by: null, moved_at: null, updated_at: nowIso(),
        thread: [...(last.thread || []), { at: nowIso(), who: person.name, text: `Corrected: "${body}"` }].slice(-50),
      });
      const toDate = [...(last.thread || [])].reverse().find(e => e && e.to_date)?.to_date || plusDays(today, 1);
      const wasDone = last.status === 'done';
      if (wasDone) {
        await sbPatch(db, `housekeeping_tasks?id=eq.${wanted.id}`, { status: 'done', done_at: nowIso(), updated_at: nowIso() });
        await sendText(wa, fromNum, `Baik, maaf 🙏 ${nameOf(wanted.slug)} yang dicatat selesai, ${nameOf(last.slug)} dibuka lagi.`);
      } else {
        await moveTask(db, { task: wanted, date: toDate, person, body });
        await sendText(wa, fromNum, `Baik, maaf 🙏 ${nameOf(wanted.slug)} yang dipindah ke ${dayLabelId(toDate)}; ${nameOf(last.slug)} kembali ke ${dayLabelId(plan.task_date)}.`);
      }
      await notifyEra(db, wa, `${person.name} corrected herself: "${body}" — ${nameOf(wanted.slug)} instead of ${nameOf(last.slug)}.`);
      return true;
    }
    // Nothing recent to undo: treat it as a note about the villa she named.
    parsed = { ...parsed, intent: 'note' };
  }

  if (parsed.intent === 'done' && parsed.task_id && target.kind !== 'inspection') {
    await closeTask(db, wa, { task: target, person, fromNum, villa });
    return true;
  }

  if (parsed.intent === 'move' && parsed.date && parsed.date !== target.task_date) {
    await moveTask(db, { task: target, date: parsed.date, person, body });
    await sendText(wa, fromNum, `Baik, ${villa} dipindah ke ${dayLabelId(parsed.date)}. Saya ingatkan lagi nanti.`);
    await notifyEra(db, wa, `${person.name} moved the ${target.kind.replace('_', ' ')} at ${villa} to ${parsed.date}${body ? `: "${body}"` : ' (tapped Besok saja)'}`);
    return true;
  }

  if (parsed.intent === 'cannot') {
    // She cannot do it and named no alternative. Era has to reassign or
    // agree a day, so this is escalated rather than guessed at.
    await sbPatch(db, `housekeeping_tasks?id=eq.${target.id}`, {
      notes: [target.notes, body || 'Tapped "Tidak bisa"'].filter(Boolean).join(' · ').slice(0, 500), updated_at: nowIso(),
    });
    await hkEvent(db, target.id, 'cannot', { actor: person.name, payload: { said: body || null } });
    await closeAsksFor(db, 'housekeeping_task', target.id, { cannot: true });
    await sendText(wa, fromNum, `Baik, saya kabari Era ya. Terima kasih sudah memberi tahu.`);
    await notifyEra(db, wa, `${person.name} cannot do the ${target.kind.replace('_', ' ')} at ${villa}: ${body ? `"${body}"` : 'tapped Tidak bisa'}`);
    return true;
  }

  return false;
}

const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
// The webhook substitutes a bracketed instruction for a captionless image.
// Nothing a housekeeper types starts with "[Agent sent". (Shared rule in
// staff-lang.js; re-exported so older callers keep working.)
export const realText = realTextShared;
export const dayLabelId = (d) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// ── Proof of a visit ────────────────────────────────────────────────
// A photo with nothing else open is her showing the work: it goes on the
// visit itself. Until 8 Sep 2026 these photos had no home and were filed
// as inspection findings or maintenance tickets (Ana, 7 Sep). One thank-you
// per visit, not per photo.
export async function attachProofPhoto({ db, wa, fromNum, person, task, mediaId, waToken, waMessageId = null, caption = '' }) {
  try {
    const media = await fetchMediaBase64(mediaId, waToken);
    if (!media?.base64) return false;
    const path = await uploadPhoto(db, `proof/${task.slug}/${task.task_date}`, { base64: media.base64, contentType: media.mime || 'image/jpeg' });
    let count = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = (await sbGet(db, `housekeeping_tasks?id=eq.${task.id}&select=photos&limit=1`))?.[0];
      const have = row?.photos || [];
      if (have.includes(path)) { count = have.length; break; }
      const photos = [...have, path];
      await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, { photos, updated_at: nowIso() });
      count = photos.length;
      await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 150)));
      const after = (await sbGet(db, `housekeeping_tasks?id=eq.${task.id}&select=photos&limit=1`))?.[0];
      if ((after?.photos || []).includes(path)) { count = after.photos.length; break; }
    }
    await rememberPhoto(db, waMessageId, path).catch(() => {});
    await photoStore.remember(db, { path, wamid: waMessageId, waNum: fromNum, staffId: person.id, caption, source: 'proof', status: 'proof', taskId: task.id });
    await hkEvent(db, task.id, 'photo', { actor: person.name, payload: { path, caption: caption || null }, wamid: waMessageId });
    if (caption) await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, { notes: [task.notes, `${person.name}: ${caption}`].filter(Boolean).join(' · ').slice(0, 500) });
    if (count >= 2) await closeAsksFor(db, 'housekeeping_task', task.id, { proof: count });
    if (count === 1) {
      const villa = await villaName(db, task.slug);
      await sendText(wa, fromNum, `Terima kasih, foto ${villa} sudah masuk 🙏${['notified', 'confirmed'].includes(task.status) ? ' Kalau sudah selesai, tekan "Sudah selesai" di pesan pagi ya.' : ''}`);
    }
    return true;
  } catch { return false; }
}

// Era hears about it as free text. Her window is almost always open — she is
// in Maya's chat all day — and if it is shut this is a nicety, not a work
// order, so a silent failure costs nothing.
async function notifyEra(db, wa, line) {
  const era = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  if (!era) return;
  await sendText(wa, era, line).catch(() => {});
}


// pinned: the round the dispatcher resolved. mode: what the dispatcher
// already knows the message is — 'photo' | 'close' | 'avail' | 'finding' —
// so an acknowledgement or a question is never written as a finding.
export async function handleInspection({ db, wa, fromNum, text, mediaType, mediaId, waToken, waMessageId = null, replyTo = null, buttonPayload = null, pinned = null, mode = null, date: wantedDate = null }) {
  // The buttons belong to cleaning tasks; an inspection is closed by photos
  // and "selesai", never by a tap meant for another villa's clean.
  if (buttonPayload) return false;
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;

  // Is a round actually open for this person right now? Yesterday's round is
  // included because a housekeeper asked at 9am often walks the villa in the
  // afternoon and sends the photos that evening or the next morning.
  const today = witaToday();
  const yesterday = new Date(Date.parse(today) - 86400e3).toISOString().slice(0, 10);
  const open = pinned || (await sbGet(db,
    `housekeeping_tasks?kind=eq.inspection&assigned_staff_id=eq.${person.id}`
    + `&task_date=gte.${yesterday}&task_date=lte.${today}&status=in.(notified,confirmed)`
    + `&select=*&order=task_date.desc&limit=1`))?.[0];
  if (!open) return false;

  const hasImage = mediaType === 'image' && !!mediaId;
  // An image with no caption reaches us with the sales-side placeholder as
  // its text. That is a prompt for Maya, not a finding: recorded once, it
  // went straight onto an owner's weekly report.
  const body = realText(text);

  // "sudah" / "selesai" with no photo closes the round.
  if (mode === 'close' || (!mode && !hasImage && (isDoneWord(body) || isAllFine(body)))) {
    await closeRound(db, wa, { task: open, person, fromNum, findings: isAllFine(body) ? body : '' });
    return true;
  }
  if (!hasImage && !body) return false;
  // Acknowledgements and questions are not findings, whatever is open.
  if (!hasImage && !mode && (isAck(body) || isQuestion(body))) return false;

  // "hari ini saya libur", "besok saja", "tidak bisa": a word about her
  // day, not a finding. Gede's day off went onto the B3 record as a
  // finding and got no answer (6 Sep 2026). The round moves to the day she
  // names, or tomorrow, she is told, and Era hears.
  if (mode === 'avail' || (!mode && !hasImage && isAvail(body) && body.length < 120)) {
    const villa = await villaName(db, open.slug);
    let date = wantedDate || null;
    if (!date) { try { const { parseCleaningReply } = await import('./maintenance-intake.js'); date = (await parseCleaningReply(body, { villa })).date || null; } catch { /* default below */ } }
    if (!date) date = plusDays(today, 1);
    await sbPatch(db, `housekeeping_tasks?id=eq.${open.id}`, {
      task_date: date, status: 'planned', notified_at: null, moved_by: person.name, moved_at: nowIso(), updated_at: nowIso(),
      thread: [...(open.thread || []), { at: nowIso(), who: person.name, text: body, from_date: open.task_date, to_date: date, prev_status: open.status, prev_notified_at: open.notified_at }].slice(-50),
    });
    await hkEvent(db, open.id, 'moved', { actor: person.name, payload: { from: open.task_date, to: date, said: body } });
    await closeAsksFor(db, 'housekeeping_task', open.id, { moved_to: date });
    await sendText(wa, fromNum, `Baik, pemeriksaan ${villa} dipindah ke ${dayLabelId(date)}. Saya ingatkan lagi hari itu. 🙏`);
    await notifyEra(db, wa, `${person.name} moved the inspection at ${villa} to ${date}: "${body}"`);
    return true;
  }

  const insp = await openInspection(db, { slug: open.slug, taskId: open.id, staffId: person.id });
  if (!insp) return false;

  let count = (insp.photos || []).length;
  let lastPath = null;
  if (hasImage) {
    try {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media?.base64) {
        const path = await uploadPhoto(db, `inspection/${open.slug}/${today}`, {
          base64: media.base64, contentType: media.mime || 'image/jpeg',
        });
        count = await attachInspectionPhoto(db, insp.id, path);
        await rememberPhoto(db, waMessageId, path).catch(() => {});
        await photoStore.remember(db, { path, wamid: waMessageId, waNum: fromNum, staffId: person.id, caption: body, source: 'inspection', status: 'attached', inspectionId: insp.id, taskId: open.id });
        await hkEvent(db, open.id, 'photo', { actor: person.name, payload: { path, inspection_id: insp.id }, wamid: waMessageId });
        lastPath = path;
      }
    } catch { /* a failed photo must not lose the round */ }
  }

  // What she writes is recorded as a finding. Whether it ALSO becomes a
  // work order is a separate question, and the two were once tangled
  // together: a fault reported at a Tropicana unit was silently dropped,
  // because those units belong to no statement group, so matchProperty
  // returned null and the finding fell through every branch. Losing a
  // housekeeper's report of mould is the worst thing this module could do,
  // so the write happens first and never depends on the matcher. What is
  // NOT a finding — an acknowledgement, a question, a note about her day —
  // was screened out above (8 Sep 2026: "Ok terima kasih" and "hari ini
  // saya libur" both used to land on the owner's PDF).
  let raised = [];
  const firstText = !!body && !insp.findings;
  if (body) {
    await sbPatch(db, `housekeeping_inspections?id=eq.${insp.id}`, {
      findings: [insp.findings, body].filter(Boolean).join(' · ').slice(0, 1000),
    });
  }

  if (body && looksLikeMaintenance(body, hasImage)) {
    // The villa is known — it is the one the round is at — so the owner
    // group is looked up by slug, never guessed from her words. Two A5
    // findings were filed under A4 on 5 Sep by a text match.
    const groups = (await sbGet(db, `statement_groups?active=is.true&select=key,name,listing_slugs`)) || [];
    const own = groups.find(g => (g.listing_slugs || []).includes(open.slug));
    const matched = own ? { group_key: own.key, group: own, slug: open.slug } : await matchProperty(db, `${open.slug} ${body}`);
    if (matched?.group_key) {
      // The evidence: the photo sent with the words (caption), or the photo
      // her words quote. Anything else is never attached by guesswork.
      const certain = lastPath || (replyTo ? await photoForWamid(db, replyTo).catch(() => null) : null);
      const reports = await extractReports(body, { matched, hasImage });
      for (const rep of reports.slice(0, 3)) {
        const item = await createItem(db, {
          group_key: matched.group_key, slug: open.slug, unit_label: rep.unit_label || null,
          title: rep.title, description: rep.description || body,
          urgency: rep.urgency || 'normal',
          estimated_cost: rep.estimated_cost ?? null,
          reported_by_wa: fromNum, reported_by_name: person.name,
        });
        if (item?.id) {
          raised.push(item.id);
          await appendThread(db, item.id, { who: person.name, text: `Found during the inspection of ${today}` });
          // The photo she sent with the words is the evidence; the ticket
          // should carry it, not only the round.
          if (certain) { await attachPhotoPaths(db, item.id, [certain]).catch(() => {}); await photoStore.place(db, certain, { status: 'attached', itemId: item.id, by: person.name, why: 'sent with the words' }); }
          try { const { maintEvent } = await import('./events.js'); await maintEvent(db, item.id, 'created', { actor: person.name, payload: { source: 'inspection', inspection_id: insp.id, photo: certain || null }, wamid: waMessageId }); } catch { /* optional */ }
        }
      }
      if (raised.length) {
        await sbPatch(db, `housekeeping_inspections?id=eq.${insp.id}`, {
          item_ids: [...(insp.item_ids || []), ...raised],
        });
      }
    }
  }

  // One acknowledgement per burst would be ideal; one per photo is noise. So
  // Maya answers the first photo and the ones that raise an issue, and stays
  // quiet for the rest of the round.
  if (raised.length) {
    const noPhoto = !hasImage && !(replyTo && await photoForWamid(db, replyTo).catch(() => null));
    await sendText(wa, fromNum, `Terima kasih, sudah saya catat sebagai laporan perbaikan.${noPhoto ? ' Supaya fotonya masuk ke laporan yang benar: balas (reply) foto yang dimaksud lalu tulis keterangannya, atau kirim foto dengan keterangan di caption.' : ''} Kalau ada lagi, foto saja.`);
  } else if (count === 1) {
    await sendText(wa, fromNum, `Terima kasih. Fotonya sudah masuk untuk ${await villaName(db, open.slug)}. Kirim saja sisanya, lalu balas "selesai" kalau sudah semua.`);
  } else if (firstText && !hasImage) {
    // Words alone, recorded as a finding, used to get no answer at all —
    // and a housekeeper who hears nothing assumes nothing was read.
    await sendText(wa, fromNum, `Sudah saya catat untuk pemeriksaan ${await villaName(db, open.slug)} 🙏 Kalau ada yang rusak, kirim fotonya ya; kalau sudah semua, balas "selesai".`);
  }
  return true;
}

// Housekeepers know their villas by name, not by slug. Reading back
// "tropicana-b2" at someone is the sort of thing that quietly erodes trust
// in the whole system.
async function villaName(db, slug) {
  try {
    const { catalogNames } = await import('./housekeeping.js');
    return (await catalogNames(db))[slug] || slug;
  } catch { return slug; }
}

async function closeRound(db, wa, { task, person, fromNum, findings }) {
  const on = witaToday();
  const insp = await openInspection(db, { slug: task.slug, taskId: task.id, staffId: person.id });
  if (insp && findings) {
    await sbPatch(db, `housekeeping_inspections?id=eq.${insp.id}`, {
      findings: [insp.findings, findings].filter(Boolean).join(' · ').slice(0, 1000),
    });
  }
  await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
    status: 'done', done_at: nowIso(), updated_at: nowIso(),
    photos: insp?.photos || [],
  });
  await hkEvent(db, task.id, 'done', { actor: person.name, payload: { inspection_id: insp?.id || null, photos: (insp?.photos || []).length } });
  await closeAsksFor(db, 'housekeeping_task', task.id, { done: true });
  // Tickets raised by words that arrived apart from their photos get the
  // round's photos matched onto them now that the whole set is in.
  if (insp?.id && (insp.item_ids || []).length && (insp.photos || []).length) {
    try {
      const { attachInspectionPhotos } = await import('./inspection-photos.js');
      await attachInspectionPhotos(db, { inspectionId: insp.id, wa });
    } catch { /* the round is still closed; photos can be attached by hand */ }
  }
  const n = (insp?.photos || []).length;
  await sendText(wa, fromNum,
    n ? `Terima kasih, pemeriksaan ${await villaName(db, task.slug)} sudah selesai dengan ${n} foto. Laporannya saya teruskan ke pemilik villa.`
      : `Terima kasih, sudah saya catat pemeriksaan ${await villaName(db, task.slug)} pada ${on}.`);
  return true;
}

// ── Rounds that have their photos but never heard "selesai" ─────────
// A housekeeper who sent twenty-six photos and walked off has done the
// round; the word is a formality. From 19:00 WITA a round with at least
// five photos and no close is closed for her, marked as such, and she is
// told. A round with fewer photos is left for the next-day question.
export async function autoCloseRounds({ db, wa, now = new Date(), minPhotos = 5 } = {}) {
  const wita = new Date(now.getTime() + 8 * 3600e3);
  const today = wita.toISOString().slice(0, 10);
  if (wita.getUTCHours() < 19) return { skipped: 'before 19:00' };
  const rounds = (await sbGet(db, `housekeeping_inspections?inspected_on=lte.${today}&task_id=not.is.null&select=id,slug,task_id,photos,findings,by_staff_id&order=inspected_on.desc&limit=40`)) || [];
  let closed = 0;
  for (const insp of rounds) {
    if ((insp.photos || []).length < minPhotos) continue;
    const task = (await sbGet(db, `housekeeping_tasks?id=eq.${insp.task_id}&status=in.(notified,confirmed)&select=*,staff:assigned_staff_id(id,name,wa_num)&limit=1`))?.[0];
    if (!task) continue;
    await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, { status: 'done', done_at: nowIso(), updated_at: nowIso(), photos: insp.photos || [], notes: [task.notes, `Closed automatically with ${insp.photos.length} photos (no "selesai")`].filter(Boolean).join(' · ').slice(0, 500) });
    await hkEvent(db, task.id, 'done', { actor: 'Maya', payload: { auto: true, inspection_id: insp.id, photos: insp.photos.length } });
    await closeAsksFor(db, 'housekeeping_task', task.id, { done: true, auto: true });
    if ((insp.item_ids || []).length && (insp.photos || []).length) {
      try { const { attachInspectionPhotos } = await import('./inspection-photos.js'); await attachInspectionPhotos(db, { inspectionId: insp.id, wa }); } catch { /* by hand */ }
    }
    const to = String(task.staff?.wa_num || '').replace(/\D/g, '');
    if (to && wa) await sendText(wa, to, `Pemeriksaan ${await villaName(db, task.slug)} sudah saya tutup dengan ${insp.photos.length} foto, terima kasih 🙏 Lain kali balas "selesai" atau "semua bagus" setelah foto terakhir ya.`);
    closed++;
  }
  return { closed };
}

// ── For the owner's weekly report ───────────────────────────────────
// What an owner should see: we looked, here is when, here is what we found,
// and here is what was done about it. Staff names deliberately omitted —
// the owner is buying the outcome, not the roster.
export async function inspectionsForSlugs(db, slugs, { since } = {}) {
  const list = (slugs || []).filter(Boolean);
  if (!list.length) return [];
  const from = since || new Date(Date.now() - 21 * 86400e3).toISOString().slice(0, 10);
  const rows = (await sbGet(db,
    `housekeeping_inspections?slug=in.(${list.map(encodeURIComponent).join(',')})`
    + `&inspected_on=gte.${from}&select=*&order=inspected_on.desc&limit=40`)) || [];
  return rows.map(r => ({
    slug: r.slug,
    inspected_on: r.inspected_on,
    photo_count: (r.photos || []).length,
    findings: r.findings || null,
    photos: r.photos || [],
    item_ids: r.item_ids || [],
  }));
}
