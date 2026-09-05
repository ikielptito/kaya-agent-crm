// Maintenance items for Samba Realty-managed villas.
//
// The loop this models:
//   Era or a cleaner sends Maya a photo + "Haus unit 1 bathroom wall needs
//   paint touch up" → filed as `new` → Era reviews it in /payouts, adds a
//   cost estimate and decides whether the owner must approve → publish →
//   Maya asks the owner (or just tells them, for routine work) → owner
//   approves → Maya tells Era to go ahead → Era does the work and marks it
//   done → Maya tells the owner it's finished.
//
// While work is authorised but unfinished, Maya nudges Era. If Era answers
// "next Tuesday", that date becomes the next nudge instead of the default
// cadence — the point is to ask once and then wait, not to pester.
//
// Statuses: new → pending_approval | scheduled → approved | declined → done
//   scheduled = notify-only (routine, low cost, no approval required)
//   approved  = work authorised, awaiting completion  ← the follow-up queue
//   done      = finished

import { maintenanceToken, tukangToken } from './tokens.js';

const nowIso = () => new Date().toISOString();
const PHOTO_BUCKET = 'maintenance-photos';
const FOLLOWUP_DAYS = 3;          // default nudge cadence while work is open

const digits = (s) => String(s || '').replace(/\D/g, '');

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patch ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function sbInsert(db, table, row) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${table} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const out = await r.json().catch(() => null);
  return Array.isArray(out) ? out[0] : out;
}

export const inDays = (n) => new Date(Date.now() + n * 86400e3).toISOString();

// ── Staff reporters (Era, cleaners) ─────────────────────────────────
// Only these numbers can file maintenance items by messaging Maya, so a
// guest or agent sending a photo never creates one.
// The staff registry is the truth now; maintenance_reporters stays as a
// fallback so a number that was allowlisted before the registry existed keeps
// working even if its migration row was missed. Returned shape is the old
// {wa_num, name, role} either way, so callers did not have to change.
export async function isReporter(db, waNum) {
  const n = digits(waNum);
  if (!n) return null;
  const staff = await sbGet(db, `staff?wa_num=eq.${encodeURIComponent(n)}&active=is.true&can_report=is.true&select=*&limit=1`);
  const s = staff?.[0];
  if (s) return { wa_num: s.wa_num, name: s.name, role: (s.roles || [])[0] || 'staff', staff: s };
  const rows = await sbGet(db, `maintenance_reporters?wa_num=eq.${encodeURIComponent(n)}&active=is.true&select=*&limit=1`);
  return rows?.[0] || null;
}
export async function listReporters(db) {
  return (await sbGet(db, 'maintenance_reporters?select=*&order=created_at.asc')) || [];
}
export async function upsertReporter(db, { wa_num, name, role = 'staff', active = true }) {
  const n = digits(wa_num);
  if (!n) throw new Error('wa_num required');
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/maintenance_reporters?on_conflict=wa_num`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ wa_num: n, name: name || null, role, active }),
  });
  if (!r.ok) throw new Error(`upsert reporter → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { ok: true };
}

// ── Property matching ───────────────────────────────────────────────
// Era writes the way she speaks: "Haus unit 1", "haus 5", "tropicana b4",
// "saturno". The unit NUMBER is the dangerous part — pick the wrong one and
// the wrong owner is asked to pay for someone else's repair. So a digit only
// counts as a unit number when it is written like one: after "unit"/"no"/"#"
// or directly after the property name. Prices are stripped first, because
// "1.1jt each" must never be read as unit 1, and a tie between two units is
// treated as ambiguous (Maya asks) rather than guessed.
const MONEY_RE = /(?:rp\s*)?\d+(?:[.,]\d+)*\s*(?:jt|juta|rb|ribu|k|m|mio|million)\b/gi;
const UNIT_CUES = new Set(['unit', 'units', 'no', 'nomor', 'number', 'kamar', 'villa', 'room']);
const normWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const isUnitTok = (t) => /^\d+$/.test(t) || /^[a-z]\d+$/.test(t);

export function pickProperty(groups, text) {
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return null;
  // Drop prices and bare decimals before anything looks for unit numbers.
  const cleaned = raw.replace(MONEY_RE, ' ').replace(/\d+[.,]\d+/g, ' ');
  const toks = normWords(cleaned);
  const words = new Set(toks);

  // Every word that appears in some property's name — "haus 5" is a unit
  // reference precisely because "haus" is a property word.
  const nameVocab = new Set();
  for (const g of groups) {
    for (const w of normWords(g.name)) if (!isUnitTok(w)) nameVocab.add(w);
    for (const s of (g.listing_slugs || [])) for (const w of normWords(s)) if (!isUnitTok(w)) nameVocab.add(w);
  }

  // Digits written as a unit reference.
  const unitHints = new Set();
  toks.forEach((t, i) => {
    if (!isUnitTok(t)) return;
    const prev = toks[i - 1];
    const prev2 = toks[i - 2];
    if (/^[a-z]\d+$/.test(t)) { unitHints.add(t); return; }   // "b4" is unambiguous
    if (prev && (UNIT_CUES.has(prev) || nameVocab.has(prev))) unitHints.add(t);
    else if (prev2 && nameVocab.has(prev2) && UNIT_CUES.has(prev)) unitHints.add(t);
  });

  const cands = [];
  for (const g of groups) {
    for (const slug of (g.listing_slugs || [])) {
      const st = normWords(slug);
      const nameToks = st.filter(t => !isUnitTok(t));
      const unitToks = st.filter(isUnitTok);
      if (!nameToks.every(t => words.has(t))) continue;
      if (!unitToks.every(t => unitHints.has(t))) continue;
      cands.push({ score: 100 + st.length, group_key: g.key, slug, unit_label: slug, group: g });
    }
  }
  if (!cands.length) {
    for (const g of groups) {
      const nameToks = normWords(g.name).filter(w => w.length > 2 && !isUnitTok(w));
      const hits = nameToks.filter(t => words.has(t)).length;
      if (hits >= Math.max(1, Math.ceil(nameToks.length / 2))) {
        cands.push({ score: 10 + hits, group_key: g.key, slug: null, unit_label: null, group: g });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  // Two different properties fit equally well — say nothing rather than
  // pick one. The caller asks which villa it is.
  const top = cands[0];
  const tied = cands.filter(c => c.score === top.score);
  if (tied.length > 1 && tied.some(c => c.group_key !== top.group_key || c.slug !== top.slug)) {
    return { ...top, ambiguous: true, options: tied.map(c => ({ group_key: c.group_key, slug: c.slug, name: c.group?.name })) };
  }
  return top;
}

export async function matchProperty(db, text) {
  const groups = (await sbGet(db, 'statement_groups?active=is.true&select=key,name,listing_slugs,owner_names')) || [];
  return pickProperty(groups, text);
}

// ── Photos ──────────────────────────────────────────────────────────
// Put one image in the private bucket and return its path. Split out from
// savePhoto so inspection rounds can store photos under their own prefix
// without pretending to be a work order.
export async function uploadPhoto(db, prefix, { base64, contentType }) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(String(contentType || ''))) throw new Error('photo must be jpeg/png/webp');
  const bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length) throw new Error('empty upload');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('image too large');
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  // A counter in the name because a burst of photos can share a millisecond.
  const path = `${prefix}/${Date.now()}-${Math.floor(performance.now() * 1000) % 1000}.${ext}`;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey,
      'Content-Type': contentType, 'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`photo upload → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return path;
}

export async function savePhoto(db, itemId, { base64, contentType }) {
  const path = await uploadPhoto(db, String(itemId), { base64, contentType });
  const item = (await sbGet(db, `maintenance_items?id=eq.${itemId}&select=photos&limit=1`))?.[0];
  const photos = [...(item?.photos || []), path];
  await sbPatch(db, `maintenance_items?id=eq.${itemId}`, { photos, updated_at: nowIso() });
  return path;
}
// People send the photos first and explain afterwards. A photo that arrives
// before we know which villa it belongs to is parked here, then attached to
// the ticket the next message creates — rather than being lost or forcing
// them to re-send it.
export async function savePendingPhoto(db, waNum, { base64, contentType }) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(String(contentType || ''))) throw new Error('photo must be jpeg/png/webp');
  const bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('bad photo size');
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  const path = `pending/${digits(waNum)}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey,
      'Content-Type': contentType, 'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`pending photo upload → ${r.status}`);
  return path;
}

// Read a stored photo back, so a parked picture can still be looked at when
// deciding which job it belongs to.
export async function readPhotoBase64(db, path) {
  try {
    const url = await signPhotoUrl(db, path, 120);
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    const ext = String(path).split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { base64: buf.toString('base64'), mime };
  } catch { return null; }
}

// Take photo paths off an item (used when a picture turns out to belong to a
// different job, and by the admin's ✕ on a thumbnail).
export async function detachPhotoPaths(db, itemId, paths) {
  if (!paths?.length) return { ok: true };
  const item = (await sbGet(db, `maintenance_items?id=eq.${itemId}&select=photos&limit=1`))?.[0];
  const keep = (item?.photos || []).filter(p => !paths.includes(p));
  await sbPatch(db, `maintenance_items?id=eq.${itemId}`, { photos: keep, updated_at: nowIso() });
  return { ok: true, remaining: keep.length };
}

// Attach already-stored photo paths (e.g. parked ones) to an item.
export async function attachPhotoPaths(db, itemId, paths) {
  if (!paths?.length) return { ok: true, added: 0 };
  const item = (await sbGet(db, `maintenance_items?id=eq.${itemId}&select=photos&limit=1`))?.[0];
  const photos = [...new Set([...(item?.photos || []), ...paths])];
  await sbPatch(db, `maintenance_items?id=eq.${itemId}`, { photos, updated_at: nowIso() });
  return { ok: true, added: paths.length };
}

export async function signPhotoUrl(db, path, expiresIn = 3600) {
  if (!path) return null;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/sign/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: { Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.signedURL ? `${db.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}
async function withPhotoUrls(db, item) {
  if (!item) return item;
  const urls = await Promise.all((item.photos || []).map(p => signPhotoUrl(db, p)));
  return { ...item, photo_urls: urls.filter(Boolean) };
}

// ── CRUD ────────────────────────────────────────────────────────────
export async function createItem(db, fields) {
  const row = {
    group_key: fields.group_key,
    slug: fields.slug || null,
    unit_label: fields.unit_label || null,
    title: String(fields.title || 'Maintenance item').slice(0, 200),
    description: fields.description || null,
    urgency: ['low', 'normal', 'urgent'].includes(fields.urgency) ? fields.urgency : 'normal',
    // A price quoted in the WhatsApp report is pre-filled for Era to confirm.
    estimated_cost: fields.estimated_cost != null ? Number(fields.estimated_cost) || null : null,
    reported_by_wa: digits(fields.reported_by_wa) || null,
    reported_by_name: fields.reported_by_name || null,
    status: 'new',
    thread: fields.thread || [],
  };
  return sbInsert(db, 'maintenance_items', row);
}

export async function listItems(db, { group_key, status, open_only } = {}) {
  // The staff embed is what the cockpit shows as "assigned to Dian". It is
  // requested separately from the first attempt so that an environment where
  // the dispatch migration has not run yet still lists items: naming an
  // unmigrated column inside an embed errors the WHOLE query, which once
  // rendered the admin's statement list completely empty.
  const base = 'maintenance_items?select=*,statement_groups(key,name,owner_names,notify,owner_wa_nums)';
  const withStaff = base + ',staff:assigned_staff_id(id,name,wa_num,roles,trades)';
  let filters = '&order=created_at.desc&limit=500';
  if (group_key) filters += `&group_key=eq.${encodeURIComponent(group_key)}`;
  if (status) filters += `&status=eq.${encodeURIComponent(status)}`;
  if (open_only) filters += '&status=neq.done';
  const rows = (await sbGet(db, withStaff + filters)) || (await sbGet(db, base + filters)) || [];
  // The signed links are what the cockpit's "Preview owner view" and "Open
  // the tukang's job sheet" buttons point at.
  return rows.map(r => ({
    ...r,
    token: maintenanceToken(r.group_key, r.id),
    job_token: r.assigned_staff_id ? tukangToken(r.id) : null,
  }));
}

export async function getItem(db, id) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*,statement_groups(key,name,owner_names,notify,owner_wa_nums)&limit=1`))?.[0];
  return item ? withPhotoUrls(db, item) : null;
}

const EDITABLE = new Set(['title', 'description', 'slug', 'unit_label', 'urgency', 'estimated_cost', 'actual_cost', 'requires_approval', 'group_key', 'completion_note']);
export async function patchItem(db, id, fields) {
  const patch = {};
  for (const [k, v] of Object.entries(fields || {})) if (EDITABLE.has(k)) patch[k] = v;
  if (!Object.keys(patch).length) throw new Error('no editable fields');
  if (patch.estimated_cost != null) patch.estimated_cost = Number(patch.estimated_cost) || null;
  if (patch.actual_cost != null) patch.actual_cost = Number(patch.actual_cost) || null;
  patch.updated_at = nowIso();
  await sbPatch(db, `maintenance_items?id=eq.${id}`, patch);
  return { ok: true };
}

export async function deleteItem(db, id) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/maintenance_items?id=eq.${id}`, { method: 'DELETE', headers: db.sbHeaders });
  if (!r.ok) throw new Error(`delete → ${r.status}`);
  return { ok: true };
}

// ── Lifecycle ───────────────────────────────────────────────────────
// Publish: Era has reviewed it. Either the owner must approve (requires
// approval → pending_approval) or it's routine work we just tell them about
// (notify-only → scheduled, and the follow-up clock starts immediately
// because the work is already authorised).
export async function publishItem(db, id, { requires_approval, estimated_cost, actor = 'admin' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (!['new', 'pending_approval', 'scheduled'].includes(item.status)) {
    throw new Error(`cannot publish an item that is ${item.status}`);
  }
  const needsApproval = requires_approval !== undefined ? !!requires_approval : !!item.requires_approval;
  const patch = {
    requires_approval: needsApproval,
    status: needsApproval ? 'pending_approval' : 'scheduled',
    published_at: item.published_at || nowIso(),
    published_by: actor,
    notified_at: null,                     // queues the Maya notification
    updated_at: nowIso(),
  };
  if (estimated_cost !== undefined) patch.estimated_cost = Number(estimated_cost) || null;
  // Notify-only work is authorised the moment it's published, so start
  // nudging Era about finishing it.
  if (!needsApproval) patch.next_followup_at = inDays(FOLLOWUP_DAYS);
  await sbPatch(db, `maintenance_items?id=eq.${id}`, patch);
  return { ok: true, status: patch.status };
}

// Heads-up: tell the owner now, cost to follow. Only from "new" — once a
// ticket is published the owner has heard of it — and only once.
export async function headsUpItem(db, id, { actor = 'admin' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (item.status !== 'new') throw new Error(`the owner already hears about a ${item.status} ticket`);
  if (item.heads_up_at) return { ok: true, already: true };
  await sbPatch(db, `maintenance_items?id=eq.${id}`, { heads_up_at: nowIso(), updated_at: nowIso() });
  await appendThread(db, id, { who: actor, text: 'Heads-up to the owner requested: cost to follow' });
  return { ok: true };
}

export async function approveItem(db, id, { by = 'owner' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (item.status === 'approved' || item.status === 'done') return { ok: true, already: true };
  if (item.status !== 'pending_approval') throw new Error(`item is ${item.status}, not awaiting approval`);
  await sbPatch(db, `maintenance_items?id=eq.${id}`, {
    status: 'approved',
    approved_at: nowIso(),
    approved_by: by,
    declined_at: null,
    decline_note: null,
    staff_notified_at: null,               // queues "owner approved" to Era
    next_followup_at: inDays(FOLLOWUP_DAYS),
    updated_at: nowIso(),
  });
  return { ok: true };
}

export async function declineItem(db, id, { note, by = 'owner' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (item.status !== 'pending_approval') throw new Error(`item is ${item.status}, not awaiting approval`);
  await sbPatch(db, `maintenance_items?id=eq.${id}`, {
    status: 'declined',
    declined_at: nowIso(),
    approved_by: by,
    decline_note: String(note || '').slice(0, 500) || null,
    staff_notified_at: null,               // Era hears about this too
    next_followup_at: null,                // nothing to chase
    updated_at: nowIso(),
  });
  return { ok: true };
}

export async function completeItem(db, id, { note, actual_cost, by = 'admin' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=*&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  if (item.status === 'done') return { ok: true, already: true };
  if (!['approved', 'scheduled', 'pending_approval'].includes(item.status)) {
    throw new Error(`cannot complete an item that is ${item.status}`);
  }
  const patch = {
    status: 'done',
    completed_at: nowIso(),
    completed_by: by,
    completion_note: note ? String(note).slice(0, 500) : item.completion_note,
    next_followup_at: null,
    done_notified_at: null,                // queues "it's finished" to the owner
    updated_at: nowIso(),
  };
  if (actual_cost !== undefined) patch.actual_cost = Number(actual_cost) || null;
  await sbPatch(db, `maintenance_items?id=eq.${id}`, patch);
  return { ok: true };
}

export async function reopenItem(db, id) {
  await sbPatch(db, `maintenance_items?id=eq.${id}`, {
    status: 'approved', completed_at: null, done_notified_at: null,
    next_followup_at: inDays(FOLLOWUP_DAYS), updated_at: nowIso(),
  });
  return { ok: true };
}

// Era said when it'll be ready — wait until then instead of the default
// cadence, and remember the promise so the next nudge can reference it.
export async function snoozeItem(db, id, { untilDate, note, who = 'era' } = {}) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=thread&limit=1`))?.[0];
  if (!item) throw new Error('item not found');
  const thread = [...(item.thread || []), { at: nowIso(), who, text: String(note || '').slice(0, 500) }].slice(-50);
  const patch = { thread, updated_at: nowIso() };
  if (untilDate) {
    // Nudge on the promised morning (WITA ≈ UTC+8, so 01:00Z ≈ 09:00 local).
    patch.promised_date = untilDate;
    patch.next_followup_at = `${untilDate}T01:00:00.000Z`;
  } else {
    patch.next_followup_at = inDays(FOLLOWUP_DAYS);
  }
  await sbPatch(db, `maintenance_items?id=eq.${id}`, patch);
  return { ok: true, next_followup_at: patch.next_followup_at };
}

export async function appendThread(db, id, { who, text }) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&select=thread&limit=1`))?.[0];
  if (!item) return { ok: false };
  const thread = [...(item.thread || []), { at: nowIso(), who, text: String(text || '').slice(0, 500) }].slice(-50);
  await sbPatch(db, `maintenance_items?id=eq.${id}`, { thread, updated_at: nowIso() });
  return { ok: true };
}

// ── Public payload (the no-login /m/<token> page) ───────────────────
export async function publicItem(db, groupKey, id) {
  const item = (await sbGet(db, `maintenance_items?id=eq.${id}&group_key=eq.${encodeURIComponent(groupKey)}&select=*,statement_groups(key,name,owner_names)&limit=1`))?.[0];
  if (!item) return null;
  // Items Era hasn't published yet are internal — the owner sees nothing.
  if (item.status === 'new') return null;
  const withUrls = await withPhotoUrls(db, item);
  return {
    id: item.id,
    group: item.statement_groups || { key: groupKey },
    unit_label: item.unit_label,
    title: item.title,
    description: item.description,
    status: item.status,
    requires_approval: item.requires_approval,
    estimated_cost: item.estimated_cost,
    actual_cost: item.actual_cost,
    currency: item.currency,
    urgency: item.urgency,
    photo_urls: withUrls.photo_urls,
    reported_at: item.reported_at,
    published_at: item.published_at,
    approved_at: item.approved_at,
    declined_at: item.declined_at,
    decline_note: item.decline_note,
    completed_at: item.completed_at,
    completion_note: item.completion_note,
    token: maintenanceToken(groupKey, id),
  };
}

// Every item an owner may see, for the portal's Maintenance tab.
export async function ownerItems(db, groupKeys) {
  if (!groupKeys?.length) return [];
  const list = groupKeys.map(k => `"${k}"`).join(',');
  const rows = (await sbGet(db, `maintenance_items?group_key=in.(${encodeURIComponent(list)})&status=neq.new&select=*,statement_groups(key,name)&order=created_at.desc&limit=200`)) || [];
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    group_key: r.group_key,
    group_name: r.statement_groups?.name || r.group_key,
    unit_label: r.unit_label,
    title: r.title,
    description: r.description,
    status: r.status,
    requires_approval: r.requires_approval,
    estimated_cost: r.estimated_cost,
    actual_cost: r.actual_cost,
    currency: r.currency,
    urgency: r.urgency,
    photo_urls: (await withPhotoUrls(db, r)).photo_urls,
    reported_at: r.reported_at,
    published_at: r.published_at,
    approved_at: r.approved_at,
    completed_at: r.completed_at,
    completion_note: r.completion_note,
    url: `/m/${maintenanceToken(r.group_key, r.id)}`,
  })));
}
