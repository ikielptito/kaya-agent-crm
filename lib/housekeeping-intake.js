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

import { uploadPhoto, createItem, matchProperty, appendThread } from './maintenance.js';
import { fetchMediaBase64 } from './maintenance-staff.js';
import { looksLikeMaintenance, extractReports } from './maintenance-intake.js';
import { staffByWa } from './staff.js';

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
async function attachInspectionPhoto(db, inspectionId, path) {
  const row = (await sbGet(db, `housekeeping_inspections?id=eq.${inspectionId}&select=photos&limit=1`))?.[0];
  const photos = [...(row?.photos || []), path];
  await sbPatch(db, `housekeeping_inspections?id=eq.${inspectionId}`, { photos });
  return photos.length;
}

export async function handleInspection({ db, wa, fromNum, text, mediaType, mediaId, waToken }) {
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;

  // Is a round actually open for this person right now? Yesterday's round is
  // included because a housekeeper asked at 9am often walks the villa in the
  // afternoon and sends the photos that evening or the next morning.
  const today = witaToday();
  const yesterday = new Date(Date.parse(today) - 86400e3).toISOString().slice(0, 10);
  const open = (await sbGet(db,
    `housekeeping_tasks?kind=eq.inspection&assigned_staff_id=eq.${person.id}`
    + `&task_date=gte.${yesterday}&task_date=lte.${today}&status=in.(notified,confirmed)`
    + `&select=*&order=task_date.desc&limit=1`))?.[0];
  if (!open) return false;

  const body = String(text || '').trim();
  const hasImage = mediaType === 'image' && !!mediaId;

  // "sudah" / "selesai" with no photo closes the round.
  if (!hasImage && /^\s*(sudah|selesai|beres|done|udah|kelar|semua bagus|aman)\b/i.test(body)) {
    await closeRound(db, wa, { task: open, person, fromNum, findings: body });
    return true;
  }
  if (!hasImage && !body) return false;

  const insp = await openInspection(db, { slug: open.slug, taskId: open.id, staffId: person.id });
  if (!insp) return false;

  let count = (insp.photos || []).length;
  if (hasImage) {
    try {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media?.base64) {
        const path = await uploadPhoto(db, `inspection/${open.slug}/${today}`, {
          base64: media.base64, contentType: media.mime || 'image/jpeg',
        });
        count = await attachInspectionPhoto(db, insp.id, path);
      }
    } catch { /* a failed photo must not lose the round */ }
  }

  // Anything she writes is recorded as a finding, unconditionally. Whether it
  // ALSO becomes a work order is a separate question, and the two were once
  // tangled together: a fault reported at a Tropicana unit was silently
  // dropped, because those units belong to no statement group, so
  // matchProperty returned null and the finding fell through every branch.
  // Losing a housekeeper's report of mould is the worst thing this module
  // could do, so the write happens first and never depends on the matcher.
  let raised = [];
  if (body) {
    await sbPatch(db, `housekeeping_inspections?id=eq.${insp.id}`, {
      findings: [insp.findings, body].filter(Boolean).join(' · ').slice(0, 1000),
    });
  }

  if (body && looksLikeMaintenance(body, hasImage)) {
    const matched = await matchProperty(db, `${open.slug} ${body}`);
    if (matched?.group_key) {
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
    await sendText(wa, fromNum, `Terima kasih, sudah saya catat sebagai laporan perbaikan. Kalau ada lagi, foto saja.`);
  } else if (count === 1) {
    await sendText(wa, fromNum, `Terima kasih. Fotonya sudah masuk untuk ${await villaName(db, open.slug)}. Kirim saja sisanya, lalu balas "selesai" kalau sudah semua.`);
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
  const n = (insp?.photos || []).length;
  await sendText(wa, fromNum,
    n ? `Terima kasih, pemeriksaan ${await villaName(db, task.slug)} sudah selesai dengan ${n} foto. Laporannya saya teruskan ke pemilik villa.`
      : `Terima kasih, sudah saya catat pemeriksaan ${await villaName(db, task.slug)} pada ${on}.`);
  return true;
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
