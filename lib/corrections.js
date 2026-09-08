// A person changed what Maya wrote: the ground truth the review needs.
//
// Until 9 Sep 2026 the weekly review only saw what Maya did, never where
// she was wrong. Era moving a ticket to the right villa, Ikiel marking a
// visit not done after Maya recorded it done, a round deleted because a
// stray word opened it — each was an edit with no memory. Tuned on that,
// the loop would learn silence, not accuracy.
//
// recordCorrection() is called from the console actions, the team
// assistant's writes and any other place a human overrides a record:
//   - an event on the record (kind 'corrected', with what changed)
//   - a stamp on the staff turn that produced the record, when one is
//     found in the last 30 days (staff_turns.corrected_at)
//   - a line in settings.staff_corrections (ring of 300) so the review
//     can count corrections even for records that came from a cron
//
// Only real changes count: a note added is not a correction; a status,
// date, assignee, villa or photo set changed is.

import { hkEvent, maintEvent } from './events.js';
import { turnsForTarget, stampCorrected } from './staff-turns.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';

const KEY = 'staff_corrections';
const RING = 300;
const nowIso = () => new Date().toISOString();

// Which fields, changed by hand, mean Maya's record was wrong.
export const CORRECTING_FIELDS = {
  housekeeping_task: ['status', 'task_date', 'assigned_staff_id', 'photos'],
  housekeeping_inspection: ['findings', 'photos', 'item_ids', 'deleted'],
  housekeeping_readiness: ['status', 'photos', 'deleted'],
  maintenance_item: ['slug', 'group_key', 'unit_label', 'status', 'title', 'category', 'photos', 'deleted', 'reopened'],
};

// Pure: the subset of a patch that counts, with before/after when the
// caller has the old row.
export function correctingChange(targetType, fields = {}, before = null) {
  const allowed = CORRECTING_FIELDS[targetType] || [];
  const change = {};
  for (const k of Object.keys(fields || {})) {
    if (!allowed.includes(k)) continue;
    const to = fields[k];
    const from = before ? before[k] : undefined;
    if (before && JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;
    change[k] = before ? { from: from ?? null, to: to ?? null } : { to: to ?? null };
  }
  return Object.keys(change).length ? change : null;
}

async function sbGet(db, path) {
  try { const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders }); return r.ok ? r.json() : []; } catch { return []; }
}

// taskId lets an inspection or readiness correction land on its visit's
// event trail as well.
export async function recordCorrection(db, { targetType, targetId, change, actor = 'admin', source = 'console', taskId = null, note = null } = {}) {
  if (!targetType || targetId == null || !change) return null;
  const id = Number(targetId);
  const payload = { target_type: targetType, target_id: id, change, source, note: note || null };
  if (targetType === 'maintenance_item') await maintEvent(db, id, 'corrected', { actor, payload });
  else {
    let tid = taskId;
    if (!tid && targetType === 'housekeeping_task') tid = id;
    if (!tid && targetType === 'housekeeping_inspection') tid = (await sbGet(db, `housekeeping_inspections?id=eq.${id}&select=task_id&limit=1`))?.[0]?.task_id || null;
    if (!tid && targetType === 'housekeeping_readiness') tid = (await sbGet(db, `housekeeping_readiness?id=eq.${id}&select=task_id&limit=1`))?.[0]?.task_id || null;
    if (tid) await hkEvent(db, tid, 'corrected', { actor, payload });
  }
  // The turn that produced the record, if a staff message did.
  let turn = null;
  const turns = await turnsForTarget(db, targetType, id, { days: 30 });
  if (!turns.length && targetType === 'housekeeping_inspection' && taskId) turn = (await turnsForTarget(db, 'housekeeping_task', taskId, { days: 30 }))[0] || null;
  else turn = turns[0] || null;
  if (turn) await stampCorrected(db, turn.id, { by: actor, source, change, at: nowIso() });
  const line = { at: nowIso(), target_type: targetType, target_id: id, change, by: actor, source, turn_id: turn?.id || null, turn_text: turn?.text || null, turn_layer: turn?.layer || null, staff_id: turn?.staff_id || null };
  try {
    const ring = (await getSettingValue(db, KEY).catch(() => null)) || [];
    await saveSettingValue(db, KEY, [...(Array.isArray(ring) ? ring : []), line].slice(-RING));
  } catch { /* best effort */ }
  return line;
}

export async function correctionsSince(db, { days = 7 } = {}) {
  const ring = (await getSettingValue(db, KEY).catch(() => null)) || [];
  const since = Date.now() - days * 86400e3;
  return (Array.isArray(ring) ? ring : []).filter(c => Date.parse(c.at) >= since);
}
