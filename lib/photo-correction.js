// "Yang saya kirim ke dua itu foto di B6": photos already sent belong to
// another villa, and Maya moves them instead of writing it down.
//
// On 9 Sep 2026 Gede sent two pairs of photos while his B2 inspection round
// was open; the round took all four, he wrote two hours later that the
// second pair was B6, and the dispatcher filed that as a note on B2. The
// photos stayed on the wrong unit; the B6 turnover stayed without any.
//
//   parsePhotoCorrection(text, slugs, names) → { slug, which } | null   (pure)
//   splitBatches(rows, gapMs)                → [[row, …], …]           (pure)
//   pickBatch(batches, which)                → rows | null              (pure)
//   movePhotos(db, { person, slug, which, day, names })
//   handlePhotoCorrection({ … })             the dispatcher's handler
//
// A batch is the photos she sent in one go (a gap of two minutes starts the
// next one: Gede's B2 pair and B6 pair were three minutes apart). "ke dua" / "pertama" / "terakhir" / "semua" pick the batch; with
// no word, the most recent one. Maintenance photos (on a ticket) are never
// moved: a fault photo is a fault photo whichever unit's round it came with.

import { resolveUnits } from './housekeeping-schedule.js';
import { hkEvent } from './events.js';
import { closeAsksFor } from './asks.js';

const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const witaDay = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const GAP_MS = 2 * 60e3;

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  return r.ok;
}

const WHICH = [
  [/\b(ke ?dua|kedua|ke-2)\b/i, 'second'],
  [/\b(ke ?tiga|ketiga|ke-3)\b/i, 'third'],
  [/\b(pertama|ke ?satu|ke-1|awal)\b/i, 'first'],
  [/\b(semua|semuanya)\b/i, 'all'],
  [/\b(terakhir|barusan|baru saja|tadi)\b/i, 'last'],
];
// Words that make "foto" + a villa a correction rather than a caption or a
// question: she is talking about photos already sent.
const ABOUT_SENT = /(kirim|tadi|itu|salah|bukan|seharusnya|sebenarnya|maksud|yang|yg|barusan)/i;

export function parsePhotoCorrection(text, slugs = [], names = {}) {
  const t = String(text || '').trim();
  if (!/\bfoto/i.test(t) || !ABOUT_SENT.test(t)) return null;
  if (/\?$/.test(t)) return null;
  const hits = resolveUnits(t, slugs, names);
  if (hits.length !== 1) return null;
  let which = 'last';
  for (const [re, w] of WHICH) if (re.test(t)) { which = w; break; }
  return { slug: hits[0], which };
}

export function splitBatches(rows, gapMs = GAP_MS) {
  const sorted = [...(rows || [])].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  const out = [];
  let last = null;
  for (const r of sorted) {
    const at = Date.parse(r.received_at);
    if (!out.length || at - last > gapMs) out.push([]);
    out[out.length - 1].push(r);
    last = at;
  }
  return out;
}

export function pickBatch(batches, which = 'last') {
  if (!batches.length) return null;
  if (which === 'all') return batches.flat();
  if (which === 'last') return batches[batches.length - 1];
  const i = { first: 0, second: 1, third: 2 }[which];
  return Number.isInteger(i) && batches[i] ? batches[i] : null;
}

// Where a photo sits now, by slug, so a photo already at the villa she
// names is left alone.
async function sourcesOf(db, rows) {
  const ids = (k) => [...new Set(rows.map(r => r[k]).filter(Boolean))];
  const [tasks, rounds, checks] = await Promise.all([
    ids('task_id').length ? sbGet(db, `housekeeping_tasks?id=in.(${ids('task_id').join(',')})&select=id,slug,photos,notes`) : [],
    ids('inspection_id').length ? sbGet(db, `housekeeping_inspections?id=in.(${ids('inspection_id').join(',')})&select=id,slug,photos,task_id`) : [],
    ids('readiness_id').length ? sbGet(db, `housekeeping_readiness?id=in.(${ids('readiness_id').join(',')})&select=id,slug,photos,task_id`) : [],
  ]);
  const by = (list) => Object.fromEntries((list || []).map(x => [x.id, x]));
  return { tasks: by(tasks), rounds: by(rounds), checks: by(checks) };
}

async function pull(db, table, id, path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = (await sbGet(db, `${table}?id=eq.${id}&select=photos&limit=1`))?.[0];
    const have = row?.photos || [];
    if (!have.includes(path)) return true;
    // Only housekeeping_tasks carries updated_at; a column the table lacks
    // fails the whole PATCH and the photo stays (round 85, 11 Sep 2026).
    await sbPatch(db, `${table}?id=eq.${id}`, { photos: have.filter(p => p !== path), ...(table === 'housekeeping_tasks' ? { updated_at: nowIso() } : {}) });
  }
  return false;
}
async function push(db, id, path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = (await sbGet(db, `housekeeping_tasks?id=eq.${id}&select=photos&limit=1`))?.[0];
    const have = row?.photos || [];
    if (have.includes(path)) return have.length;
    await sbPatch(db, `housekeeping_tasks?id=eq.${id}`, { photos: [...have, path], updated_at: nowIso() });
    await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 120)));
    const after = (await sbGet(db, `housekeeping_tasks?id=eq.${id}&select=photos&limit=1`))?.[0];
    if ((after?.photos || []).includes(path)) return after.photos.length;
  }
  return 0;
}

// Her visit at the villa around that day: the clean if there is one, the
// nearest day otherwise. Never a rule-skipped one.
async function visitAt(db, { person, slug, day }) {
  const list = await sbGet(db,
    `housekeeping_tasks?assigned_staff_id=eq.${person.id}&slug=eq.${encodeURIComponent(slug)}&task_date=gte.${plusDays(day, -1)}&task_date=lte.${plusDays(day, 1)}&status=neq.skipped&select=*&limit=10`);
  const dist = (t) => Math.abs(Date.parse(t.task_date) - Date.parse(day));
  return [...(list || [])].sort((a, b) => dist(a) - dist(b) || (a.kind === 'inspection') - (b.kind === 'inspection'))[0] || null;
}

export async function movePhotos(db, { person, slug, which = 'last', day = null, names = {} } = {}) {
  const nm = (s) => names[s] || s;
  const on = day || witaDay(nowIso());
  const from = new Date(`${on}T00:00:00+08:00`).toISOString(), to = new Date(`${plusDays(on, 1)}T00:00:00+08:00`).toISOString();
  const rows = await sbGet(db,
    `staff_photos?wa_num=eq.${digits(person.wa_num)}&received_at=gte.${encodeURIComponent(from)}&received_at=lt.${encodeURIComponent(to)}&status=neq.rejected&item_id=is.null&select=*&order=received_at.asc&limit=60`);
  const batches = splitBatches(rows || []);
  const batch = pickBatch(batches, which);
  if (!batch) return { moved: 0, reason: batches.length ? 'no_such_batch' : 'no_photos', batches: batches.length };
  const src = await sourcesOf(db, batch);
  const placeOf = (r) => r.task_id && src.tasks[r.task_id] ? { table: 'housekeeping_tasks', row: src.tasks[r.task_id] }
    : r.inspection_id && src.rounds[r.inspection_id] ? { table: 'housekeeping_inspections', row: src.rounds[r.inspection_id] }
    : r.readiness_id && src.checks[r.readiness_id] ? { table: 'housekeeping_readiness', row: src.checks[r.readiness_id] } : null;
  const wrong = batch.filter(r => { const p = placeOf(r); return !p || p.row.slug !== slug; });
  if (!wrong.length) return { moved: 0, reason: 'already_there', batches: batches.length };
  const target = await visitAt(db, { person, slug, day: on });
  if (!target) return { moved: 0, reason: 'no_visit', batches: batches.length };
  const fromSlugs = new Set(), fromTasks = new Set(), paths = [];
  for (const r of wrong) {
    const p = placeOf(r);
    if (p) {
      await pull(db, p.table, p.row.id, r.path);
      fromSlugs.add(p.row.slug);
      const tid = p.table === 'housekeeping_tasks' ? p.row.id : p.row.task_id;
      if (tid) fromTasks.add(tid);
    }
    await push(db, target.id, r.path);
    await sbPatch(db, `staff_photos?path=eq.${encodeURIComponent(r.path)}`, {
      status: 'proof', task_id: target.id, inspection_id: null, readiness_id: null,
      decided_at: nowIso(), decided_by: person.name, why: `moved to ${nm(slug)}: ${person.name} said the photos were ${nm(slug)}`,
    });
    paths.push(r.path);
  }
  const fromNames = [...fromSlugs].map(nm).join(', ') || 'unplaced';
  for (const tid of fromTasks) await hkEvent(db, tid, 'photos_moved', { actor: person.name, payload: { to_task: target.id, to_slug: slug, paths } });
  await hkEvent(db, target.id, 'photos_moved', { actor: person.name, payload: { from: [...fromSlugs], paths } });
  const line = `${paths.length} photo${paths.length === 1 ? '' : 's'} moved here from ${fromNames} (${person.name} said they were ${nm(slug)})`;
  await sbPatch(db, `housekeeping_tasks?id=eq.${target.id}`, {
    notes: [target.notes, line].filter(Boolean).join(' · ').slice(0, 500), updated_at: nowIso(),
    thread: [...(target.thread || []), { at: nowIso(), who: 'Maya', text: line }].slice(-50),
  });
  const count = ((await sbGet(db, `housekeeping_tasks?id=eq.${target.id}&select=photos&limit=1`))?.[0]?.photos || []).length;
  if (count >= 2) await closeAsksFor(db, 'housekeeping_task', target.id, { proof: count, moved: true }).catch(() => {});
  return { moved: paths.length, from: [...fromSlugs], to: slug, target_id: target.id, target_date: target.task_date, target_kind: target.kind, batches: batches.length };
}

// The dispatcher's handler. say/tellEra are its own senders.
export async function handlePhotoCorrection({ db, person, body, names = {}, today, slug, which = 'last', say, tellEra }) {
  const nm = (s) => names[s] || s;
  let out;
  try { out = await movePhotos(db, { person, slug, which, day: today, names }); }
  catch (e) { console.warn('photo correction failed:', e.message); return false; }
  if (out.moved) {
    await say(`Siap, ${out.moved} foto tadi saya pindahkan ke ${nm(slug)} ✅`);
    await tellEra(`${person.name}: "${String(body).slice(0, 120)}" — ${out.moved} photo${out.moved === 1 ? '' : 's'} moved from ${out.from.map(nm).join(', ') || 'unplaced'} to ${nm(slug)} (${out.target_kind.replace('_', ' ')} ${out.target_date}).`);
    return true;
  }
  if (out.reason === 'already_there') { await say(`Foto itu memang sudah tercatat di ${nm(slug)} 🙏`); return true; }
  if (out.reason === 'no_visit') {
    await say(`Saya tidak menemukan kunjungan ${nm(slug)} hari ini, jadi fotonya belum bisa saya pindahkan. Saya sampaikan ke Era 🙏`);
    await tellEra(`${person.name}: "${String(body).slice(0, 160)}" — says the photos are ${nm(slug)}, but has no visit there today. Please check.`);
    return true;
  }
  await say(`Foto yang mana ya? Hari ini saya belum menerima foto dari ${person.name.split(' ')[0]} 🙏`);
  return true;
}
