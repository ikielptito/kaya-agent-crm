// The evening chase.
//
// A visit is only a record once the housekeeper taps "Sudah selesai": that
// tap closes the task and, before a guest, opens the photo check. Until
// 6 Sep 2026 nothing happened when the tap never came. The task sat at
// "notified" forever, the owner's log stayed empty, and Era found out from
// the guest. Ita had four of those in one week; Gede and Putu had all of
// theirs.
//
// Two steps on the hourly beat, both bounded to TODAY's visits:
//
//   17:00 WITA  one message per housekeeper listing her visits still not
//               marked done, with the same three buttons as the morning
//   19:00 WITA  whatever is still open goes to Era as one line per villa,
//               the same shape as the readiness flags she already gets
//
// Guardrails: yesterday is never chased again (it stays open for Era to
// close, so the record shows it was never confirmed rather than being
// quietly marked done later); a person whose last messages never reached
// her phone is not chased (Putu, 4 Sep — a dead phone gets Era's line, not
// more messages); each step fires once a day; the daily cap applies.

import { resolveCampaign, isCampaignPaused, getSettingValue, saveSettingValue, noteRun } from './campaigns.js';
import { renderTemplateContent } from './template-render.js';
import { KIND_ID, KIND_EN } from './housekeeping-sweep.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
const STATE_KEY = 'housekeeping_chase';

// A dedicated template once Meta approves it; the morning's task template
// as the fallback so the chase starts the day the code ships.
const T_CHASE = 'samba_hk_chase';
const T_TASK_V2 = 'samba_hk_task_v2';

export const CHASE_DEFAULTS = { chase_hour: 17, escalate_hour: 19, unreachable_after: 3 };

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sbPatch(db, path, body) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify(body) }).catch(() => {});
}
const flatten = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();

async function sendTemplate(wa, to, name, params, lang = 'id') {
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text: flatten(text) })) }] },
      }),
    });
    if (!r.ok) return null;
    return (await r.json().catch(() => ({}))).messages?.[0]?.id || true;
  } catch { return null; }
}
async function sendText(wa, to, body) {
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) return null;
    return (await r.json().catch(() => ({}))).messages?.[0]?.id || true;
  } catch { return null; }
}
async function logOut(db, { waNum, content, mid, template, campaignId, category = 'housekeeping' }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      wa_num: waNum, direction: 'outbound', content, wa_message_id: typeof mid === 'string' ? mid : null,
      timestamp: nowIso(), source: 'cron', category, campaign_id: campaignId || null, template_name: template || null, status: 'sent',
    }),
  }).catch(() => {});
}

// ── The plan, as a pure function ────────────────────────────────────
// tasks: today's tasks with their staff joined. state: what already went
// out today. reach: number → false when her phone is not receiving.
export function planChase({ tasks = [], today, hour, state = {}, reach = {}, cfg = {} } = {}) {
  const chaseHour = Number.isFinite(+cfg.chase_hour) ? +cfg.chase_hour : CHASE_DEFAULTS.chase_hour;
  const escHour = Number.isFinite(+cfg.escalate_hour) ? +cfg.escalate_hour : CHASE_DEFAULTS.escalate_hour;
  const open = tasks.filter(t =>
    t.task_date === today && ['notified', 'confirmed'].includes(t.status) && t.kind !== 'inspection'
    && t.staff && t.staff.active !== false && digits(t.staff.wa_num));
  const chasedToday = new Set(state.day === today ? (state.chased || []) : []);
  const out = { chase: [], unreachable: [], escalate: [], escalated_already: state.era_day === today };
  if (hour >= chaseHour && hour < escHour) {
    const byPerson = new Map();
    for (const t of open) {
      if (chasedToday.has(t.id)) continue;
      const num = digits(t.staff.wa_num);
      if (reach[num] === false) { out.unreachable.push(t); continue; }
      if (!byPerson.has(num)) byPerson.set(num, { to: num, staff: t.staff, tasks: [] });
      byPerson.get(num).tasks.push(t);
    }
    out.chase = [...byPerson.values()];
  }
  if (hour >= escHour && state.era_day !== today) {
    out.escalate = open.map(t => ({ ...t, chased: chasedToday.has(t.id), unreachable: reach[digits(t.staff.wa_num)] === false }));
  }
  return out;
}

// Her phone is not receiving when the last few messages Maya sent, given
// two hours to land, all sit at "sent" or "failed". A single stuck message
// is normal; three in a row is a dead phone.
// Only rows that carry a WhatsApp message id count: those are the ones
// Meta reports delivery on. A reply logged without an id (or with `true`)
// sits at "sent" forever and used to make an answering housekeeper look
// unreachable after three Q&A answers (audit, 8 Sep 2026).
export async function reachability(db, nums, { after = CHASE_DEFAULTS.unreachable_after, now = new Date() } = {}) {
  const out = {};
  const cutoff = new Date(now.getTime() - 2 * 3600e3).toISOString();
  for (const num of new Set(nums.map(digits).filter(Boolean))) {
    const rows = (await sbGet(db,
      `wa_messages?wa_num=eq.${num}&direction=eq.outbound&wa_message_id=not.is.null&timestamp=lte.${encodeURIComponent(cutoff)}&select=status&order=timestamp.desc&limit=${after}`)) || [];
    out[num] = !(rows.length >= after && rows.every(r => ['sent', 'failed'].includes(r.status)));
  }
  return out;
}

// What the chase says. One message per person; the tap-once-per-villa
// note matters because a tap closes her OLDEST open task, so two villas
// need two taps.
export function chaseParams(tasks, name) {
  const villas = tasks.map(t => name(t.slug));
  if (tasks.length === 1) return [villas[0], KIND_ID[tasks[0].kind] || 'bersih-bersih'];
  const detail = tasks.map(t => `${KIND_ID[t.kind] || 'bersih-bersih'} (${name(t.slug)})`).join(' · ')
    + ' — tekan Sudah selesai satu kali untuk setiap villa yang sudah selesai';
  return [villas.join(' & '), detail];
}
// The fallback wording, on the morning template: it opens "ada jadwal
// untuk hari ini", which is still true, so only the task line changes.
function fallbackParams(tasks, name) {
  const [villa, detail] = chaseParams(tasks, name);
  return [villa, `${detail} — belum ada konfirmasi dari tadi pagi. Kalau sudah selesai, tekan Sudah selesai`];
}

export function eraMessage(items, name) {
  const lines = items.map(t => {
    const why = t.unreachable ? ' — messages are not reaching her phone' : t.chased ? '' : ' — not chased (cap or template)';
    return `• ${name(t.slug)} — ${KIND_EN[t.kind] || t.kind} (${t.staff?.name || 'housekeeper'})${why}`;
  });
  return `Cleaning visits not confirmed today (${items.length}):\n${lines.join('\n')}\n\nMaya asked each of them at 17:00. If a villa was cleaned, mark it done on the Schedule page; if not, please call them. Tomorrow's visits go out as usual.`;
}

// ── The runner, on the hourly beat ──────────────────────────────────
export async function runHousekeepingChase({ db, wa, templatesMap = {}, catalogNames = {}, now = new Date(), preview = false, hour: hourOverride = null } = {}) {
  const wita = new Date(now.getTime() + 8 * 3600e3);
  const today = wita.toISOString().slice(0, 10);
  const hour = hourOverride != null ? hourOverride : wita.getUTCHours();
  const cfg = (await getSettingValue(db, 'housekeeping')) || {};
  const chaseHour = Number.isFinite(+cfg.chase_hour) ? +cfg.chase_hour : CHASE_DEFAULTS.chase_hour;
  if (hour < chaseHour) return { skipped: `before ${chaseHour}:00`, today, hour };

  const camp = await resolveCampaign(db, 'housekeeping');
  if (isCampaignPaused(camp)) return { skipped: 'campaign paused (command center)' };
  const cap = parseInt(cfg.notify_daily_cap, 10) || 0;
  if (!preview && cap <= 0) return { skipped: 'notify_daily_cap unset' };
  const name = (slug) => catalogNames[slug] || slug;

  const tasks = (await sbGet(db,
    `housekeeping_tasks?task_date=eq.${today}&status=in.(notified,confirmed)`
    + `&select=*,staff:assigned_staff_id(id,name,wa_num,active)&order=slug.asc&limit=100`)) || [];
  const state = (await getSettingValue(db, STATE_KEY)) || {};
  const reach = await reachability(db, tasks.map(t => t.staff?.wa_num), { now }).catch(() => ({}));
  const plan = planChase({ tasks, today, hour, state, reach, cfg });
  const out = { today, hour, open: tasks.length, chased: 0, unreachable: plan.unreachable.map(t => `${t.staff?.name}: ${name(t.slug)}`), escalated: 0, failed: 0, plan: [] };

  const tmpl = templatesMap[T_CHASE] ? T_CHASE : templatesMap[T_TASK_V2] ? T_TASK_V2 : null;
  const fresh = { day: today, chased: state.day === today ? [...(state.chased || [])] : [], era_day: state.era_day || null };
  let budget = preview ? 999 : cap;

  for (const group of plan.chase) {
    if (!tmpl) { out.plan.push({ to: group.to, skipped: 'no approved template' }); continue; }
    if (budget <= 0) break;
    const params = tmpl === T_CHASE ? chaseParams(group.tasks, name) : fallbackParams(group.tasks, name);
    const label = `[Evening chase — ${group.tasks.map(t => `${name(t.slug)}: ${KIND_EN[t.kind]}`).join(', ')}]`;
    if (preview) { out.plan.push({ to: group.to, staff: group.staff?.name, template: tmpl, params, label }); budget--; continue; }
    const mid = await sendTemplate(wa, group.to, tmpl, params);
    if (!mid) { out.failed++; continue; }
    budget--;
    const rendered = typeof mid === 'string' ? renderTemplateContent(templatesMap[tmpl], params, { fallback: '' }) : '';
    await logOut(db, { waNum: group.to, content: rendered || label, mid, template: tmpl, campaignId: camp?.id });
    // The ask: her tap on this message names these visits, not her oldest.
    try {
      const { recordAsk } = await import('./asks.js');
      await recordAsk(db, { waNum: group.to, staffId: group.staff?.id ?? null, kind: 'chase', targetType: 'housekeeping_task', targetIds: group.tasks.map(t => t.id), wamid: mid, payload: { villas: group.tasks.map(t => t.slug) }, expiresAt: `${today}T15:00:00.000Z` });
    } catch { /* optional */ }
    for (const t of group.tasks) {
      fresh.chased.push(t.id);
      await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, {
        thread: [...(t.thread || []), { at: nowIso(), who: 'Maya', text: 'Evening chase sent' }].slice(-50), updated_at: nowIso(),
      });
      try { const { hkEvent } = await import('./events.js'); await hkEvent(db, t.id, 'chased', { actor: 'Maya', wamid: typeof mid === 'string' ? mid : null }); } catch { /* optional */ }
    }
    out.chased += group.tasks.length;
    // State after every send, so a timeout mid-run does not chase twice.
    if (!preview) await saveSettingValue(db, STATE_KEY, fresh).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }

  if (plan.escalate.length) {
    const era = digits(process.env.ERA_WA_NUM || '6281246357778');
    const body = eraMessage(plan.escalate, name);
    if (preview) out.plan.push({ to: era, era: true, body });
    else {
      const mid = await sendText(wa, era, body);
      if (mid) {
        await logOut(db, { waNum: era, content: body, mid, campaignId: camp?.id });
        fresh.era_day = today;
        out.escalated = plan.escalate.length;
      } else out.failed++;
    }
  } else if (hour >= (Number.isFinite(+cfg.escalate_hour) ? +cfg.escalate_hour : CHASE_DEFAULTS.escalate_hour) && !preview) {
    // Nothing open at 19:00: note the day so the hourly beat stops looking.
    fresh.era_day = today;
  }

  if (!preview) {
    await saveSettingValue(db, STATE_KEY, fresh);
    if (out.chased || out.escalated) await noteRun(db, camp, { sent: out.chased + (out.escalated ? 1 : 0), failed: out.failed, summary: { evening_chase: out } });
  }
  return out;
}
