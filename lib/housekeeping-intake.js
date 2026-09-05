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

export async function handleCleaningReply({ db, wa, fromNum, text, buttonPayload = null }) {
  const body = String(text || '').trim();
  const tapped = BUTTON_INTENT[String(buttonPayload || '').trim().toLowerCase()] || null;
  if (!body && !tapped) return false;

  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;

  const today = witaToday();
  const from = new Date(Date.parse(today) - 2 * 86400e3).toISOString().slice(0, 10);
  const open = (await sbGet(db,
    `housekeeping_tasks?assigned_staff_id=eq.${person.id}&kind=neq.inspection`
    + `&task_date=gte.${from}&task_date=lte.${plusDays(today, 2)}&status=in.(notified,confirmed)`
    + `&select=*&order=task_date.asc&limit=1`))?.[0];
  if (!open) return false;

  const villa = await villaName(db, open.slug);

  if (tapped === 'done' || /^\s*(sudah|selesai|beres|done|udah|kelar|siap)\b[\s.!👍✅]*$/i.test(body)) {
    await sbPatch(db, `housekeeping_tasks?id=eq.${open.id}`, {
      status: 'done', done_at: nowIso(), updated_at: nowIso(),
    });
    // A handover is not finished when she says so; it is finished when the
    // photos say so. Turnovers with a guest behind them, pre-arrivals and
    // deep cleans get the readiness ask instead of a plain thank-you.
    try {
      const { openReadiness } = await import('./housekeeping-readiness.js');
      const ask = await openReadiness(db, { task: open, person, villa });
      if (ask) { await sendText(wa, fromNum, ask); return true; }
    } catch { /* the thank-you below still goes out */ }
    await sendText(wa, fromNum, `Terima kasih, ${villa} sudah dicatat selesai.`);
    return true;
  }

  // A tap carries no prose to parse, so the intent is already known and the
  // model is skipped entirely. "Besok saja" means exactly tomorrow.
  const parsed = tapped === 'tomorrow' ? { intent: 'move', date: plusDays(today, 1) }
    : tapped === 'cannot' ? { intent: 'cannot' }
    : await (await import('./maintenance-intake.js')).parseCleaningReply(body, { villa });

  if (parsed.intent === 'move' && parsed.date && parsed.date !== open.task_date) {
    await sbPatch(db, `housekeeping_tasks?id=eq.${open.id}`, {
      task_date: parsed.date, status: 'planned', notified_at: null,
      moved_by: person.name, moved_at: nowIso(), updated_at: nowIso(),
      thread: [...(open.thread || []), { at: nowIso(), who: person.name, text: body || 'Tapped "Besok saja"' }].slice(-50),
    });
    await sendText(wa, fromNum, `Baik, ${villa} dipindah ke ${dayLabelId(parsed.date)}. Saya ingatkan lagi nanti.`);
    await notifyEra(db, wa, `${person.name} moved the ${open.kind.replace('_', ' ')} at ${villa} to ${parsed.date}${body ? `: "${body}"` : ' (tapped Besok saja)'}`);
    return true;
  }

  if (parsed.intent === 'cannot') {
    // She cannot do it and named no alternative. Era has to reassign or
    // agree a day, so this is escalated rather than guessed at.
    await sbPatch(db, `housekeeping_tasks?id=eq.${open.id}`, {
      notes: [open.notes, body || 'Tapped "Tidak bisa"'].filter(Boolean).join(' · ').slice(0, 500), updated_at: nowIso(),
    });
    await sendText(wa, fromNum, `Baik, saya kabari Era ya. Terima kasih sudah memberi tahu.`);
    await notifyEra(db, wa, `${person.name} cannot do the ${open.kind.replace('_', ' ')} at ${villa}: ${body ? `"${body}"` : 'tapped Tidak bisa'}`);
    return true;
  }

  return false;
}

const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
// The webhook substitutes a bracketed instruction for a captionless image.
// Nothing a housekeeper types starts with "[Agent sent".
export const realText = (t) => {
  const s = String(t || '').trim();
  return /^\[(agent|guest|user) sent an? /i.test(s) || /^\[.*\]$/.test(s) && /image|photo|audio|video|document|sticker/i.test(s) ? '' : s;
};
const dayLabelId = (d) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// Era hears about it as free text. Her window is almost always open — she is
// in Maya's chat all day — and if it is shut this is a nicety, not a work
// order, so a silent failure costs nothing.
async function notifyEra(db, wa, line) {
  const era = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  if (!era) return;
  await sendText(wa, era, line).catch(() => {});
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

  const hasImage = mediaType === 'image' && !!mediaId;
  // An image with no caption reaches us with the sales-side placeholder as
  // its text. That is a prompt for Maya, not a finding: recorded once, it
  // went straight onto an owner's weekly report.
  const body = realText(text);

  // "sudah" / "selesai" with no photo closes the round.
  if (!hasImage && /^\s*(sudah|selesai|beres|done|udah|kelar|semua bagus|semua ok|semua oke|semua aman|aman semua|aman)\b/i.test(body)) {
    await closeRound(db, wa, { task: open, person, fromNum, findings: body });
    return true;
  }
  if (!hasImage && !body) return false;

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
        lastPath = path;
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
    // The villa is known — it is the one the round is at — so the owner
    // group is looked up by slug, never guessed from her words. Two A5
    // findings were filed under A4 on 5 Sep by a text match.
    const groups = (await sbGet(db, `statement_groups?active=is.true&select=key,name,listing_slugs`)) || [];
    const own = groups.find(g => (g.listing_slugs || []).includes(open.slug));
    const matched = own ? { group_key: own.key, group: own, slug: open.slug } : await matchProperty(db, `${open.slug} ${body}`);
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
          // The photo she sent with the words is the evidence; the ticket
          // should carry it, not only the round.
          if (lastPath) await attachPhotoPaths(db, item.id, [lastPath]).catch(() => {});
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
