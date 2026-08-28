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

import { maintenanceToken } from './tokens.js';

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
export async function isReporter(db, waNum) {
  const n = digits(waNum);
  if (!n) return null;
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
// "saturno". Match her words against the statement groups and their unit
// slugs, scoring specific-unit hits above whole-group hits.
export async function matchProperty(db, text) {
  const groups = (await sbGet(db, 'statement_groups?active=is.true&select=key,name,listing_slugs,owner_names')) || [];
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = new Set(norm(hay).split(' ').filter(Boolean));

  let best = null;
  for (const g of groups) {
    for (const slug of (g.listing_slugs || [])) {
      // "haus-2" → tokens [haus, 2]; every token must appear in the message.
      const toks = norm(slug).split(' ').filter(Boolean);
      if (toks.length && toks.every(t => words.has(t))) {
        const score = 100 + toks.length;
        if (!best || score > best.score) best = { score, group_key: g.key, slug, unit_label: slug, group: g };
      }
    }
    // Whole-group fallback: enough of the group's NAME words appear.
    const nameToks = norm(g.name).split(' ').filter(w => w.length > 2);
    const hits = nameToks.filter(t => words.has(t)).length;
    if (hits >= Math.max(1, Math.ceil(nameToks.length / 2))) {
      const score = 10 + hits;
      if (!best || score > best.score) best = { score, group_key: g.key, slug: null, unit_label: null, group: g };
    }
  }
  return best;
}

// ── Photos ──────────────────────────────────────────────────────────
export async function savePhoto(db, itemId, { base64, contentType }) {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(String(contentType || ''))) throw new Error('photo must be jpeg/png/webp');
  const bytes = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!bytes.length) throw new Error('empty upload');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('image too large');
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  const path = `${itemId}/${Date.now()}.${ext}`;
  const r = await fetch(`${db.SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: db.sbHeaders.Authorization, apikey: db.sbHeaders.apikey,
      'Content-Type': contentType, 'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`photo upload → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const item = (await sbGet(db, `maintenance_items?id=eq.${itemId}&select=photos&limit=1`))?.[0];
  const photos = [...(item?.photos || []), path];
  await sbPatch(db, `maintenance_items?id=eq.${itemId}`, { photos, updated_at: nowIso() });
  return path;
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
    reported_by_wa: digits(fields.reported_by_wa) || null,
    reported_by_name: fields.reported_by_name || null,
    status: 'new',
    thread: fields.thread || [],
  };
  return sbInsert(db, 'maintenance_items', row);
}

export async function listItems(db, { group_key, status, open_only } = {}) {
  let q = 'maintenance_items?select=*,statement_groups(key,name,owner_names,notify,owner_wa_nums)&order=created_at.desc&limit=500';
  if (group_key) q += `&group_key=eq.${encodeURIComponent(group_key)}`;
  if (status) q += `&status=eq.${encodeURIComponent(status)}`;
  if (open_only) q += '&status=neq.done';
  const rows = (await sbGet(db, q)) || [];
  // The signed link is what the admin's "Preview owner view" opens.
  return rows.map(r => ({ ...r, token: maintenanceToken(r.group_key, r.id) }));
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
