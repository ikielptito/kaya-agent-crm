// Readiness: the villa is certified ready by the person who cleaned it, and
// checked by Maya, before a guest walks in.
//
// The failure this exists for (Tropicana A5, 4 Sep 2026): a unit stood
// empty five days, the cleaner washed the muddy sofa cover, and the guest
// arrived to a bare sofa, no soap, a rusty oven and dirty walls. Nobody had
// looked at the unit between the clean and the arrival and nobody upstream
// knew the cover was off. Fourteen villas means Era cannot be the person
// who looks, so:
//
//   1. When a housekeeper taps "Sudah selesai" on a turnover, a pre-arrival
//      or a deep clean, Maya does not just say thanks. She asks for a fixed
//      set of photos — sofa with its cover, kitchen and inside the oven,
//      bathroom with soap in it, bed made, the wall that was dirtiest, the
//      pool furniture, the consumables box — and asks what is running low.
//
//   2. The photos are looked at, all together, by a vision model that is
//      told exactly what each spot should show. It answers per spot: fine,
//      or what is wrong in a few words.
//
//   3. Era hears about the EXCEPTIONS only: a flagged spot, a missing photo,
//      a restock request, or a housekeeper who never sent anything before
//      the guest is due. A pass is silent. On a normal day that is zero to
//      two messages, which is the difference between a system that runs and
//      one that gets muted.
//
// Everything the housekeeper reads is Indonesian. Everything Era reads is
// English. The record is kept either way, so the owner's report and the
// per-housekeeper numbers are built from what actually happened.

import { uploadPhoto, signPhotoUrl } from './maintenance.js';
import { fetchMediaBase64 } from './maintenance-staff.js';
import { getSettingValue } from './campaigns.js';
import { staffByWa } from './staff.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) });
}
async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return null; }
}
async function notifyEra(wa, line) {
  const era = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  if (!era) return;
  await sendText(wa, era, line).catch(() => {});
}

// ── The standard ────────────────────────────────────────────────────
// Portfolio default in settings.housekeeping_standard, overridden per villa
// by unit_standards. Shipped in code too, so a database where the migration
// has not run yet still asks for photos rather than for nothing.
export const DEFAULT_STANDARD = {
  kit: [
    { key: 'kettle', label: 'Kettle' },
    { key: 'microwave', label: 'Microwave' },
    { key: 'mirror', label: 'Full-length mirror' },
    { key: 'iron', label: 'Iron and ironing board' },
    { key: 'towel_rack', label: 'Towel rack or ladder' },
    { key: 'drying_rack', label: 'Drying rack by the pool' },
    { key: 'hairdryer', label: 'Hairdryer' },
    { key: 'sofa_covers', label: 'Spare set of sofa covers' },
    { key: 'dispenser', label: 'Water dispenser, hot and cold, sanitised sticker dated' },
    { key: 'pool_cushions', label: 'Pool furniture cushions clean, no mould' },
  ],
  consumables: [
    { key: 'hand_soap', label: 'Hand soap (bathroom and kitchen)', par: 2 },
    { key: 'shower_gel', label: 'Shower gel', par: 1 },
    { key: 'shampoo', label: 'Shampoo', par: 1 },
    { key: 'dish_soap', label: 'Dish soap and sponge', par: 1 },
    { key: 'kitchen_roll', label: 'Kitchen roll or napkins', par: 2 },
    { key: 'toilet_roll', label: 'Toilet roll', par: 4 },
    { key: 'bin_bags', label: 'Bin bags', par: 10 },
    { key: 'water', label: 'Dispenser gallon plus 2 sealed bottles', par: 1 },
  ],
  photo_spots: [
    { key: 'living', id: 'ruang tamu (sofa dengan sarungnya)', en: 'Living room, sofa with its cover on' },
    { key: 'kitchen', id: 'dapur (meja, kompor, dan bagian dalam oven kalau ada)', en: 'Kitchen: counter, hob, and inside the oven if there is one' },
    { key: 'bathroom', id: 'kamar mandi (sabun dan sabun mandi terisi)', en: 'Bathroom with soap and shower gel stocked' },
    { key: 'bedroom', id: 'kamar tidur (tempat tidur sudah rapi)', en: 'Bedroom, bed made' },
    { key: 'walls', id: 'dinding yang paling kotor sebelumnya', en: 'The wall that was dirtiest' },
    { key: 'pool', id: 'area kolam dan kursinya', en: 'Pool area and its furniture' },
    { key: 'box', id: 'kotak perlengkapan (sabun, tisu, kantong sampah)', en: 'The consumables box' },
  ],
};

// What the deep clean is, in the housekeeper's language and in Era's. Sent
// as the task detail so the morning message says what "deep clean" means
// rather than leaving it to be guessed.
export const DEEP_CLEAN_ID = 'pembersihan menyeluruh: lap semua dinding dan lis, bagian dalam oven (kalau ada), kaca luar termasuk lantai atas, nat kamar mandi, bantal kolam dicuci, dispenser dibersihkan';
export const DEEP_CLEAN_EN = 'Deep clean: all walls and skirting, inside the oven if there is one, exterior windows including upstairs, bathroom grout, pool cushions washed, dispenser sanitised';

export async function standardFor(db, slug) {
  const base = { ...DEFAULT_STANDARD, ...((await getSettingValue(db, 'housekeeping_standard').catch(() => null)) || {}) };
  const row = slug ? (await sbGet(db, `unit_standards?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`))?.[0] : null;
  // The villa's kit row carries the audit (present true/false/null per
  // item); its keys are aligned to the default so a new default item shows
  // up as "not audited" rather than vanishing.
  const kitBy = Object.fromEntries((row?.kit || []).map(k => [k.key, k]));
  const kit = base.kit.map(k => ({ ...k, present: kitBy[k.key]?.present ?? null, note: kitBy[k.key]?.note || null }));
  for (const k of (row?.kit || [])) if (!kitBy[k.key] || !base.kit.some(b => b.key === k.key)) kit.push(k);
  return {
    slug,
    kit,
    consumables: row?.consumables?.length ? row.consumables : base.consumables,
    photo_spots: [...base.photo_spots, ...(row?.photo_spots || [])],
    notes: row?.notes || null,
    audited_at: row?.audited_at || null,
    audited_by: row?.audited_by || null,
  };
}

// ── Opening a check ─────────────────────────────────────────────────
// Called by the cleaning-reply handler when a housekeeper closes a task of a
// kind that needs certifying. Returns the Indonesian ask, or null when this
// kind is not checked (a regular clean is not).
export async function openReadiness(db, { task, person, villa }) {
  const cfg = (await getSettingValue(db, 'housekeeping').catch(() => null)) || {};
  const kinds = Array.isArray(cfg.readiness_kinds) ? cfg.readiness_kinds : ['turnover', 'pre_arrival', 'deep_clean'];
  if (!kinds.includes(task.kind)) return null;
  // A turnover with nobody coming behind it is a clean, not a handover; the
  // regular rhythm covers it and the photo round would be noise.
  if (task.kind === 'turnover' && !task.guest_in_date) return null;

  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_readiness?on_conflict=task_id`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      task_id: task.id, slug: task.slug, kind: task.kind,
      guest_in_date: task.guest_in_date || null, by_staff_id: person?.id ?? null,
      status: 'awaiting', asked_at: nowIso(),
    }),
  });
  if (!r.ok) return null;
  const std = await standardFor(db, task.slug);
  const spots = std.photo_spots.map((s, i) => `${i + 1}. ${s.id}`).join('\n');
  return `Terima kasih! Sebelum tamu datang, tolong kirim foto ${villa}:\n${spots}\n\nKalau ada yang hampir habis (sabun, tisu, air galon), tulis saja di sini. Setelah semua foto terkirim, balas "selesai".`;
}

// ── Her photos and her "selesai" ────────────────────────────────────
// Claims the message only while this person has a check open, and only for
// a day, so ordinary chat is never swallowed and yesterday's forgotten
// check does not eat today's inspection photos.
export async function handleReadiness({ db, wa, fromNum, text, mediaType, mediaId, waToken }) {
  const person = await staffByWa(db, fromNum);
  if (!person || !person.active) return false;
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const open = (await sbGet(db,
    `housekeeping_readiness?by_staff_id=eq.${person.id}&status=eq.awaiting&asked_at=gte.${encodeURIComponent(since)}`
    + `&select=*&order=asked_at.desc&limit=1`))?.[0];
  if (!open) return false;

  const body = String(text || '').trim();
  const hasImage = mediaType === 'image' && !!mediaId;
  if (!hasImage && !body) return false;

  const villa = await villaName(db, open.slug);

  if (!hasImage && /^\s*(sudah|selesai|beres|done|udah|kelar|siap|semua sudah)\b[\s.!👍✅]*$/i.test(body)) {
    await closeReadiness(db, wa, { rec: open, person, fromNum, villa, waToken });
    return true;
  }

  if (hasImage) {
    try {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media?.base64) {
        const path = await uploadPhoto(db, `readiness/${open.slug}/${witaToday()}`, {
          base64: media.base64, contentType: media.mime || 'image/jpeg',
        });
        const cur = (await sbGet(db, `housekeeping_readiness?id=eq.${open.id}&select=photos&limit=1`))?.[0];
        const photos = [...(cur?.photos || []), path];
        await sbPatch(db, `housekeeping_readiness?id=eq.${open.id}`, { photos });
        if (photos.length === 1) {
          await sendText(wa, fromNum, `Foto pertama masuk. Kirim sisanya, lalu balas "selesai".`);
        }
      }
    } catch { /* a lost photo must not lose the check */ }
    // A caption on a photo is still a restock note.
    if (body) await noteRestock(db, open, body);
    return true;
  }

  // Plain text while a check is open: what is running low, or a remark.
  await noteRestock(db, open, body);
  await sendText(wa, fromNum, `Dicatat. Kirim fotonya juga ya, lalu balas "selesai".`);
  return true;
}

async function noteRestock(db, rec, line) {
  const cur = (await sbGet(db, `housekeeping_readiness?id=eq.${rec.id}&select=restock&limit=1`))?.[0];
  await sbPatch(db, `housekeeping_readiness?id=eq.${rec.id}`, {
    restock: [cur?.restock, line].filter(Boolean).join(' · ').slice(0, 500),
  });
}

async function closeReadiness(db, wa, { rec, person, fromNum, villa, waToken }) {
  const fresh = (await sbGet(db, `housekeeping_readiness?id=eq.${rec.id}&select=*&limit=1`))?.[0] || rec;
  const cfg = (await getSettingValue(db, 'housekeeping').catch(() => null)) || {};
  const minPhotos = parseInt(cfg.readiness_min_photos, 10) || 4;
  const std = await standardFor(db, fresh.slug);
  const photos = fresh.photos || [];

  let checks = [];
  let verdict = null;
  if (photos.length) verdict = await assessPhotos(db, { photos, spots: std.photo_spots, villa }).catch(() => null);
  if (verdict?.checks) checks = verdict.checks;

  const flags = [];
  if (photos.length < minPhotos) flags.push(`only ${photos.length} photo${photos.length === 1 ? '' : 's'} sent (${minPhotos} expected)`);
  for (const c of checks) if (c.ok === false) flags.push(`${c.spot}: ${c.note || 'not right'}`);
  if (verdict?.missing?.length) flags.push(`not photographed: ${verdict.missing.join(', ')}`);
  if (fresh.restock) flags.push(`restock: ${fresh.restock}`);

  const status = flags.length ? 'flagged' : 'pass';
  await sbPatch(db, `housekeeping_readiness?id=eq.${fresh.id}`, {
    status, checks, flags, closed_at: nowIso(),
  });
  if (fresh.task_id) {
    await sbPatch(db, `housekeeping_tasks?id=eq.${fresh.task_id}`, { photos, updated_at: nowIso() });
  }

  // The housekeeper hears the result in her language, and hears what to fix
  // now while she is still standing there, which is the whole point.
  const fixes = checks.filter(c => c.ok === false && c.fix_id).map(c => `• ${c.fix_id}`);
  if (fixes.length) {
    await sendText(wa, fromNum, `Terima kasih. Sebelum pulang, tolong periksa lagi:\n${fixes.join('\n')}\n\nKalau sudah, foto lagi bagian itu.`);
  } else {
    await sendText(wa, fromNum, `Terima kasih, ${villa} sudah dicatat siap${photos.length ? ` dengan ${photos.length} foto` : ''}. 🙏`);
  }

  // Era hears only about exceptions.
  if (flags.length) {
    const when = fresh.guest_in_date ? ` Guest arrives ${fresh.guest_in_date}.` : '';
    await notifyEra(wa, `Readiness check — ${villa} (${person?.name || 'housekeeper'}):\n• ${flags.join('\n• ')}${when}\nPhotos are on the Schedule page.`);
    await sbPatch(db, `housekeeping_readiness?id=eq.${fresh.id}`, { era_notified_at: nowIso() });
  }
  return true;
}

// ── The vision check ────────────────────────────────────────────────
// All the photos in one call, with the list of what was asked for. Per spot:
// ok, or what is wrong in a few words in English for Era and Indonesian for
// the housekeeper. Conservative on purpose: a bare sofa, a visibly dirty
// wall, an empty soap holder and a rusty oven are the things to catch; a
// slightly crooked cushion is not, and a model that flags everything is a
// model everyone learns to ignore.
async function assessPhotos(db, { photos, spots, villa }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const imgs = [];
  for (const p of photos.slice(0, 10)) {
    const url = await signPhotoUrl(db, p, 600).catch(() => null);
    if (!url) continue;
    const r = await fetch(url).catch(() => null);
    if (!r?.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
    imgs.push({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
  }
  if (!imgs.length) return null;

  const list = spots.map((s, i) => `${i + 1}. ${s.key}: ${s.en}`).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MAINTENANCE_VISION_MODEL || 'claude-sonnet-4-6',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: [
          ...imgs,
          { type: 'text', text:
`These are handover photos from a housekeeper at a Bali rental villa (${villa}), taken after cleaning, before a guest arrives. She was asked to photograph:
${list}

Not every villa has every feature: a kitchen with a hob and no oven, a terrace instead of a pool. Judge what is there; a hob or microwave photo satisfies the kitchen spot when there is no oven, and never flag a feature as dirty or missing when the villa evidently does not have it. Only list a spot as missing when a room the guest will use is clearly absent from the photos.

For each spot that appears in the photos, judge whether it is guest-ready. Flag ONLY clear problems a guest would complain about on day one: a sofa with no cover, visibly dirty or stained walls, an empty soap or shower-gel holder, a rusty or dirty oven interior, bird droppings on windows, dirty or mouldy pool cushions, an unmade bed, a consumables box that is empty or nearly empty, obvious rubbish or mess. Do not flag minor untidiness, lighting, or things you cannot see.

Reply with ONLY JSON:
{"checks":[{"spot":"<key>","ok":true|false,"note":"<at most 10 words, English, empty if ok>","fix_id":"<at most 12 words, Indonesian, what to do now, empty if ok>"}],
 "missing":["<key of any spot not shown in any photo>"]}` },
        ],
      }],
    }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const out = JSON.parse(m[0]);
  const keys = new Set(spots.map(s => s.key));
  return {
    checks: (out.checks || []).filter(c => keys.has(c.spot)).map(c => ({
      spot: c.spot, ok: c.ok !== false, note: c.ok === false ? String(c.note || '').slice(0, 120) : '',
      fix_id: c.ok === false ? String(c.fix_id || '').slice(0, 160) : '',
    })),
    missing: (out.missing || []).filter(k => keys.has(k)),
  };
}

// ── The check nobody answered ───────────────────────────────────────
// A housekeeper who said "done" and then sent nothing is the case the whole
// thing exists for. After the timeout, or by the evening before an arrival,
// Era is told and the record is closed as unchecked — which the numbers
// count against the villa and the person, because "we do not know" is not
// the same as "it was fine".
export async function readinessSweep({ db, wa, now = new Date() } = {}) {
  const cfg = (await getSettingValue(db, 'housekeeping').catch(() => null)) || {};
  const hours = parseInt(cfg.readiness_timeout_hours, 10) || 20;
  const cutoff = new Date(now.getTime() - hours * 3600e3).toISOString();
  const today = new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const stale = (await sbGet(db,
    `housekeeping_readiness?status=eq.awaiting&or=(asked_at.lte.${encodeURIComponent(cutoff)},guest_in_date.lte.${plusDays(today, 1)})`
    + `&select=*,staff:by_staff_id(name)&limit=50`)) || [];
  let told = 0;
  for (const rec of stale) {
    // Give a same-day ask until the evening: she may still be there.
    if (rec.asked_at > cutoff && rec.guest_in_date && rec.guest_in_date > today) continue;
    const photos = rec.photos || [];
    const villa = await villaName(db, rec.slug);
    const line = photos.length
      ? `Readiness check — ${villa}: ${rec.staff?.name || 'the housekeeper'} sent ${photos.length} photo${photos.length === 1 ? '' : 's'} but never said "selesai".`
      : `Readiness check — ${villa}: ${rec.staff?.name || 'the housekeeper'} said the clean was done but sent no photos.`;
    const when = rec.guest_in_date ? ` Guest arrives ${rec.guest_in_date}.` : '';
    await notifyEra(wa, `${line}${when} Worth a call before the guest gets there.`);
    await sbPatch(db, `housekeeping_readiness?id=eq.${rec.id}`, {
      status: photos.length ? 'flagged' : 'unchecked',
      flags: [photos.length ? 'photos sent, never closed' : 'no photos sent'],
      closed_at: nowIso(), era_notified_at: nowIso(),
    });
    told++;
  }
  return { checked: stale.length, told };
}

// ── For the Schedule page and the numbers ───────────────────────────
export async function readinessForWindow(db, { from, to }) {
  const rows = (await sbGet(db,
    `housekeeping_readiness?asked_at=gte.${from}T00:00:00Z&asked_at=lte.${to}T23:59:59Z`
    + `&select=id,task_id,slug,kind,guest_in_date,by_staff_id,status,flags,restock,photos,checks,asked_at,closed_at&order=asked_at.desc&limit=300`)) || [];
  return rows.map(r => ({ ...r, photo_count: (r.photos || []).length }));
}

// Per housekeeper, the last N days: visits done on the day they were set,
// checks passed, checks flagged, checks never answered. This is the
// accountability Ikiel asked for, kept as counts that can be read out at a
// monthly sit-down rather than as a score nobody agreed to.
export async function housekeeperStats(db, { days = 30 } = {}) {
  const from = plusDays(witaToday(), -days);
  const tasks = (await sbGet(db,
    `housekeeping_tasks?task_date=gte.${from}&task_date=lte.${witaToday()}&assigned_staff_id=not.is.null`
    + `&select=id,slug,kind,status,task_date,origin_date,done_at,assigned_staff_id,staff:assigned_staff_id(id,name)&limit=1000`)) || [];
  const checks = (await sbGet(db,
    `housekeeping_readiness?asked_at=gte.${from}T00:00:00Z&select=by_staff_id,status,flags,slug&limit=1000`)) || [];
  const by = new Map();
  const bucket = (id, name) => {
    if (!by.has(id)) by.set(id, { staff_id: id, name, visits: 0, done: 0, done_on_day: 0, skipped: 0, checks: 0, pass: 0, flagged: 0, unchecked: 0, villas: new Set() });
    return by.get(id);
  };
  for (const t of tasks) {
    const b = bucket(t.assigned_staff_id, t.staff?.name || `#${t.assigned_staff_id}`);
    b.visits++; b.villas.add(t.slug);
    if (t.status === 'done') {
      b.done++;
      const doneDay = t.done_at ? new Date(new Date(t.done_at).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : null;
      if (!doneDay || doneDay <= t.task_date) b.done_on_day++;
    }
    if (t.status === 'skipped') b.skipped++;
  }
  for (const c of checks) {
    if (!c.by_staff_id) continue;
    const b = bucket(c.by_staff_id, by.get(c.by_staff_id)?.name || `#${c.by_staff_id}`);
    b.checks++;
    if (c.status === 'pass') b.pass++;
    else if (c.status === 'flagged') b.flagged++;
    else if (c.status === 'unchecked') b.unchecked++;
  }
  return [...by.values()].map(b => ({ ...b, villas: [...b.villas].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function villaName(db, slug) {
  try {
    const { catalogNames } = await import('./housekeeping.js');
    return (await catalogNames(db))[slug] || slug;
  } catch { return slug; }
}
