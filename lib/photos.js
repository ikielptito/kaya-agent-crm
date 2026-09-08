// Every photo a staff member sends, once, with where it ended up.
//
// Before 8 Sep 2026 a photo's fate lived in three settings blobs
// (photo_by_wamid, maintenance_pending_photos, maint_photo_suggestions),
// each rewritten whole by whichever lambda finished last — a burst of six
// photos reliably lost one, and a later "reply to that photo" then found
// nothing to attach. This module writes one row per photo to staff_photos
// and answers the questions the handlers ask:
//
//   remember(db, { path, wamid, waNum, staffId, caption, source, status, ... })
//   byWamid(db, wamid)                → row or null
//   parked(db, waNum)                 → rows still waiting for a home (30 min)
//   takeParked(db, waNum)             → the same, and marks them attached-pending
//   place(db, path, { status, item_id | task_id | readiness_id | inspection_id, by })
//   suggestFor(db, path, itemIds, why)
//   suggestionsFor(db, itemId)        → rows
//   reject(db, path, { itemId })
//
// Tolerant: without the table, the settings-blob implementations in
// photo-assign.js and maintenance-staff.js keep working; callers check
// photosAvailable() or simply get null / [] back.

const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
const PARK_MS = 30 * 60 * 1000;
// Remembered for ten minutes, not for the life of the instance: the tables
// were created on 8 Sep 2026 while warm instances still believed them absent.
let _missingAt = 0;
const MISSING_MS = 10 * 60 * 1000;
const isMissing = () => Date.now() - _missingAt < MISSING_MS;
const markMissing = () => { _missingAt = Date.now(); };

async function sb(db, path, init = {}) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders, ...init });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    if (r.status === 404 || /staff_photos|does not exist|PGRST205|42P01/i.test(t)) { markMissing(); return null; }
    throw new Error(`photos → ${r.status}: ${t.slice(0, 160)}`);
  }
  return r.status === 204 ? true : r.json().catch(() => null);
}
export const photosAvailable = () => !isMissing();

export async function remember(db, { path, wamid = null, waNum = null, staffId = null, caption = null, source = null, status = 'parked', itemId = null, taskId = null, readinessId = null, inspectionId = null, why = null } = {}) {
  if (isMissing() || !path) return null;
  try {
    const rows = await sb(db, 'staff_photos?on_conflict=path', {
      method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        path, wa_message_id: typeof wamid === 'string' ? wamid : null, wa_num: digits(waNum) || null, staff_id: staffId ?? null,
        caption: caption ? String(caption).slice(0, 500) : null, source, status,
        item_id: itemId ?? null, task_id: taskId ?? null, readiness_id: readinessId ?? null, inspection_id: inspectionId ?? null,
        why: why ? String(why).slice(0, 200) : null, received_at: nowIso(),
      }),
    });
    return Array.isArray(rows) ? rows[0] : null;
  } catch { return null; }
}

export async function byWamid(db, wamid) {
  if (isMissing() || !wamid) return null;
  try { return (await sb(db, `staff_photos?wa_message_id=eq.${encodeURIComponent(wamid)}&select=*&limit=1`))?.[0] || null; } catch { return null; }
}
export async function byPath(db, path) {
  if (isMissing() || !path) return null;
  try { return (await sb(db, `staff_photos?path=eq.${encodeURIComponent(path)}&select=*&limit=1`))?.[0] || null; } catch { return null; }
}

export async function parked(db, waNum, { withinMs = PARK_MS } = {}) {
  if (isMissing()) return [];
  try {
    const since = new Date(Date.now() - withinMs).toISOString();
    return (await sb(db, `staff_photos?wa_num=eq.${digits(waNum)}&status=eq.parked&received_at=gte.${encodeURIComponent(since)}&select=*&order=received_at.asc&limit=12`)) || [];
  } catch { return []; }
}
// Claim the parked photos atomically-ish: a conditional PATCH on status so
// two lambdas cannot both take the same rows.
export async function takeParked(db, waNum, { withinMs = PARK_MS } = {}) {
  if (isMissing()) return [];
  try {
    const since = new Date(Date.now() - withinMs).toISOString();
    const rows = await sb(db, `staff_photos?wa_num=eq.${digits(waNum)}&status=eq.parked&received_at=gte.${encodeURIComponent(since)}`, {
      method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'taken', decided_at: nowIso() }),
    });
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export async function place(db, path, { status = 'attached', itemId = null, taskId = null, readinessId = null, inspectionId = null, by = null, why = null } = {}) {
  if (isMissing() || !path) return false;
  try {
    const patch = { status, decided_at: nowIso(), decided_by: by };
    if (itemId != null) patch.item_id = itemId;
    if (taskId != null) patch.task_id = taskId;
    if (readinessId != null) patch.readiness_id = readinessId;
    if (inspectionId != null) patch.inspection_id = inspectionId;
    if (why) patch.why = String(why).slice(0, 200);
    await sb(db, `staff_photos?path=eq.${encodeURIComponent(path)}`, { method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    return true;
  } catch { return false; }
}

export async function suggestFor(db, path, itemIds, { why = null } = {}) {
  if (isMissing() || !path) return false;
  try {
    await sb(db, `staff_photos?path=eq.${encodeURIComponent(path)}`, {
      method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'suggested', suggested_for: (itemIds || []).map(Number).filter(Boolean), why: why ? String(why).slice(0, 200) : null }),
    });
    return true;
  } catch { return false; }
}
export async function suggestionsFor(db, itemId) {
  if (isMissing()) return [];
  try { return (await sb(db, `staff_photos?status=eq.suggested&suggested_for=cs.{${Number(itemId)}}&select=*&order=received_at.asc&limit=20`)) || []; } catch { return []; }
}
export async function reject(db, path, { by = null } = {}) {
  return place(db, path, { status: 'rejected', by });
}

// Photos on a ticket, for the console's history strip.
export async function forItem(db, itemId) {
  if (isMissing()) return [];
  try { return (await sb(db, `staff_photos?item_id=eq.${Number(itemId)}&select=path,wa_num,caption,source,status,received_at&order=received_at.asc&limit=40`)) || []; } catch { return []; }
}
