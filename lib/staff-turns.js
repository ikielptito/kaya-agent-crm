// The turn ledger: one row per staff message, with what Maya made of it.
//
// Ikiel's question (9 Sep 2026): of everything the housekeepers say to
// Maya, how much does she understand, how much of that becomes a record,
// and how much of that record turns out right? Nothing measured any of
// the three. The dispatcher returned a category for the log and the
// review never looked at staff threads.
//
// So every inbound staff message gets a row here, written by the webhook
// after the handlers have run:
//
//   layer     which part of the dispatcher decided (trace() calls inside
//             staff-dispatch.js say so as they go)
//   outcome   what became of it, derived from what was actually written
//             in the seconds after it arrived: an event on a visit or a
//             ticket, a photo placed, an ask sent back, a tip, a forward
//   target    the record it touched
//
// and a correction stamp (corrected_at, correction) added later by
// corrections.js when a person changes what Maya wrote. staff-review.js
// reads the rows on Sundays and turns them into the funnel.
//
// Best effort throughout: never throws, no-op for ten minutes when the
// table is not there yet.

const _missingAt = { at: 0 };
const isMissing = () => Date.now() - _missingAt.at < 10 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
const enc = encodeURIComponent;

async function sb(db, path, init = {}) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders, ...init });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    if (r.status === 404 || /does not exist|PGRST205|42P01/i.test(t)) _missingAt.at = Date.now();
    throw new Error(`${r.status} ${t.slice(0, 120)}`);
  }
  return r;
}
async function get(db, path) { try { return await (await sb(db, path)).json(); } catch { return []; } }

export const turnsAvailable = () => !isMissing();

// Handlers note how they decided. ctx.trace accumulates; the last word on
// a key wins, so a handler deeper in can refine what the door said.
export function trace(ctx, patch = {}) {
  if (!ctx) return;
  ctx.trace = { ...(ctx.trace || {}), ...patch };
}

// The category the webhook logs is already a coarse outcome.
const CATEGORY_OUTCOME = {
  staff: 'forwarded', staff_error: 'error', staff_ack: 'ack', staff_help: 'answered', staff_onboard: 'answered',
  housekeeping_schedule: 'recorded', maintenance_tukang: 'recorded', photo_assign: 'recorded',
};
const CATEGORY_LAYER = { maintenance_tukang: 'handler', staff_onboard: 'handler', photo_assign: 'tap' };

// What was written because of this message. Events carry the inbound
// wamid when the handler had it; the ones that do not (moved, note,
// cannot, readiness_closed) are matched by actor and time instead.
async function derive(db, { person, waNum, wamid, receivedAt, category, trace: tr = {} }) {
  const since = enc(receivedAt);
  const who = person?.name ? `,actor.eq.${enc(person.name)}` : '';
  const [hk, mt, photos, asks, coach] = await Promise.all([
    wamid || person?.name ? get(db, `housekeeping_events?at=gte.${since}&or=(${wamid ? `wa_message_id.eq.${enc(wamid)}` : 'wa_message_id.eq.__none__'}${who})&select=task_id,kind,at&order=at.desc&limit=10`) : [],
    wamid || person?.name ? get(db, `maintenance_events?at=gte.${since}&or=(${wamid ? `wa_message_id.eq.${enc(wamid)}` : 'wa_message_id.eq.__none__'}${who})&select=item_id,kind,at&order=at.desc&limit=10`) : [],
    wamid ? get(db, `staff_photos?wa_message_id=eq.${enc(wamid)}&select=status,item_id,task_id,readiness_id,inspection_id&limit=5`) : [],
    get(db, `staff_asks?wa_num=eq.${waNum}&asked_at=gte.${since}&select=id,kind&limit=5`),
    get(db, `wa_messages?wa_num=eq.${waNum}&direction=eq.outbound&category=eq.staff_coach&timestamp=gte.${since}&select=id&limit=1`),
  ]);
  const out = { outcome: null, target_type: tr.target_type || null, target_id: tr.target_id || null, detail: {} };
  const H = Array.isArray(hk) ? hk : [], M = Array.isArray(mt) ? mt : [], P = Array.isArray(photos) ? photos : [];
  const placed = P.filter(p => p.status && p.status !== 'parked');
  if (H.length) { out.outcome = 'recorded'; out.target_type = 'housekeeping_task'; out.target_id = H[0].task_id; out.detail.events = H.map(e => e.kind); }
  else if (M.length) { out.outcome = 'recorded'; out.target_type = 'maintenance_item'; out.target_id = M[0].item_id; out.detail.events = M.map(e => e.kind); }
  else if (placed.length) {
    const p = placed[0];
    out.outcome = 'recorded';
    if (p.item_id) { out.target_type = 'maintenance_item'; out.target_id = p.item_id; }
    else if (p.readiness_id) { out.target_type = 'housekeeping_readiness'; out.target_id = p.readiness_id; }
    else if (p.inspection_id) { out.target_type = 'housekeeping_inspection'; out.target_id = p.inspection_id; }
    else if (p.task_id) { out.target_type = 'housekeeping_task'; out.target_id = p.task_id; }
    out.detail.photo = p.status;
  }
  if (P.length) out.detail.photos = P.length;
  if ((Array.isArray(asks) ? asks : []).length) { out.detail.asked = asks.map(a => a.kind); if (!out.outcome) out.outcome = 'asked'; }
  if ((Array.isArray(coach) ? coach : []).length) { out.detail.coached = true; if (!out.outcome) out.outcome = 'coached'; }
  if (!out.outcome && P.length && !placed.length) out.outcome = 'parked';
  if (!out.outcome && tr.outcome) out.outcome = tr.outcome;
  if (!out.outcome) out.outcome = CATEGORY_OUTCOME[category] || (category ? 'recorded' : 'forwarded');
  return out;
}

// Called by the webhook once the handlers are done. ctx is the dispatcher
// context (person, fromNum, text, mediaType, waMessageId, buttonPayload,
// replyTo, trace); category is what the webhook logged.
export async function recordTurn(db, { ctx, category, receivedAt }) {
  if (isMissing() || !ctx?.fromNum) return null;
  const tr = ctx.trace || {};
  const waNum = digits(ctx.fromNum);
  const kind = ctx.mediaType === 'image' ? 'photo' : ctx.buttonPayload ? 'tap' : 'text';
  const text = String(ctx.buttonPayload || ctx.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let d;
  try { d = await derive(db, { person: ctx.person, waNum, wamid: ctx.waMessageId, receivedAt, category, trace: tr }); }
  catch { d = { outcome: CATEGORY_OUTCOME[category] || 'recorded', target_type: null, target_id: null, detail: {} }; }
  const row = {
    wa_message_id: typeof ctx.waMessageId === 'string' ? ctx.waMessageId : null,
    wa_num: waNum, staff_id: ctx.person?.id ?? null, received_at: receivedAt || nowIso(),
    kind, text: text || null, ref_kind: tr.ref_kind || null,
    layer: tr.layer || CATEGORY_LAYER[category] || (category ? 'handler' : 'none'),
    intent: tr.intent || null, confidence: tr.confidence || null, category: category || null,
    outcome: d.outcome, target_type: d.target_type, target_id: d.target_id != null ? Number(d.target_id) : null,
    detail: { ...(tr.detail || {}), ...d.detail },
  };
  try {
    await sb(db, 'staff_turns', { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(row) });
    return row;
  } catch { return null; }
}

// A parked photo that later finds its record: the turn it arrived in
// becomes 'recorded' (photos.place calls this).
export async function turnPlaced(db, wamid, { targetType = null, targetId = null } = {}) {
  if (isMissing() || !wamid) return false;
  try {
    await sb(db, `staff_turns?wa_message_id=eq.${enc(wamid)}&outcome=in.(parked,asked,forwarded)`, {
      method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ outcome: 'recorded', ...(targetType ? { target_type: targetType, target_id: targetId } : {}) }),
    });
    return true;
  } catch { return false; }
}

// The most recent turns that touched a record, for the correction stamp.
export async function turnsForTarget(db, targetType, targetId, { days = 7 } = {}) {
  if (isMissing() || !targetType || targetId == null) return [];
  const since = enc(new Date(Date.now() - days * 86400e3).toISOString());
  return get(db, `staff_turns?target_type=eq.${enc(targetType)}&target_id=eq.${Number(targetId)}&received_at=gte.${since}&corrected_at=is.null&select=id,wa_num,staff_id,received_at,text,layer,intent,outcome,detail&order=received_at.desc&limit=5`);
}

export async function stampCorrected(db, turnId, correction) {
  if (isMissing() || !turnId) return false;
  try {
    await sb(db, `staff_turns?id=eq.${Number(turnId)}`, { method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ corrected_at: nowIso(), correction: correction || {} }) });
    return true;
  } catch { return false; }
}

export async function turnsSince(db, { days = 7, limit = 2000 } = {}) {
  if (isMissing()) return [];
  const since = enc(new Date(Date.now() - days * 86400e3).toISOString());
  const rows = await get(db, `staff_turns?received_at=gte.${since}&select=*&order=received_at.asc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}
