// Put an inspection round's photos on the tickets it raised.
//
// A housekeeper's round arrives as a burst of photos and a few lines of
// text; the lines become tickets, and only the photo sent WITH each line
// is attached to it. When the words and the pictures arrive apart (Ita,
// 5 Sep 2026: seven photos, then "ini ada leking · bagian belakang pintu
// dan dekat sink"), the tickets end up with no photos at all, and the
// owner's "where are the images?" has no answer.
//
// This pass looks at every photo of the round and asks which raised ticket
// it shows, attaching only confident matches. Runs when a round closes, and
// on demand for rounds already filed.

import { signPhotoUrl } from './maintenance.js';
import { classifyPhoto } from './maintenance-intake.js';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

export async function attachInspectionPhotos(db, { inspectionId, itemIds = null, onlyEmpty = true, wa = null } = {}) {
  const insp = (await sbGet(db, `housekeeping_inspections?id=eq.${inspectionId}&select=id,slug,photos,item_ids&limit=1`))?.[0];
  if (!insp) throw new Error('no such inspection');
  const ids = (itemIds?.length ? itemIds : insp.item_ids || []).map(Number).filter(Boolean);
  if (!ids.length || !(insp.photos || []).length) return { inspection: insp.id, attached: {}, looked_at: 0, reason: 'nothing to match' };
  const items = (await sbGet(db, `maintenance_items?id=in.(${ids.join(',')})&select=id,title,photos`)) || [];
  const targets = items.filter(i => !onlyEmpty || !(i.photos || []).length);
  if (!targets.length) return { inspection: insp.id, attached: {}, looked_at: 0, reason: 'tickets already have photos' };
  // The classifier needs at least two choices; "something else" makes the
  // single-ticket case honest rather than forcing every photo onto it.
  const titles = [...targets.map(i => i.title), 'Something else at the villa (not one of the tickets)'];
  const attached = {};
  let looked = 0;
  for (const path of (insp.photos || []).slice(0, 30)) {
    const url = await signPhotoUrl(db, path, 600).catch(() => null);
    if (!url) continue;
    let media = null;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const mime = r.headers.get('content-type') || 'image/jpeg';
      media = { mime: /png/.test(mime) ? 'image/png' : /webp/.test(mime) ? 'image/webp' : 'image/jpeg', base64: Buffer.from(await r.arrayBuffer()).toString('base64') };
    } catch { continue; }
    looked++;
    const verdict = await classifyPhoto(media, titles).catch(() => null);
    if (verdict?.index == null || verdict.index >= targets.length) continue;
    const item = targets[verdict.index];
    (attached[item.id] ||= []).push(path);
  }
  // A model's match is a suggestion, never an attachment: Era confirms each
  // photo with a tap (or ✓ on the Maintenance page) before an owner sees it.
  const { suggest, askEra } = await import('./photo-assign.js');
  const all = new Set();
  for (const [id, paths] of Object.entries(attached)) { await suggest(db, Number(id), paths, { why: 'matched by sight to this ticket', from: 'inspection' }).catch(() => {}); for (const p of paths) all.add(p); }
  if (all.size && wa) {
    const names = await (await import('./housekeeping.js')).catalogNames(db).catch(() => ({}));
    await askEra(db, wa, { items: targets.map(i => ({ id: i.id, title: i.title })), photos: [...all], villa: names[insp.slug] || insp.slug }).catch(() => {});
  }
  return { inspection: insp.id, looked_at: looked, suggested: Object.fromEntries(Object.entries(attached).map(([k, v]) => [k, v.length])) };
}
