// Era's maintenance backlog, and Maya nagging her about it through the day.
//
// The maintenance flow only moves when Era moves it: a new ticket needs an
// estimate and a publish before the owner hears of it; an approved one
// needs a tukang picked before anyone is dispatched; a scheduled one needs
// her to confirm it is done before the owner is told. The existing reminder
// (maintenance-sweep queue 3) chases authorised work every three days. It
// never touched the "new" pile, which is where tickets were quietly ageing
// on 5 Sep 2026: six of eight open items, the oldest a week old.
//
// So, on the hourly beat, at a few fixed hours of the working day, Maya
// sends Era one message listing everything waiting on her and what each one
// needs, with the link. Not one message per ticket — one list, oldest first,
// and only when there is something on it. Anything older than three days is
// marked overdue, and at the end of the afternoon Ikiel gets a copy of the
// overdue ones, because "she is using the system" is his to know.

import { getSettingValue, saveSettingValue } from './campaigns.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const PORTAL = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';
const nowIso = () => new Date().toISOString();
const STATE_KEY = 'maintenance_era_nudge';
const DEFAULTS = { era_nudge_hours: [9, 12, 15, 18], era_nudge_min_age_hours: 2, overdue_days: 3, ikiel_digest_hour: 17 };

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token || !to) return null;
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
// When Era's 24h window is shut, free text bounces. The team-alert template
// opens it and the detail waits in settings.team_alerts, which the webhook
// flushes the moment she replies — the same path agent alerts already use.
async function sendViaTeamAlert(db, wa, to, body) {
  const q = (await getSettingValue(db, 'team_alerts').catch(() => null)) || {};
  const list = Array.isArray(q[to]) ? q[to] : [];
  list.push({ summary: body.slice(0, 500), agent_name: 'the maintenance backlog', agent_num: null, share_contact: false, ts: nowIso() });
  q[to] = list.slice(-10);
  await saveSettingValue(db, 'team_alerts', q);
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: 'maya_team_alert', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'the maintenance backlog' }] }] },
      }),
    });
    return r.ok;
  } catch { return false; }
}
async function logOut(db, { waNum, content, mid }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: waNum, direction: 'outbound', content, timestamp: nowIso(), wa_message_id: typeof mid === 'string' ? mid : null, source: 'cron', category: 'maintenance_staff', status: 'sent' }),
  }).catch(() => {});
}

const placeOf = (i) => i.unit_label ? `${i.statement_groups?.name || i.group_key} (${i.unit_label})` : (i.statement_groups?.name || i.slug || i.group_key);
const ageDays = (iso, now) => Math.floor((now.getTime() - Date.parse(iso)) / 86400e3);
const ageText = (iso, now) => { const h = (now.getTime() - Date.parse(iso)) / 3600e3; return h < 24 ? `${Math.max(1, Math.round(h))}h` : `${Math.floor(h / 24)}d`; };

// ── What is waiting on Era ──────────────────────────────────────────
export async function eraBacklog(db, { now = new Date(), minAgeHours = 0 } = {}) {
  const items = (await sbGet(db, `maintenance_items?status=in.(new,approved,scheduled)&select=*,statement_groups(key,name)&order=created_at.asc&limit=100`)) || [];
  const out = [];
  for (const i of items) {
    if ((now.getTime() - Date.parse(i.created_at)) < minAgeHours * 3600e3) continue;
    let action = null, since = i.created_at;
    if (i.status === 'new') action = i.estimated_cost ? 'publish it (estimate is in)' : 'add an estimate and publish';
    else if (i.status === 'approved' && !i.assigned_staff_id) { action = 'pick a tukang'; since = i.approved_at || i.created_at; }
    else if (i.status === 'scheduled' && i.visit_at && Date.parse(i.visit_at) < now.getTime() - 20 * 3600e3) { action = 'confirm it is done (or say what happened)'; since = i.visit_at; }
    if (!action) continue;
    out.push({ id: i.id, title: i.title, place: placeOf(i), status: i.status, action, since, age_days: ageDays(since, now), age: ageText(since, now), estimated_cost: i.estimated_cost ?? null });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

function eraMessage(backlog, { overdueDays, streak }) {
  const overdue = backlog.filter(b => b.age_days >= overdueDays);
  const head = overdue.length
    ? `Era, ${backlog.length} maintenance ticket${backlog.length === 1 ? ' is' : 's are'} waiting on you, ${overdue.length} of them more than ${overdueDays} days old. Ikiel sees the overdue list every afternoon.`
    : streak > 1
      ? `Still waiting on you: ${backlog.length} maintenance ticket${backlog.length === 1 ? '' : 's'}.`
      : `Maya here. ${backlog.length} maintenance ticket${backlog.length === 1 ? ' is' : 's are'} waiting on you:`;
  const lines = backlog.slice(0, 12).map(b => `• #${b.id} ${b.place} — ${b.title.slice(0, 70)} (${b.age}${b.age_days >= overdueDays ? ', OVERDUE' : ''}) → ${b.action}`);
  const more = backlog.length > 12 ? `\n…and ${backlog.length - 12} more.` : '';
  return `${head}\n\n${lines.join('\n')}${more}\n\nOpen the Maintenance page: ${PORTAL}/payouts#/maintenance\nNew tickets need the estimate and Publish on the page. For the rest you can just reply here with the ticket number, one per line, e.g. "#4 done", "#8 waiting for the villa to be empty", "#15 estimate 85,000", and I will update them.`;
}

// ── The hourly beat ─────────────────────────────────────────────────
// Runs every hour; sends only at the configured WITA hours, once per slot,
// and only when the list is not empty. `force` sends now regardless.
export async function runEraBacklogNudge({ db, wa, now = new Date(), force = false, preview = false } = {}) {
  const cfg = { ...DEFAULTS, ...((await getSettingValue(db, 'maintenance').catch(() => null)) || {}) };
  const era = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  const ikiel = String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
  const wita = new Date(now.getTime() + 8 * 3600e3);
  const hour = wita.getUTCHours(), day = wita.toISOString().slice(0, 10);
  const slot = `${day}:${hour}`;
  const state = (await getSettingValue(db, STATE_KEY).catch(() => null)) || {};
  const hours = Array.isArray(cfg.era_nudge_hours) ? cfg.era_nudge_hours.map(Number) : DEFAULTS.era_nudge_hours;

  const backlog = await eraBacklog(db, { now, minAgeHours: Number(cfg.era_nudge_min_age_hours) || 0 });
  const out = { slot, backlog: backlog.length, overdue: backlog.filter(b => b.age_days >= cfg.overdue_days).length, era: null, ikiel: null };
  if (!backlog.length) { out.era = 'nothing waiting'; return out; }

  const dueEra = force || (hours.includes(hour) && state.last_slot !== slot);
  // Streak: consecutive nudges without the list shrinking. The tone firms up.
  const streak = state.last_count != null && backlog.length >= state.last_count ? (state.streak || 1) + 1 : 1;
  const msg = eraMessage(backlog, { overdueDays: cfg.overdue_days, streak });
  if (preview) { out.era = { would_send: dueEra, message: msg }; }
  else if (dueEra) {
    let mid = await sendText(wa, era, msg);
    let via = 'text';
    if (!mid) { mid = await sendViaTeamAlert(db, wa, era, msg); via = 'template+queue'; }
    if (mid) {
      await logOut(db, { waNum: era, mid, content: `[Maintenance backlog — ${backlog.length} waiting on Era]` });
      await saveSettingValue(db, STATE_KEY, { ...state, last_slot: slot, last_sent_at: nowIso(), last_count: backlog.length, streak });
      out.era = { sent: true, via, count: backlog.length };
    } else out.era = { sent: false };
  } else out.era = `not due (hours ${hours.join(',')} WITA, now ${hour}; last ${state.last_slot || 'never'})`;

  // Ikiel's copy: once a day, overdue items only.
  const overdue = backlog.filter(b => b.age_days >= cfg.overdue_days);
  const dueIkiel = ikiel && overdue.length && (force || (hour === Number(cfg.ikiel_digest_hour) && state.ikiel_day !== day));
  if (dueIkiel) {
    const dm = `Maintenance backlog, end of day: ${overdue.length} ticket${overdue.length === 1 ? '' : 's'} waiting on Era for ${cfg.overdue_days}+ days.\n` +
      overdue.slice(0, 10).map(b => `• #${b.id} ${b.place} — ${b.title.slice(0, 60)} (${b.age}) → ${b.action}`).join('\n') +
      `\nShe was nudged ${streak} time${streak === 1 ? '' : 's'} today. ${PORTAL}/payouts#/maintenance`;
    if (preview) out.ikiel = { would_send: true, message: dm };
    else {
      const mid = await sendText(wa, ikiel, dm);
      if (mid) { await logOut(db, { waNum: ikiel, mid, content: `[Maintenance backlog digest — ${overdue.length} overdue]` }); await saveSettingValue(db, STATE_KEY, { ...(await getSettingValue(db, STATE_KEY).catch(() => null) || {}), ikiel_day: day }); }
      out.ikiel = { sent: !!mid, overdue: overdue.length };
    }
  } else out.ikiel = overdue.length ? `not due (digest at ${cfg.ikiel_digest_hour}:00 WITA)` : 'nothing overdue';
  return out;
}
