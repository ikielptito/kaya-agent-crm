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

import { resolveCampaign, isCampaignPaused, getSettingValue, noteRun } from './campaigns.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const MS_DAY = 86400000;

const T_TASK = 'samba_hk_task';
const T_WEEK = 'samba_hk_week';
const T_INSPECT = 'samba_hk_inspection';

// What the housekeeper is being asked to do, in her own language.
export const KIND_ID = {
  turnover:      'bersih-bersih setelah tamu check out',
  during_stay:   'bersih-bersih rutin (tamu masih menginap)',
  pre_arrival:   'siapkan villa sebelum tamu datang',
  vacant_upkeep: 'cek dan rapikan villa yang sedang kosong',
  inspection:    'pemeriksaan rutin dengan foto',
};
export const KIND_EN = {
  turnover: 'Turnover clean',
  during_stay: 'Clean during the stay',
  pre_arrival: 'Pre-arrival freshen-up',
  vacant_upkeep: 'Upkeep while empty',
  inspection: 'Inspection round',
};

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

async function logOut(db, { waNum, content, mid, template, campaignId }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: waNum, direction: 'outbound', content,
      wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(),
      source: 'cron', category: 'housekeeping', campaign_id: campaignId || null,
      template_name: template, status: 'sent',
    }),
  }).catch(() => {});
}

const dayLabel = (d) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export async function runHousekeepingSweep({
  SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, catalogNames = {}, templatesMap = {}, preview = false, now = new Date(),
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

  const out = { tasks_sent: 0, weeks_sent: 0, inspections_asked: 0, failed: 0, skipped: [], plan: [] };
  let budget = preview ? 999 : cap;

  const send = async (to, template, params, log) => {
    if (budget <= 0) return null;
    if (preview) { out.plan.push({ to, template, params, log }); budget--; return 'preview'; }
    const mid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, to, template, params);
    if (!mid) { out.failed++; return null; }
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
  for (const task of due) {
    // Inspections have their own instruction: bring back photos.
    if (task.kind === 'inspection') continue;
    if (!has(T_TASK)) { out.skipped.push({ id: task.id, why: `${T_TASK} not approved yet` }); continue; }
    const to = String(task.staff?.wa_num || '').replace(/\D/g, '');
    if (!to || !task.staff?.active) {
      out.skipped.push({ id: task.id, slug: task.slug, why: 'no housekeeper covers this villa' });
      continue;
    }
    // A same-day changeover has a guest arriving behind the cleaner, so it is
    // said out loud rather than left as a date she has to work out.
    let detail = task.same_day
      ? `${KIND_ID[task.kind]} — tamu berikutnya datang hari ini juga, mohon didahulukan`
      : KIND_ID[task.kind] || 'bersih-bersih';
    // A task caught by the grace window is not today's work. Saying so keeps
    // the template honest: it opens with "jadwal untuk hari ini".
    if (task.task_date < today) detail += ` (jadwal ${dayLabel(task.task_date)}, belum sempat terkirim)`;
    const mid = await send(to, T_TASK, [name(task.slug), detail],
      `[Housekeeping — ${name(task.slug)}: ${KIND_EN[task.kind]}${task.same_day ? ', same-day' : ''}]`);
    if (!mid) continue;
    if (!preview) {
      await logOut(db, { waNum: to, mid, template: T_TASK, campaignId: camp?.id,
        content: `[Housekeeping — ${name(task.slug)}: ${KIND_EN[task.kind]}]` });
      await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
        notified_at: nowIso(), status: 'notified', updated_at: nowIso(),
      });
    }
    out.tasks_sent++;
  }

  // ── 2) Inspection rounds ──────────────────────────────────────────
  if (has(T_INSPECT)) {
    for (const task of due.filter(x => x.kind === 'inspection')) {
      const to = String(task.staff?.wa_num || '').replace(/\D/g, '');
      if (!to || !task.staff?.active) { out.skipped.push({ id: task.id, slug: task.slug, why: 'nobody covers this villa' }); continue; }
      const mid = await send(to, T_INSPECT, [name(task.slug)],
        `[Inspection round — ${name(task.slug)}]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: to, mid, template: T_INSPECT, campaignId: camp?.id,
          content: `[Inspection round — ${name(task.slug)}]` });
        await sbPatch(db, `housekeeping_tasks?id=eq.${task.id}`, {
          notified_at: nowIso(), status: 'notified', updated_at: nowIso(),
        });
      }
      out.inspections_asked++;
    }
  }

  // ── 3) Monday: the week ahead ─────────────────────────────────────
  // The most cited practice for avoiding no-shows is letting people see the
  // week before it starts. One message per person, not one per task.
  if (isMonday && has(T_WEEK)) {
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
      // Separated by a middle dot, not a newline: the flattener above would
      // turn newlines into plain spaces and run the whole week together into
      // one unreadable sentence.
      const lines = tasks.map(t => `${dayLabel(t.task_date)}: ${name(t.slug)} — ${KIND_ID[t.kind] || 'bersih-bersih'}`).join(' · ');
      const mid = await send(String(staff.wa_num).replace(/\D/g, ''), T_WEEK,
        [staff.name.split(' ')[0], lines.slice(0, 900)],
        `[Week ahead — ${staff.name}, ${tasks.length} visits]`);
      if (!mid) continue;
      if (!preview) {
        await logOut(db, { waNum: String(staff.wa_num).replace(/\D/g, ''), mid, template: T_WEEK,
          campaignId: camp?.id, content: `[Week ahead — ${staff.name}, ${tasks.length} visits]` });
      }
      out.weeks_sent++;
    }
  }

  const sent = out.tasks_sent + out.weeks_sent + out.inspections_asked;
  if (!preview && sent) await noteRun(db, camp, { sent, failed: out.failed, summary: out });
  return out;
}
