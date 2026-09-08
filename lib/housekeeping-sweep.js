// What Maya says to the housekeepers.
//
// Three queues, drained by the daily pass:
//
//   1. today's visits          → one message each, in the morning
//   2. Monday                  → the week ahead, per person
//   3. inspection rounds due   → ask for the photo walk-through
//
// The morning timing is deliberate. The one piece of published housekeeping
// advice that transfers to long-let is that cleaners want the day's work when
// they wake up, and the week's shape in advance — not a message the night
// before that is buried by morning.
//
// Everything here is Indonesian. Gede, Naomi, Ita, Ana and Putu do not work
// in English, and a schedule nobody can read is not a schedule.

import { resolveCampaign, isCampaignPaused, getSettingValue, saveSettingValue, noteRun } from './campaigns.js';
import { renderTemplateContent } from './template-render.js';
import { DEEP_CLEAN_ID, DEEP_CLEAN_EN } from './housekeeping-readiness.js';
import { recordAsk } from './asks.js';
import { hkEvent } from './events.js';
import { channels as staffChannels, shouldTellEra, markEraTold } from './staff-channel.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const MS_DAY = 86400000;

// v2 carries three one-tap answers. Preferred when approved, with the
// original as the fallback so a pending review never stops the schedule.
const T_TASK = 'samba_hk_task';
const T_TASK_V2 = 'samba_hk_task_v2';
const T_WEEK = 'samba_hk_week';
const T_INSPECT = 'samba_hk_inspection';
// v2 adds the functional walk-through (locks, plugs, remote, extinguisher…)
// from Oli's checklist. Preferred when approved, original as the fallback.
const T_INSPECT_V2 = 'samba_hk_inspection_v2';

// What the housekeeper is being asked to do, in her own language.
export const KIND_ID = {
  turnover:      'bersih-bersih setelah tamu check out',
  regular:       'bersih-bersih rutin',
  pre_arrival:   'siapkan villa sebelum tamu datang',
  inspection:    'pemeriksaan rutin dengan foto',
  deep_clean:    DEEP_CLEAN_ID,
};
export const KIND_EN = {
  turnover: 'Turnover clean',
  regular: 'Regular clean',
  pre_arrival: 'Pre-arrival freshen-up',
  inspection: 'Inspection round',
  deep_clean: DEEP_CLEAN_EN,
};
// The kinds that end with a photo handover. Said in the morning message so
// she knows before she starts, not as a surprise when she taps "done".
const NEEDS_PHOTOS_ID = ' — setelah selesai, Maya akan minta foto tiap ruangan';
// Every other visit ends with two photos too (kitchen and bathroom): a
// minute of her time, and the difference between "she said so" and a
// record that settles a question a month later.
const PROOF_HINT_ID = ' — setelah selesai, kirim 2 foto (dapur dan kamar mandi)';

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) });
}

// Meta rejects any template parameter containing a newline, a tab, or four
// consecutive spaces — the send fails outright. The Monday week-ahead
// message is a list of days, so this is not hypothetical: built with "\n"
// separators it would never have been delivered, template approval or not.
const flatten = (s) => String(s == null ? '' : s)
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/ {4,}/g, '   ')
  .trim();

async function sendTemplate(phoneId, token, to, name, params, lang = 'id') {
  try {
    const components = params?.length
      ? [{ type: 'body', parameters: params.map(text => ({ type: 'text', text: flatten(text) })) }]
      : [];
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components },
      }),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch { return false; }
}

// Rendered message per Meta message id: what the housekeeper actually read,
// filled in by send() and written by logOut() in place of the bracket label
// (which stays as the fallback for a template Meta has not returned to us).
const RENDERED = new Map();

async function logOut(db, { waNum, content, mid, template, campaignId }) {
  const rendered = typeof mid === 'string' ? RENDERED.get(mid) : null;
  if (typeof mid === 'string') RENDERED.delete(mid);
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: waNum, direction: 'outbound', content: rendered || content,
      wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(),
      source: 'cron', category: 'housekeeping', campaign_id: campaignId || null,
      template_name: template, status: 'sent',
    }),
  }).catch(() => {});
}

const dayLabel = (d) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export async function runHousekeepingSweep({
  SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, catalogNames = {}, templatesMap = {}, preview = false, now = new Date(), skipWeek = false,
} = {}) {
  const db = { SUPABASE_URL, sbHeaders };
  if (!preview && (!WA_TOKEN || !WA_PHONE_ID)) return { skipped: 'no WhatsApp credentials' };

  const camp = await resolveCampaign(db, 'housekeeping');
  if (isCampaignPaused(camp)) return { skipped: 'campaign paused (command center)' };
  const cfg = (await getSettingValue(db, 'housekeeping')) || {};
  const cap = parseInt(cfg.notify_daily_cap, 10) || 0;
  if (!preview && cap <= 0) return { skipped: 'notify_daily_cap unset (arm in command center)' };

  const wita = new Date(now.getTime() + 8 * 3600e3);
  const today = wita.toISOString().slice(0, 10);
  const isMonday = wita.getUTCDay() === 1;
  const has = (t) => preview || !!templatesMap[t];
  const name = (slug) => catalogNames[slug] || slug;

  const out = { tasks_sent: 0, weeks_sent: 0, inspections_asked: 0, failed: 0, skipped: [], plan: [], uncovered: [] };
  // Who can actually be reached today. A dead phone gets no template: the
  // visit is marked uncovered and Era hears, instead of a message nobody
  // receives followed by a chase nobody receives (Putu, 4–8 Sep 2026).
  const chan = await staffChannels(db, { now }).catch(() => ({}));
  const modeOf = (staff) => chan[staff?.id]?.mode || 'ok';
  const eraNum = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  const deadTold = new Set();
  const markUncovered = async (task, why) => {
    out.uncovered.push({ id: task.id, slug: task.slug, who: task.staff?.name || null, why });
    if (preview) return;
    await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, { notes: [task.notes, `Uncovered: ${why}`].filter(Boolean).join(' · ').slice(0, 500), updated_at: nowIso() });
    await hkEvent(db, task.id, 'uncovered', { actor: 'Maya', payload: { why } });
  };
  // The ask row for a template that went out: the tap comes back by id.
  const noteAsk = async (task, to, mid, kind) => {
    if (preview || typeof mid !== 'string') return;
    await recordAsk(db, { waNum: to, staffId: task.staff?.id ?? null, kind, targetType: 'housekeeping_task', targetId: task.id, wamid: mid, payload: { slug: task.slug, kind: task.kind, date: task.task_date }, expiresAt: `${task.task_date}T15:00:00.000Z` });
    await hkEvent(db, task.id, 'notified', { actor: 'Maya', wamid: mid });
  };
  // Each villa's cleaning weekdays, so a guest-driven visit on another day
  // is announced as the exception it is ("kecuali ada tamu", as Ana put it).
  const careDays = {};
  for (const r of (await sbGet(db, 'property_care?select=slug,clean_days')) || []) careDays[r.slug] = r.clean_days || [];
  const offDay = (task) => {
    const days = careDays[task.slug];
    return !!(days && days.length && !days.includes(new Date(task.task_date + 'T00:00:00Z').getUTCDay()));
  };
  let budget = preview ? 999 : cap;

  const send = async (to, template, params, log) => {
    if (budget <= 0) return null;
    if (preview) { out.plan.push({ to, template, params, log }); budget--; return 'preview'; }
    const mid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, to, template, params);
    if (!mid) { out.failed++; return null; }
    if (typeof mid === 'string') {
      const rendered = renderTemplateContent(templatesMap[template], params, { fallback: '' });
      if (rendered) RENDERED.set(mid, rendered);
    }
    budget--;
    await new Promise(r => setTimeout(r, 300));
    return mid;
  };

  // ── 1) Today's visits ─────────────────────────────────────────────
  // Today's work, plus anything from the last two days that never went out.
  //
  // Matching the date exactly looked obvious and stranded tasks silently: the
  // daily cap, a paused campaign or a failed cron leaves notified_at null,
  // and the next run no longer matches the date, so that visit is never sent
  // at all. Two days of grace covers a missed run without ever resurrecting
  // a clean from last week, which would confuse more than it helps.
  const graceFrom = new Date(Date.parse(today) - 2 * MS_DAY).toISOString().slice(0, 10);
  const due = (await sbGet(db,
    `housekeeping_tasks?task_date=lte.${today}&task_date=gte.${graceFrom}&notified_at=is.null&status=eq.planned`
    + `&select=*,staff:assigned_staff_id(id,name,wa_num,active)&order=task_date.asc,same_day.desc,slug.asc&limit=60`)) || [];
  // One message per VISIT — one housekeeper, one villa, one day — listing
  // its jobs. Until 8 Sep 2026 a turnover day with an inspection produced
  // two templates for one trip (Ita, B4), and two records for it. Now the
  // clean template carries both jobs; a day that is only a round still
  // gets the round template with its photo list.
  const tmplClean = has(T_TASK_V2) ? T_TASK_V2 : T_TASK;
  const tInspect = has(T_INSPECT_V2) ? T_INSPECT_V2 : T_INSPECT;
  const visits = new Map();
  for (const task of due) {
    const key = `${task.slug}|${task.task_date}|${task.staff?.id ?? '-'}`;
    if (!visits.has(key)) visits.set(key, []);
    visits.get(key).push(task);
  }
  const INSPECT_HINT_ID = ' + pemeriksaan rutin dengan foto (kamar mandi, langit-langit, dinding dekat AC, dapur, kolam; yang rusak difoto dari dekat; kalau semua bagus balas "semua bagus")';
  for (const jobs of visits.values()) {
    const task = jobs.find(t => t.kind !== 'inspection') || jobs[0];
    const round = jobs.find(t => t.kind === 'inspection') || null;
    const soloRound = !jobs.some(t => t.kind !== 'inspection');
    const tmpl = soloRound ? tInspect : tmplClean;
    if (!has(tmpl)) { for (const t of jobs) out.skipped.push({ id: t.id, why: `${tmpl} not approved yet` }); continue; }
    const to = String(task.staff?.wa_num || '').replace(/\D/g, '');
    if (!to || !task.staff?.active) {
      for (const t of jobs) { out.skipped.push({ id: t.id, slug: t.slug, why: 'no housekeeper covers this villa' }); await markUncovered(t, 'no housekeeper assigned'); }
      continue;
    }
    const mode = modeOf(task.staff);
    if (mode === 'dead') {
      for (const t of jobs) { out.skipped.push({ id: t.id, slug: t.slug, why: `${task.staff.name}'s phone is not receiving` }); await markUncovered(t, `${task.staff.name}'s phone has not received messages since ${String(chan[task.staff.id]?.undelivered_since || '').slice(0, 10)}`); }
      deadTold.add(task.staff.id);
      continue;
    }
    // A reader who ignores asks is not sent a photo round on its own; Era
    // arranges it by phone. A round riding on a clean still goes.
    if (soloRound && mode === 'quiet') { out.skipped.push({ id: task.id, slug: task.slug, why: `${task.staff.name} ignores asks — arrange the round by phone` }); await markUncovered(task, `${task.staff.name} has not been answering; Era to arrange by phone`); continue; }

    let params, label;
    if (soloRound) {
      params = [name(task.slug)];
      label = `[Inspection round — ${name(task.slug)}]`;
    } else {
      // A same-day changeover has a guest arriving behind the cleaner, so
      // it is said out loud rather than left as a date she has to work out.
      let detail = task.same_day
        ? `${KIND_ID[task.kind]} — tamu berikutnya datang hari ini juga, mohon didahulukan`
        : KIND_ID[task.kind] || 'bersih-bersih';
      // A task caught by the grace window is not today's work. Saying so
      // keeps the template honest: it opens with "jadwal untuk hari ini".
      if (task.task_date < today) detail += ` (jadwal ${dayLabel(task.task_date)}, belum sempat terkirim)`;
      if (task.kind !== 'regular' && offDay(task)) detail += ' — di luar hari biasa, karena ada tamu';
      if (task.kind === 'pre_arrival' || task.kind === 'deep_clean' || (task.kind === 'turnover' && task.guest_in_date)) detail += NEEDS_PHOTOS_ID;
      else detail += PROOF_HINT_ID;
      if (round) detail += INSPECT_HINT_ID;
      params = [name(task.slug), detail];
      label = `[Housekeeping — ${name(task.slug)}: ${jobs.map(t => KIND_EN[t.kind]).join(' + ')}${task.same_day ? ', same-day' : ''}]`;
    }
    const mid = await send(to, tmpl, params, label);
    if (!mid) continue;
    if (!preview) {
      await logOut(db, { waNum: to, mid, template: tmpl, campaignId: camp?.id, content: label });
      for (const t of jobs) {
        await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, { notified_at: nowIso(), status: 'notified', updated_at: nowIso() });
        await hkEvent(db, t.id, 'notified', { actor: 'Maya', wamid: typeof mid === 'string' ? mid : null });
      }
      // ONE ask for the visit, naming every job: the tap comes back by id.
      if (typeof mid === 'string') await recordAsk(db, { waNum: to, staffId: task.staff?.id ?? null, kind: soloRound ? 'inspection' : 'task', targetType: 'housekeeping_task', targetIds: jobs.map(t => t.id), wamid: mid, payload: { slug: task.slug, date: task.task_date, jobs: jobs.map(t => t.kind) }, expiresAt: `${task.task_date}T15:00:00.000Z` });
    }
    if (soloRound) out.inspections_asked++; else out.tasks_sent++;
  }

  // ── Uncovered visits: Era hears once, then every third day per person ─
  if (!preview && out.uncovered.length && eraNum) {
    const lines = [];
    const byWho = new Map();
    for (const u of out.uncovered) { const k = u.who || 'nobody'; if (!byWho.has(k)) byWho.set(k, []); byWho.get(k).push(u); }
    const told = (await getSettingValue(db, 'hk_uncovered_told').catch(() => null)) || {};
    for (const [who, list] of byWho) {
      const sid = due.find(t => t.staff?.name === who)?.staff?.id;
      // Once a day per person here (settings), once every third day via
      // the channel row; 8 Sep 2026 Era got the same line three times in
      // twenty minutes from three different runs.
      if (told[who] === today) continue;
      if (sid && !(await shouldTellEra(db, sid, { now }))) continue;
      lines.push(`• ${list.map(u => name(u.slug)).join(', ')} — ${list[0].why}`);
      told[who] = today;
      if (sid) await markEraTold(db, sid);
    }
    if (lines.length) await saveSettingValue(db, 'hk_uncovered_told', told).catch(() => {});
    if (lines.length) {
      const body = `Visits with nobody to send them to today:\n${lines.join('\n')}\n\nReassign on the Schedule page, or arrange it by phone. I will not chase a phone that is not receiving.`;
      const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: eraNum, type: 'text', text: { body } }) }).catch(() => null);
      const mid = r?.ok ? (await r.json().catch(() => ({}))).messages?.[0]?.id : null;
      await logOut(db, { waNum: eraNum, mid, template: null, campaignId: camp?.id, content: body });
      out.era_told_uncovered = lines.length;
    }
  }

  // ── 3) Monday: the week ahead ─────────────────────────────────────
  // The most cited practice for avoiding no-shows is letting people see the
  // week before it starts. One message per person, not one per task.
  if (isMonday && has(T_WEEK) && !skipWeek) {
    const until = new Date(Date.parse(today) + 7 * MS_DAY).toISOString().slice(0, 10);
    const week = (await sbGet(db,
      `housekeeping_tasks?task_date=gte.${today}&task_date=lt.${until}&status=in.(planned,notified)`
      + `&select=*,staff:assigned_staff_id(id,name,wa_num,active)&order=task_date.asc&limit=200`)) || [];
    const byPerson = new Map();
    for (const t of week) {
      if (!t.staff?.wa_num || !t.staff.active) continue;
      if (!byPerson.has(t.staff.id)) byPerson.set(t.staff.id, { staff: t.staff, tasks: [] });
      byPerson.get(t.staff.id).tasks.push(t);
    }
    for (const { staff, tasks } of byPerson.values()) {
      // A dead phone gets nothing; a quiet reader gets the daily tasks only.
      if (modeOf(staff) !== 'ok') { out.skipped.push({ staff: staff.name, why: `week message skipped (${modeOf(staff)})` }); continue; }
      // Separated by a middle dot, not a newline: the flattener above would
      // turn newlines into plain spaces and run the whole week together into
      // one unreadable sentence.
      const lines = tasks.map(t => `${dayLabel(t.task_date)}: ${name(t.slug)} — ${KIND_ID[t.kind] || 'bersih-bersih'}${t.kind !== 'regular' && offDay(t) ? ' (ada tamu)' : ''}`).join(' · ');
      const mid = await send(String(staff.wa_num).replace(/\D/g, ''), T_WEEK,
        [staff.name.split(' ')[0], lines.slice(0, 900)],
        `[Week ahead — ${staff.name}, ${tasks.length} visits]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: String(staff.wa_num).replace(/\D/g, ''), mid, template: T_WEEK,
          campaignId: camp?.id, content: `[Week ahead — ${staff.name}, ${tasks.length} visits]` });
        // The week is a plan she confirms: an "ok" to this message marks
        // every visit on it confirmed; a "not Thursday" goes to the
        // schedule reader. Recorded as an ask so the reply finds it.
        if (typeof mid === 'string') await recordAsk(db, { waNum: String(staff.wa_num).replace(/\D/g, ''), staffId: staff.id, kind: 'week', targetType: 'housekeeping_task', targetIds: tasks.map(t => t.id), wamid: mid, payload: { from: today, until }, expiresInHours: 36 });
      }
      out.weeks_sent++;
    }
  }

  // (4) Checks nobody answered moved to the hourly beat on 8 Sep 2026 —
  // see api/cron-followups.js — so a check for tomorrow's arrival is closed
  // the evening before, not at 09:00 on the day.

  const sent = out.tasks_sent + out.weeks_sent + out.inspections_asked;
  if (!preview && sent) await noteRun(db, camp, { sent, failed: out.failed, summary: out });
  return out;
}
