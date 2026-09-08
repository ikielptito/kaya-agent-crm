// Append-only history for tickets and visits.
//
// maintenance_items has twenty nullable "told them" columns and a 50-entry
// thread array; housekeeping_tasks has the same shape in miniature. Each
// answers "what is the state" but not "what happened, when, because of
// which message" — which is what a retry needs to be exact, what the owner
// page needs to show a real history, and what Ikiel needs when a ticket
// ends up on the wrong villa. So every transition also writes one row here.
//
//   maintEvent(db, itemId, kind, { actor, payload, wamid })
//   hkEvent(db, taskId, kind, { actor, payload, wamid })
//   eventsFor(db, 'maintenance', itemId)
//
// Best effort, never throws, no-op when the tables are not there yet. The
// status columns remain authoritative; this is the record beside them.

// Remembered for ten minutes, not for the life of the instance.
const _missingAt = { maintenance_events: 0, housekeeping_events: 0 };
const isMissing = (t) => Date.now() - _missingAt[t] < 10 * 60 * 1000;
const nowIso = () => new Date().toISOString();

async function write(db, table, row) {
  if (isMissing(table)) return null;
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 404 || /does not exist|PGRST205|42P01/i.test(t)) _missingAt[table] = Date.now();
    }
    return r.ok;
  } catch { return null; }
}

export async function maintEvent(db, itemId, kind, { actor = null, payload = {}, wamid = null } = {}) {
  if (!itemId || !kind) return null;
  return write(db, 'maintenance_events', { item_id: Number(itemId), kind, actor, payload: payload || {}, wa_message_id: typeof wamid === 'string' ? wamid : null, at: nowIso() });
}
export async function hkEvent(db, taskId, kind, { actor = null, payload = {}, wamid = null } = {}) {
  if (!taskId || !kind) return null;
  return write(db, 'housekeeping_events', { task_id: Number(taskId), kind, actor, payload: payload || {}, wa_message_id: typeof wamid === 'string' ? wamid : null, at: nowIso() });
}

export async function eventsFor(db, what, id, { limit = 100 } = {}) {
  const table = what === 'maintenance' ? 'maintenance_events' : 'housekeeping_events';
  const col = what === 'maintenance' ? 'item_id' : 'task_id';
  if (isMissing(table)) return [];
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${table}?${col}=eq.${Number(id)}&select=kind,actor,payload,wa_message_id,at&order=at.asc&limit=${limit}`, { headers: db.sbHeaders });
    if (!r.ok) { if (r.status === 404) _missingAt[table] = Date.now(); return []; }
    return r.json();
  } catch { return []; }
}
