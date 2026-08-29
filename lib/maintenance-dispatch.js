// Getting a tukang to the villa — the half of the repair loop that used to
// live entirely in Era's head.
//
// Once an owner approves a repair, someone still has to find a tradesman,
// agree a time, chase him on the day, and confirm the work was done. This
// module is that someone. The state machine mirrors viewings, which already
// schedules a third party over WhatsApp and survives the same failure modes:
//
//   offered   Era assigned him; Maya has sent (or is about to send) the job
//   confirmed he named a day and time, and it is recorded
//   arrived   he says he is at the property
//   done      he says the work is finished (Era still confirms before the
//             ticket closes — a repair is not complete because the person
//             paid to do it says so)
//   declined  he cannot take it, and Era needs to reassign
//
// Era is told at every transition. That is the whole point: she should learn
// that the tukang confirmed Tuesday at 9 without having to ask anyone.
//
// Two rules carried over from the rest of the system:
//   - Every "tell someone" is a null timestamp, and every transition re-arms
//     the next one by nulling it. Sweeps are then safe to re-run.
//   - Anything that must happen once uses a conditional PATCH, never a read
//     followed by a write: WhatsApp delivers bursts and each message is its
//     own lambda, so two replies can race.

import { appendThread, completeItem } from './maintenance.js';
import { parseTukangReply } from './maintenance-intake.js';
import { staffByWa } from './staff.js';

const nowIso = () => new Date().toISOString();
const GRAPH = 'https://graph.facebook.com/v24.0';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
  });
}

export const placeOf = (item) =>
  item.unit_label ? `${item.statement_groups?.name || item.group_key} (${item.unit_label})`
                  : (item.statement_groups?.name || item.group_key);

// "Wednesday 2 September, 09:00 WITA" for Era, "Rabu, 2 September, 09:00
// WITA" for the tukang. Everyone involved is standing in the same timezone,
// so the label is always WITA; only the language changes with the reader.
function witaParts(iso) {
  const d = new Date(Date.parse(iso) + 8 * 3600e3);
  return { day: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
export function witaLabel(iso) {
  if (!iso) return null;
  const { day, time } = witaParts(iso);
  const label = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  return `${label}, ${time} WITA`;
}
export function witaLabelId(iso) {
  if (!iso) return null;
  const { day, time } = witaParts(iso);
  const label = new Date(day + 'T00:00:00Z').toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  return `${label}, pukul ${time} WITA`;
}

// ── Assignment ──────────────────────────────────────────────────────
// Era picks someone. Nulling both notify latches queues the job message to
// him and the "I've asked him" note to her on the next sweep.
export async function assignTukang(db, id, staffId, { actor = 'admin' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (!['approved', 'scheduled'].includes(item.status)) {
    throw new Error(`only approved work can be assigned (this one is ${item.status})`);
  }
  const staff = (await sbGet(db, `staff?id=eq.${parseInt(staffId, 10)}&select=*&limit=1`))?.[0];
  if (!staff) throw new Error('no such person in the team register');
  if (!staff.active) throw new Error(`${staff.name} is marked inactive`);

  await sbPatch(db, `maintenance_items?id=eq.${id}`, {
    assigned_staff_id: staff.id,
    assigned_at: nowIso(),
    assigned_by: actor,
    visit_status: 'offered',
    visit_at: null,
    tukang_notified_at: null,          // queued: send him the job
    tukang_replied_at: null,
    visit_reminded_at: null,
    arrival_check_at: null,
    completion_check_at: null,
    era_dispatch_update_at: null,      // queued: tell Era he has been asked
    era_dispatch_state: null,
    updated_at: nowIso(),
  });
  await appendThread(db, id, { who: actor, text: `Assigned to ${staff.name}` });
  return { ok: true, staff };
}

export async function unassignTukang(db, id, { actor = 'admin' } = {}) {
  // Who was on it, and had he actually been told? A tukang who received the
  // job and a link, then heard nothing, will turn up at the villa. Record the
  // fact so the sweep can send him a cancellation.
  const before = (await sbGet(db,
    `maintenance_items?id=eq.${id}&select=assigned_staff_id,tukang_notified_at,visit_status&limit=1`))?.[0];
  const owedNotice = !!(before?.assigned_staff_id && before.tukang_notified_at
    && before.visit_status !== 'declined' && before.visit_status !== 'done');

  await sbPatch(db, `maintenance_items?id=eq.${id}`, {
    assigned_staff_id: null, assigned_at: null, visit_status: null, visit_at: null,
    tukang_notified_at: null, tukang_replied_at: null, visit_reminded_at: null,
    arrival_check_at: null, completion_check_at: null,
    era_dispatch_update_at: nowIso(),   // nothing to announce; close the latch
    era_dispatch_state: null, updated_at: nowIso(),
    // Queued for the sweep, not sent here: this runs inside an admin request
    // and must not block on WhatsApp, and the sweep already owns the daily
    // cap and the template gate.
    ...(owedNotice ? { cancel_notice_for: before.assigned_staff_id, cancel_notice_at: null } : {}),
  });
  await appendThread(db, id, { who: actor, text: 'Assignment cleared' });
  return { ok: true, cancel_queued: owedNotice };
}

// ── The once-only transitions ───────────────────────────────────────
// A conditional PATCH is the mutex: the filter names the state we expect, so
// only the first of two racing replies changes anything. The loser gets an
// empty array back and stays silent, rather than sending Era a second
// "confirmed for Tuesday".
async function transitionOnce(db, id, from, patch) {
  const filter = Array.isArray(from) ? `visit_status=in.(${from.join(',')})` : `visit_status=eq.${from}`;
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/maintenance_items?id=eq.${id}&${filter}`, {
    method: 'PATCH',
    headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, era_dispatch_update_at: null, updated_at: nowIso() }),
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export const confirmVisitOnce = (db, id, atIso) =>
  transitionOnce(db, id, ['offered', 'confirmed'], {
    visit_status: 'confirmed', visit_at: atIso,
    visit_reminded_at: null, arrival_check_at: null, completion_check_at: null,
  });

export const declineVisitOnce = (db, id) =>
  transitionOnce(db, id, ['offered', 'confirmed'], { visit_status: 'declined', visit_at: null });

// The three *_at columns below are "has Maya asked?" latches, not records of
// what happened — what happened is visit_status. Stamping an ask latch here
// would silence the follow-up that has not been sent yet.
export const markArrivedOnce = (db, id) =>
  transitionOnce(db, id, ['offered', 'confirmed'], { visit_status: 'arrived' });

export const markWorkDoneOnce = (db, id) =>
  transitionOnce(db, id, ['offered', 'confirmed', 'arrived'], { visit_status: 'done' });

// ── The job sheet behind /j/<token> ─────────────────────────────────
// Everything the tukang needs, in one page: what is broken, where, the
// photos, the budget he has been given, and the agreed time. Sending this as
// a link rather than a wall of images keeps the private photo bucket private
// (the URLs are signed and short-lived) and means Era can update the details
// without re-sending anything.
export async function jobSheet(db, id) {
  const item = (await sbGet(db,
    `maintenance_items?id=eq.${id}&select=*,statement_groups(key,name),staff:assigned_staff_id(id,name,wa_num)&limit=1`))?.[0];
  if (!item) return null;
  if (!item.assigned_staff_id) return null;    // never assigned: nothing to show
  const { signPhotoUrl } = await import('./maintenance.js');
  const photo_urls = [];
  for (const p of (item.photos || [])) {
    const u = await signPhotoUrl(db, p).catch(() => null);
    if (u) photo_urls.push(u);
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    place: placeOf(item),
    urgency: item.urgency,
    currency: item.currency,
    budget: item.estimated_cost,
    photo_urls,
    visit_status: item.visit_status,
    visit_at: item.visit_at,
    visit_label: witaLabelId(item.visit_at),
    assigned_to: item.staff?.name || null,
    reported_at: item.reported_at,
  };
}

// ── His replies ─────────────────────────────────────────────────────
// Claim-or-fall-through, the same contract as Era's handler: this returns
// true only when it is confident the message is about a job it dispatched.
// Anything else drops back to the ordinary team handling, so a tukang who
// also chats with the office is never swallowed by a work-order robot.
export async function handleTukangReply(db, wa, { from, text }) {
  const body = String(text || '').trim();
  if (!body) return false;

  const person = await staffByWa(db, from);
  if (!person || !person.active) return false;

  const open = (await sbGet(db,
    `maintenance_items?assigned_staff_id=eq.${person.id}&visit_status=in.(offered,confirmed,arrived)&status=in.(approved,scheduled)`
    + `&select=*,statement_groups(key,name)&order=assigned_at.desc&limit=5`)) || [];
  if (!open.length) return false;

  // With more than one open job, the most recently dispatched is the one he
  // is answering — but Maya names the property back to him, so a wrong guess
  // is visible and correctable rather than silent.
  const item = open[0];
  const place = placeOf(item);
  const parsed = await parseTukangReply(body, { itemTitle: item.title, place });

  await appendThread(db, item.id, { who: person.name, text: body });
  await sbPatch(db, `maintenance_items?id=eq.${item.id}`, { tukang_replied_at: nowIso() });

  const say = (msg) => sendText(wa, from, msg).catch(() => null);

  if (parsed.intent === 'accept') {
    if (!parsed.at) {
      // He is willing but named no time. Asking once is much cheaper than
      // guessing and sending him on the wrong morning.
      await say(`Terima kasih. Untuk ${place}, kira-kira hari dan jam berapa Anda bisa datang?`);
      return true;
    }
    const won = await confirmVisitOnce(db, item.id, parsed.at);
    if (won) await say(`Siap, dicatat: ${place} pada ${witaLabelId(parsed.at)}. Terima kasih.`);
    return true;
  }

  if (parsed.intent === 'decline') {
    const won = await declineVisitOnce(db, item.id);
    if (won) await say(`Baik, terima kasih sudah mengabari. Kami akan cari yang lain untuk ${place}.`);
    return true;
  }

  if (parsed.intent === 'arrived') {
    const won = await markArrivedOnce(db, item.id);
    if (won) await say(`Terima kasih, sudah dicatat Anda sampai di ${place}.`);
    return true;
  }

  if (parsed.intent === 'done') {
    const won = await markWorkDoneOnce(db, item.id);
    if (won) await say(`Terima kasih. Kami akan konfirmasi dengan Era, lalu pekerjaan di ${place} kami tutup.`);
    return true;
  }

  // A question or an unclear answer is left for a person. Logging it to the
  // thread means Era sees it in the cockpit even though Maya said nothing.
  return false;
}

async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.messages?.[0]?.id || true;
}

// ── Closing the loop ────────────────────────────────────────────────
// Era confirms the repair is genuinely finished, which closes the ticket
// through the existing path so the owner is told and the cost lands on the
// right month's statement.
export async function confirmRepairDone(db, id, { note, actual_cost, by = 'era' } = {}) {
  await sbPatch(db, `maintenance_items?id=eq.${id}`, { visit_status: 'done', era_dispatch_update_at: nowIso() });
  return completeItem(db, id, { note, actual_cost, by });
}
