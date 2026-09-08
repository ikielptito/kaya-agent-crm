// Closing the gaps in the record, by asking the person who was there.
//
// Twenty-six of sixty visits in the first two weeks ended as "not
// confirmed": sent in the morning, never answered, never chased past the
// day. Some of those cleans happened and some did not, and the record
// cannot tell them apart. Era used to guess; from 8 Sep 2026 Maya asks the
// housekeeper, one visit at a time, with three buttons:
//
//   Sudah        → done, recorded as "reported later" (a late self-report
//                  is weaker evidence than a same-day tap, and is stored as
//                  such — see housekeeping-records evidence)
//   Tidak        → not done, and Era hears
//   Tidak ingat  → left unconfirmed, noted
//
// A past inspection round gets a different pair: Besok (moved to tomorrow)
// or Tidak bisa (Era arranges it). Five visits per person per run, only to
// a phone whose 24-hour window is open (interactive messages need it), and
// never twice for the same visit. Runs from the hourly beat at 10:00 WITA
// — an hour after the morning tasks, so yesterday's gap is asked about
// while the day is fresh — and on demand from the console.

import { sendButtons, sendText } from './wa-interactive.js';
import { recordAsk, openAsks } from './asks.js';
import { hkEvent } from './events.js';
import { channels as staffChannels } from './staff-channel.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';
import { coach } from './coaching.js';

const nowIso = () => new Date().toISOString();
const witaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const digits = (n) => String(n || '').replace(/\D/g, '');
const KIND_ID = { regular: 'bersih-bersih rutin', turnover: 'bersih-bersih setelah tamu check out', pre_arrival: 'persiapan sebelum tamu datang', deep_clean: 'pembersihan menyeluruh', inspection: 'pemeriksaan rutin dengan foto' };
const dayId = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const STATE_KEY = 'housekeeping_backfill';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}
async function logOut(db, { waNum, content, mid }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: waNum, direction: 'outbound', content, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'cron', category: 'housekeeping', status: mid ? 'sent' : 'failed' }),
  }).catch(() => {});
}
async function windowOpen(db, num) {
  const since = new Date(Date.now() - 23.5 * 3600e3).toISOString();
  return !!((await sbGet(db, `wa_messages?wa_num=eq.${num}&direction=eq.inbound&timestamp=gte.${encodeURIComponent(since)}&select=id&limit=1`)) || []).length;
}

// Pure: what to ask whom.
export function planBackfill({ tasks, today, asked = new Set(), perPerson = 5, days = 14 }) {
  const from = plusDays(today, -days);
  const out = new Map();
  for (const t of tasks) {
    if (!t.staff?.wa_num || !t.staff.active) continue;
    if (t.task_date >= today || t.task_date < from) continue;
    if (!['notified', 'confirmed'].includes(t.status)) continue;
    if (asked.has(t.id)) continue;
    const num = digits(t.staff.wa_num);
    if (!out.has(num)) out.set(num, { to: num, staff: t.staff, tasks: [] });
    const g = out.get(num);
    if (g.tasks.length < perPerson) g.tasks.push(t);
  }
  return [...out.values()];
}

export function askText(task, name, today) {
  const day = task.task_date === plusDays(today, -1) ? 'Kemarin' : dayId(task.task_date);
  const villa = name(task.slug);
  if (task.kind === 'inspection') return `${day} ada jadwal pemeriksaan rutin dengan foto di ${villa}, tapi belum ada fotonya. Masih bisa dikerjakan?`;
  return `${day} — ${villa}, ${KIND_ID[task.kind] || 'bersih-bersih'}: sudah dikerjakan? Ini untuk catatan pemilik villa 🙏`;
}
export function askButtons(task) {
  if (task.kind === 'inspection') return [{ id: `hk:move:${task.id}`, title: 'Besok' }, { id: `hk:notdone:${task.id}`, title: 'Tidak bisa' }];
  return [{ id: `hk:done:${task.id}`, title: 'Sudah' }, { id: `hk:notdone:${task.id}`, title: 'Tidak' }, { id: `hk:unsure:${task.id}`, title: 'Tidak ingat' }];
}

export async function runBackfill({ db, wa, now = new Date(), preview = false, force = false, only = null, hour: hourOverride = null, catalogNames = {} } = {}) {
  const wita = new Date(now.getTime() + 8 * 3600e3);
  const today = wita.toISOString().slice(0, 10);
  const hour = hourOverride != null ? hourOverride : wita.getUTCHours();
  const cfg = (await getSettingValue(db, 'housekeeping').catch(() => null)) || {};
  const askHour = Number.isFinite(+cfg.backfill_hour) ? +cfg.backfill_hour : 10;
  const state = (await getSettingValue(db, STATE_KEY).catch(() => null)) || {};
  if (!force && !preview && (hour < askHour || state.day === today)) return { skipped: state.day === today ? 'already ran today' : `before ${askHour}:00`, today, hour };

  const from = plusDays(today, -14);
  const tasks = (await sbGet(db, `housekeeping_tasks?task_date=gte.${from}&task_date=lt.${today}&status=in.(notified,confirmed)&select=*,staff:assigned_staff_id(id,name,wa_num,active)&order=task_date.desc&limit=200`)) || [];
  // Never ask twice: an open or answered backfill ask on the visit. And
  // never ask about a round that already has its record (task 237: the
  // round was filed with seven photos while the task row stayed 'notified').
  const asked = new Set();
  const rounds = (await sbGet(db, `housekeeping_inspections?inspected_on=gte.${from}&task_id=not.is.null&select=task_id,photos&limit=200`)) || [];
  for (const r of rounds) if ((r.photos || []).length) asked.add(Number(r.task_id));
  const checks = (await sbGet(db, `housekeeping_readiness?asked_at=gte.${encodeURIComponent(new Date(now.getTime() - 14 * 86400e3).toISOString())}&task_id=not.is.null&select=task_id&limit=200`)) || [];
  for (const c of checks) asked.add(Number(c.task_id));
  for (const num of new Set(tasks.map(t => digits(t.staff?.wa_num)).filter(Boolean))) {
    const rows = (await sbGet(db, `staff_asks?wa_num=eq.${num}&kind=eq.backfill&asked_at=gte.${encodeURIComponent(new Date(now.getTime() - 14 * 86400e3).toISOString())}&select=target_id&limit=200`)) || [];
    for (const r of rows) if (r.target_id) asked.add(Number(r.target_id));
  }
  const chan = await staffChannels(db, { now }).catch(() => ({}));
  const name = (slug) => catalogNames[slug] || slug;
  const plan = planBackfill({ tasks, today, asked, perPerson: Number(cfg.backfill_per_person) || 5 });
  const out = { today, hour, candidates: tasks.length, asked: 0, skipped: [], plan: [] };
  for (const g of plan) {
    if (only && !only.includes(g.staff.name)) continue;
    if ((chan[g.staff.id]?.mode || 'ok') === 'dead') { out.skipped.push({ staff: g.staff.name, why: 'phone not receiving' }); continue; }
    if (!preview && !(await windowOpen(db, g.to))) { out.skipped.push({ staff: g.staff.name, why: 'window shut (buttons need a reply within 24h)' }); continue; }
    for (const t of g.tasks) {
      const body = askText(t, name, today);
      const buttons = askButtons(t);
      if (preview) { out.plan.push({ to: g.to, staff: g.staff.name, task: t.id, body, buttons: buttons.map(b => b.title) }); out.asked++; continue; }
      const mid = await sendButtons(wa, g.to, body, buttons);
      await logOut(db, { waNum: g.to, content: body, mid });
      if (!mid) { out.skipped.push({ staff: g.staff.name, task: t.id, why: 'WhatsApp refused' }); continue; }
      await recordAsk(db, { waNum: g.to, staffId: g.staff.id, kind: 'backfill', targetType: 'housekeeping_task', targetId: t.id, wamid: mid, payload: { slug: t.slug, kind: t.kind, date: t.task_date }, expiresInHours: 48 });
      await hkEvent(db, t.id, 'asked_later', { actor: 'Maya', payload: { date: t.task_date }, wamid: typeof mid === 'string' ? mid : null });
      out.asked++;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  if (!preview) await saveSettingValue(db, STATE_KEY, { ...state, day: today, at: nowIso(), asked: out.asked }).catch(() => {});
  return out;
}


// ── The afternoon nudge for evidence ────────────────────────────────
// At 16:00 WITA: a visit marked done today with no photos gets one
// reminder for its two; an inspection with photos but no "selesai" gets
// the closing tip (the 19:00 auto-close does the rest). Each once a week
// per person, via the coaching layer.
export async function runEvidenceNudge({ db, wa, now = new Date(), catalogNames = {}, hour: hourOverride = null } = {}) {
  const wita = new Date(now.getTime() + 8 * 3600e3);
  const today = wita.toISOString().slice(0, 10);
  const hour = hourOverride != null ? hourOverride : wita.getUTCHours();
  if (hour !== 16) return { skipped: `hour ${hour}` };
  const name = (slug) => catalogNames[slug] || slug;
  const done = (await sbGet(db, `housekeeping_tasks?task_date=eq.${today}&status=eq.done&kind=neq.inspection&select=id,slug,photos,staff:assigned_staff_id(id,name,wa_num,active)&limit=60`)) || [];
  const out = { proof: 0, rounds: 0 };
  for (const t of done) {
    if ((t.photos || []).length || !t.staff?.wa_num || !t.staff.active) continue;
    // A round at the same villa today carries the photos instead.
    const round = (await sbGet(db, `housekeeping_inspections?slug=eq.${encodeURIComponent(t.slug)}&inspected_on=eq.${today}&select=id,photos&limit=1`))?.[0];
    if ((round?.photos || []).length) continue;
    if (await coach(db, wa, { person: t.staff, key: 'proof_missing', extra: `(${name(t.slug)})` })) out.proof++;
  }
  const rounds = (await sbGet(db, `housekeeping_inspections?inspected_on=eq.${today}&task_id=not.is.null&select=id,slug,photos,task_id&limit=40`)) || [];
  for (const r of rounds) {
    if ((r.photos || []).length < 3) continue;
    const task = (await sbGet(db, `housekeeping_tasks?id=eq.${r.task_id}&status=in.(notified,confirmed)&select=id,staff:assigned_staff_id(id,name,wa_num,active)&limit=1`))?.[0];
    if (!task?.staff?.wa_num) continue;
    if (await coach(db, wa, { person: task.staff, key: 'round_not_closed', extra: `(${name(r.slug)}, ${r.photos.length} foto sudah masuk)` })) out.rounds++;
  }
  return out;
}
