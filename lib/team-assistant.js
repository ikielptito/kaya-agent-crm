// Maya as the team's assistant on WhatsApp — Era's first, Ikiel's too.
//
// The team branch of the webhook used to end in silence: whatever no
// handler claimed was logged for a person. That kept a robot from
// swallowing Era's work talk, but it also meant she could not ask "who
// cleans Saturno tomorrow?" or "what is still owed on A5?" without opening
// the Payouts page. This module answers those from the same functions the
// cockpit uses, through a tool loop (the shape of lib/assistant.js), and
// keeps one explicit way out: `not_for_me`, for a note that is really for
// Ikiel, which is forwarded and never answered.
//
// Guards: runs last in the team branch (every existing first-claim handler
// keeps its turn), only for text, never for bare acks, off unless
// settings.team_assistant.enabled or TEAM_ASSISTANT=on, own spend ledger,
// a pause phrase ("Maya, diam"), and every tool call logged.
//
// Reads only, in this phase. Writes arrive as tiered tools in Phase 3.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { catalogNames, fetchStays } from './housekeeping.js';
import { standardFor, readinessForWindow } from './housekeeping-readiness.js';
import { ownerRecords } from './housekeeping-owner.js';
import { listItems, getItem } from './maintenance.js';
import { eraBacklog } from './maintenance-backlog.js';
import { listGroups } from './statements.js';
import { listRuns, runDetail } from './payroll.js';
import { listStaff } from './staff.js';
import { openRelaysForContact } from './relay.js';
import { handbookDigest, handbookSection, handbookIndex } from './handbook.js';
import { SOP, personContext } from './staff-help.js';
import { sendText } from './wa-interactive.js';

const MODEL = process.env.TEAM_ASSISTANT_MODEL || 'claude-sonnet-4-6';
const MAX_ITERATIONS = 5;
const DAILY_CAP_USD = Number(process.env.TEAM_ASSISTANT_DAILY_USD || 3);
const PRICE = { in: 3 / 1e6, out: 15 / 1e6 };
const LOG_KEY = 'team_assistant_log';
const USAGE_KEY = 'team_assistant_usage';

const ERA = () => String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
const IKIEL = () => String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
const witaNow = () => new Date(Date.now() + 8 * 3600e3);
const today = () => witaNow().toISOString().slice(0, 10);
const plus = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

export function roleFor(fromNum) {
  const n = String(fromNum || '').replace(/\D/g, '');
  if (n && n === ERA()) return 'era';
  if (n && n === IKIEL()) return 'admin';
  return null;
}

export async function assistantEnabled(db) {
  if (process.env.TEAM_ASSISTANT === 'on') return true;
  const s = await getSettingValue(db, 'team_assistant').catch(() => null);
  return !!s?.enabled;
}

// "Maya, diam" / "Maya, quiet" pauses her for 12 hours on that number;
// "Maya, lanjut" / "Maya, continue" ends the pause.
export function pauseCommand(text) {
  const t = String(text || '').trim();
  if (/^maya[,!.\s]*\s*(diam|quiet|stop|hush)\b/i.test(t)) return 'pause';
  if (/^maya[,!.\s]*\s*(lanjut|continue|resume|kembali)\b/i.test(t)) return 'resume';
  return null;
}

// ── Tools ───────────────────────────────────────────────────────────
const READ_TOOLS = [
  { name: 'schedule', description: 'Housekeeping visits (cleans, inspections, deep cleans) with who is assigned and their status, for a date range. Default: today and tomorrow.',
    input_schema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, slug: { type: 'string' }, staff: { type: 'string', description: 'housekeeper first name' } } } },
  { name: 'stays', description: 'Guest stays from the booking calendar for the managed villas: arrivals, departures, nights, channel, guest name, same-day turnovers. Default: the next 14 days.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, slug: { type: 'string' } } } },
  { name: 'readiness', description: 'Pre-guest photo checks in the last N days: which passed, which were flagged and why, which never got photos.',
    input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'maintenance_queue', description: 'Maintenance tickets, optionally by status (new, pending_approval, approved, scheduled, done, declined) or villa slug. Open tickets by default.',
    input_schema: { type: 'object', properties: { status: { type: 'string' }, slug: { type: 'string' } } } },
  { name: 'ticket', description: 'One maintenance ticket in full, including its thread, cost, tukang and photos count.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'backlog', description: 'What is waiting on Era right now: tickets needing review, a cost, publishing, a tukang, or completion — the same list as her nudge.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'statements_status', description: 'Monthly statements per property group: period, status (draft/published/partial/paid), payout, paid so far, outstanding. No bank details.',
    input_schema: { type: 'object', properties: { group_key: { type: 'string' }, months: { type: 'number' } } } },
  { name: 'payroll_status', description: 'Payroll runs (entity samba or double8): period, status, run total, paid, outstanding; one run in detail by id with amounts per payee. Never account numbers.',
    input_schema: { type: 'object', properties: { entity: { type: 'string' }, run_id: { type: 'number' } } } },
  { name: 'staff_lookup', description: 'The staff registry: who covers which villa, roles, trades, WhatsApp numbers.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, role: { type: 'string' } } } },
  { name: 'viewings', description: 'Viewing requests and confirmed viewings in the coming days, with the agent and the villa.',
    input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'open_relays', description: 'Questions from agents that are still waiting for an answer from this person.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'villa_standard', description: 'A villa\'s standard: the minimum kit and which items it has, the consumables par levels, the photo spots.',
    input_schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
  { name: 'records', description: 'Housekeeping records (cleans, photo checks, inspections) for a villa over a period, with outcomes and what was flagged.',
    input_schema: { type: 'object', properties: { slug: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'recent_from_maya', description: 'What Maya sent this person recently (alerts, nudges, questions), to answer "what was that message about".',
    input_schema: { type: 'object', properties: { hours: { type: 'number' } } } },
  { name: 'handbook', description: 'Read one section of the Samba Handbook by key (guides, cockpit how-tos, policies, glossary, how the system is wired). Call with no key to list the keys.',
    input_schema: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'not_for_me', description: 'The message is not addressed to Maya: a note meant for Ikiel or Era, an aside, a forwarded chat, small talk between colleagues. Say nothing; it is passed on. Give the reason.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
];
const ADMIN_TOOLS = [
  { name: 'agent_lookup', description: 'Find a rental agent by name, agency or number: tier, last message, notes.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'owner_lookup', description: 'Find an owner by name or number: villas, status, notes.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'campaign_status', description: 'Every campaign in the command center: on or paused, daily cap, last run.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'delivery_health', description: 'WhatsApp delivery over the last two weeks: sent, failed, stuck, read rate, by day.',
    input_schema: { type: 'object', properties: {} } },
];

const idr = (n) => n == null ? null : `IDR ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const compact = (o, n = 9000) => { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n - 20) + '…(truncated)"}' : s; };

async function runTool(db, name, input, { role, fromNum }) {
  const names = await catalogNames(db).catch(() => ({}));
  const villa = (slug) => names[slug] || slug;

  if (name === 'schedule') {
    const from = input.from || today(), to = input.to || plus(from, 1);
    const rows = (await sbGet(db, `housekeeping_tasks?task_date=gte.${from}&task_date=lte.${to}&status=neq.skipped${input.slug ? `&slug=eq.${encodeURIComponent(input.slug)}` : ''}&select=id,slug,kind,task_date,status,same_day,guest_in_date,done_at,notes,staff:assigned_staff_id(name)&order=task_date.asc,slug.asc&limit=120`)) || [];
    const out = rows.filter(r => !input.staff || (r.staff?.name || '').toLowerCase().startsWith(String(input.staff).toLowerCase()))
      .map(r => ({ task_id: r.id, date: r.task_date, villa: villa(r.slug), slug: r.slug, kind: r.kind, who: r.staff?.name || null, status: r.status, same_day: !!r.same_day, guest_in: r.guest_in_date || undefined, notes: r.notes || undefined }));
    return { from, to, visits: out };
  }
  if (name === 'stays') {
    const from = input.from || today(), to = input.to || plus(from, 14);
    const feed = await fetchStays({ from: plus(from, -1), to });
    if (!feed?.units) return { error: 'booking calendar unavailable right now — do not guess dates' };
    const units = feed.units.filter(u => !input.slug || u.slug === input.slug);
    return { from, to, units: units.map(u => ({ villa: u.name || villa(u.slug), slug: u.slug, stays: (u.stays || []).filter(s => s.check_out >= from && s.check_in <= to).map(s => ({ guest: s.guest || null, channel: s.channel || null, check_in: s.check_in, check_out: s.check_out, nights: s.nights, same_day_turnover: !!s.same_day_turnover })) })) };
  }
  if (name === 'readiness') {
    const days = Math.min(30, input.days || 7);
    const rows = await readinessForWindow(db, { from: plus(today(), -days), to: today() });
    return { days, checks: (rows || []).map(c => ({ villa: villa(c.slug), kind: c.kind, status: c.status, flags: c.flags || [], who: c.staff || c.by || undefined, guest_in: c.guest_in_date || undefined, asked_at: c.asked_at })) };
  }
  if (name === 'maintenance_queue') {
    const items = await listItems(db, { status: input.status || null, open_only: !input.status });
    return { tickets: (items || []).filter(i => !input.slug || i.slug === input.slug).map(i => ({ id: i.id, villa: i.unit_label ? `${i.statement_groups?.name || i.group_key} (${i.unit_label})` : (i.statement_groups?.name || villa(i.slug || i.group_key)), title: i.title, status: i.status, urgency: i.urgency, estimate: idr(i.estimated_cost), actual: idr(i.actual_cost), tukang: i.staff?.name || undefined, reported: String(i.reported_at || i.created_at || '').slice(0, 10), photos: (i.photos || []).length })) };
  }
  if (name === 'ticket') {
    const it = await getItem(db, Number(input.id));
    if (!it) return { error: `no ticket #${input.id}` };
    return { id: it.id, villa: it.statement_groups?.name || it.group_key, unit: it.unit_label, title: it.title, description: it.description, status: it.status, urgency: it.urgency, requires_approval: it.requires_approval, estimate: idr(it.estimated_cost), actual: idr(it.actual_cost), reported_by: it.reported_by_name, reported: it.reported_at, published: it.published_at, approved: it.approved_at, completed: it.completed_at, completion_note: it.completion_note, heads_up: !!it.heads_up_at, snoozed_until: it.next_followup_at, photos: (it.photos || []).length, thread: (it.thread || []).slice(-8) };
  }
  if (name === 'backlog') return { waiting_on_era: await eraBacklog(db, {}) };
  if (name === 'statements_status') {
    const groups = (await listGroups(db, { activeOnly: true })) || [];
    const months = Math.min(12, input.months || 3);
    const out = [];
    for (const g of groups.filter(g => !input.group_key || g.key === input.group_key)) {
      const sts = (await sbGet(db, `statements?group_key=eq.${encodeURIComponent(g.key)}&select=period,status,payout_total,paid_total,published_at,paid_at&order=period.desc&limit=${months}`)) || [];
      out.push({ group: g.name, key: g.key, owners: g.owner_names || null, tracks_payments: g.tracks_payments !== false, statements: sts.map(s => ({ period: s.period, status: s.status, payout: idr(s.payout_total), paid: idr(s.paid_total || 0), outstanding: idr(Math.max(0, Number(s.payout_total || 0) - Number(s.paid_total || 0))), published: s.published_at ? String(s.published_at).slice(0, 10) : null })) });
    }
    return { groups: out };
  }
  if (name === 'payroll_status') {
    if (input.run_id) {
      const d = await runDetail(db, Number(input.run_id));
      if (!d) return { error: 'no such run' };
      return { period: d.run.period, entity: d.run.entity, status: d.run.status, total: idr(d.run.run_total), paid: idr(d.run.paid_total), lines: (d.lines || []).map(l => ({ payee: l.payee || l.person || l.staff_name, kind: l.kind || l.category, villa: l.slug || l.property, amount: idr(l.amount) })), payments: (d.payments || []).map(p => ({ payee: p.payee, amount: idr(p.amount), at: String(p.paid_at || p.created_at || '').slice(0, 10) })) };
    }
    const r = await listRuns(db, { entity: input.entity || 'samba' });
    return { entity: input.entity || 'samba', outstanding: { count: r.outstanding.count, total: idr(r.outstanding.total) }, runs: (r.runs || []).slice(0, 6).map(x => ({ id: x.id, period: x.period, status: x.status, total: idr(x.run_total), paid: idr(x.paid_total) })) };
  }
  if (name === 'staff_lookup') {
    const people = (await listStaff(db, { active_only: true, role: input.role || null })) || [];
    const q = String(input.name || '').toLowerCase();
    return { staff: people.filter(p => (!q || String(p.name).toLowerCase().includes(q)) && (!input.slug || (p.slugs || []).includes(input.slug) || !(p.slugs || []).length)).map(p => ({ id: p.id, name: p.name, wa: p.wa_num, roles: p.roles, trades: p.trades || undefined, villas: (p.slugs || []).map(villa) })) };
  }
  if (name === 'viewings') {
    const days = Math.min(30, input.days || 7);
    const rows = (await sbGet(db, `viewings?status=in.(requested,confirmed)&select=id,property_name,rental_slug,agent_name,requested_window,scheduled_at,status,contact_name&order=created_at.desc&limit=30`)) || [];
    const until = new Date(Date.now() + days * 86400e3).toISOString();
    return { viewings: rows.filter(v => !v.scheduled_at || v.scheduled_at <= until).map(v => ({ id: v.id, villa: v.property_name, agent: v.agent_name, status: v.status, requested: v.requested_window, scheduled_at: v.scheduled_at, contact: v.contact_name })) };
  }
  if (name === 'open_relays') {
    const rows = await openRelaysForContact(db, fromNum).catch(() => []);
    return { open: (rows || []).map(r => ({ id: r.id, villa: r.property_name || r.slug, question: r.question, asked: String(r.asked_at || r.created_at || '').slice(0, 16) })) };
  }
  if (name === 'villa_standard') {
    const std = await standardFor(db, input.slug);
    return { villa: villa(input.slug), kit: (std.kit || []).map(k => ({ item: k.label, present: k.present })), consumables: std.consumables, photo_spots: (std.photo_spots || []).map(s => s.en || s.id), notes: std.notes || null };
  }
  if (name === 'records') {
    const d = await ownerRecords(db, { slugs: [input.slug], from: input.from, to: input.to });
    return { villa: villa(input.slug), from: d.from, to: d.to, records: d.records.slice(0, 40).map(r => ({ date: r.date, kind: r.kind, type: r.type, status: r.status, photos: r.photo_count, flagged: r.flagged?.map(f => f.spot) || undefined, findings: r.findings || undefined, restock: r.restock || undefined })) };
  }
  if (name === 'recent_from_maya') {
    const hours = Math.min(72, input.hours || 24);
    const since = new Date(Date.now() - hours * 3600e3).toISOString();
    const rows = (await sbGet(db, `wa_messages?wa_num=eq.${fromNum}&direction=eq.outbound&timestamp=gte.${encodeURIComponent(since)}&select=timestamp,content,category&order=timestamp.desc&limit=15`)) || [];
    return { messages: rows.map(m => ({ at: String(m.timestamp).slice(0, 16), kind: m.category || null, text: String(m.content || '').slice(0, 400) })) };
  }
  if (name === 'handbook') {
    const aud = role === 'admin' ? 'system' : 'era';
    if (!input.key) return { sections: handbookIndex(aud).concat(role === 'admin' ? handbookIndex('era').filter(x => !handbookIndex('system').some(y => y.key === x.key)) : []) };
    return handbookSection(input.key, aud) || handbookSection(input.key, 'era') || { error: `no section "${input.key}"` };
  }
  if (name === 'not_for_me') return { ok: true };

  if (role === 'admin') {
    if (name === 'agent_lookup') {
      const q = String(input.query || '').replace(/[%,()"\\*]/g, ' ').trim();
      const digits = q.replace(/\D/g, '');
      const filter = digits.length >= 6 ? `wa_num=like.*${digits}*` : `or=(name.ilike.*${encodeURIComponent(q)}*,agency.ilike.*${encodeURIComponent(q)}*)`;
      const rows = (await sbGet(db, `agents?${filter}&select=id,name,agency,wa_num,engagement_tier,last_inbound_at,notes,samba_alerts_opt_out&limit=8`)) || [];
      return { agents: rows.map(a => ({ id: a.id, name: a.name, agency: a.agency, wa: a.wa_num, tier: a.engagement_tier, last_inbound: a.last_inbound_at, opted_out: !!a.samba_alerts_opt_out, notes: String(a.notes || '').slice(0, 300) })) };
    }
    if (name === 'owner_lookup') {
      const q = String(input.query || '').replace(/[%,()"\\*]/g, ' ').trim();
      const digits = q.replace(/\D/g, '');
      const filter = digits.length >= 6 ? `wa_num=like.*${digits}*` : `name=ilike.*${encodeURIComponent(q)}*`;
      const rows = (await sbGet(db, `owners?${filter}&select=id,name,wa_num,listing_slugs,onboarding_status,notes,paused&limit=8`)) || [];
      return { owners: rows.map(o => ({ id: o.id, name: o.name, wa: o.wa_num, villas: (o.listing_slugs || []).map(villa), status: o.onboarding_status, paused: !!o.paused, notes: String(o.notes || '').slice(0, 300) })) };
    }
    if (name === 'campaign_status') {
      const rows = (await sbGet(db, `campaigns?select=*&order=id.asc&limit=40`)) || [];
      return { campaigns: rows.map(c => ({ key: c.key || c.id, name: c.name, status: c.status, paused: !!(c.paused || c.status === 'paused'), daily_cap: c.daily_cap ?? c.cap ?? null, last_run: c.last_run_at || c.last_sent_at || null })) };
    }
    if (name === 'delivery_health') {
      const { buildTrend } = await import('./delivery-health.js');
      const t = await buildTrend(db, { days: 14 });
      return compactObj(t);
    }
  }
  return { error: `unknown tool ${name}` };
}
const compactObj = (o) => JSON.parse(compact(o, 6000).replace(/…\(truncated\)"\}$/, '"}')) ;

// ── Prompt ──────────────────────────────────────────────────────────
function systemPrompt({ role, name, ctx, paused }) {
  const who = role === 'admin' ? 'Ikiel, your boss, who runs Samba Realty and KAYA Developments' : 'Era, Ikiel\'s villa manager and personal assistant, who runs operations on the ground for the villas Samba manages: viewings, keys and check-in, guest issues, cleaning, repairs, supplies';
  return `You are Maya, Samba Realty's assistant, on WhatsApp with ${who}. You are a colleague: direct, warm, brief. Today is ${witaNow().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} in Bali (WITA).

WHAT YOU DO HERE
- Answer questions about the villas, guests, cleaning, repairs, statements, payroll, staff, viewings and how the system works — from your tools, never from memory. If a tool returns nothing or an error, say so plainly; never invent a date, a name or an amount.
- Answer ONLY the message marked "just sent". The recent thread below is background so you understand references ("that ticket", "the one from this morning"); never summarise it, act on it, or answer earlier messages in it.
- Any question or request — a sentence with "?" or starting siapa / kapan / berapa / apa / bagaimana / di mana / who / when / how much / what / which / where / can you / tolong — is for you: answer it with your tools. Call not_for_me ONLY for a message with no question and no request to you: a note clearly for ${role === 'admin' ? 'Era' : 'Ikiel'} by name, a forwarded chat, small talk, a plain status update with nothing to look up. It is then passed on to a person. When in doubt, answer.
- Things you cannot do from WhatsApp, say so and give the page: publishing a statement, recording a payment, payroll payments, bank details, deleting anything, rebuilding the schedule — those are on sambarentals.com/payouts. Changes to tickets and cleans are coming to this chat soon; for now point at the page.
- Reply in the language of the message (${role === 'admin' ? 'English' : 'Era writes English and Indonesian, often mixed'}). WhatsApp formatting only: no markdown headings, no **double stars**; *single stars* for bold, sparingly; "•" or numbers for lists. At most 8 lines unless a list genuinely needs more. Lead with the answer.
- Names, not slugs, for villas and people. Dates as "Mon 7 Sep". Money as IDR with thousands separators.
${paused ? '\nYou are paused on this number: reply with one line saying so and nothing else.\n' : ''}
${role === 'admin' ? handbookDigest('system') : handbookDigest('era')}

${role === 'admin' ? '' : `THE HOUSEKEEPING SOP (what the housekeepers and you work to)\n${SOP}\n`}
${ctx ? `\nLIVE CONTEXT FOR ${name.toUpperCase()}\n${ctx}\n` : ''}`;
}

// Short acknowledgements never need an answer; the webhook filters them
// too, this keeps the dry run honest.
const BARE_ACK = /^(ok(ay|e|ee)?|oke|okk+|ya|yes|yep|noted|siap|sip|thanks?|thank you|thx|makasih|terima kasih|got it|👍|🙏|✅|👌)[\s.!,]*(maya|kak|ya|ok)?[\s.!,🙏👍]*$/i;

async function recentThread(db, num, n = 12) {
  const rows = (await sbGet(db, `wa_messages?wa_num=eq.${num}&select=direction,content,timestamp&order=timestamp.desc&limit=${n}`)) || [];
  return rows.reverse().map(m => `${m.direction === 'inbound' ? 'THEM' : 'MAYA'} (${String(m.timestamp).slice(5, 16)}): ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
}

async function spendToday(db) {
  const u = (await getSettingValue(db, USAGE_KEY).catch(() => null)) || {};
  return Number(u[today()] || 0);
}
async function addSpend(db, usd) {
  const u = (await getSettingValue(db, USAGE_KEY).catch(() => null)) || {};
  u[today()] = Number(u[today()] || 0) + usd;
  for (const k of Object.keys(u)) if (k < plus(today(), -30)) delete u[k];
  await saveSettingValue(db, USAGE_KEY, u).catch(() => {});
}
async function logCalls(db, entries) {
  if (!entries.length) return;
  const log = (await getSettingValue(db, LOG_KEY).catch(() => null)) || [];
  const next = [...(Array.isArray(log) ? log : []), ...entries].slice(-300);
  await saveSettingValue(db, LOG_KEY, next).catch(() => {});
}

const waFormat = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '').trim();

// ── The handler ─────────────────────────────────────────────────────
// Returns false when not claimed; otherwise { claimed, outcome, reply, tools, cost_usd }.
export async function handleTeamMessage({ db, wa, fromNum, text, apiKey = process.env.ANTHROPIC_API_KEY, dryRun = false, role: roleOverride = null }) {
  const num = String(fromNum || '').replace(/\D/g, '');
  const role = roleOverride || roleFor(num);
  if (!role || !apiKey) return false;
  const body = String(text || '').trim();
  if (!body || BARE_ACK.test(body)) return false;

  // Pause and resume, deterministic.
  const cmd = pauseCommand(body);
  if (cmd) {
    const key = `team_assistant_paused:${num}`;
    if (cmd === 'pause') { await saveSettingValue(db, key, { until: new Date(Date.now() + 12 * 3600e3).toISOString() }); }
    else await saveSettingValue(db, key, null);
    const reply = cmd === 'pause' ? 'Baik, saya diam di chat ini sampai 12 jam ke depan. Tulis "Maya, lanjut" kalau perlu saya lagi.' : 'Siap, saya lanjut.';
    if (!dryRun && wa) await sendText(wa, num, reply);
    return { claimed: true, outcome: cmd, reply, tools: [], cost_usd: 0 };
  }
  const paused = await getSettingValue(db, `team_assistant_paused:${num}`).catch(() => null);
  if (paused?.until && paused.until > nowIso()) return false;

  if ((await spendToday(db)) >= DAILY_CAP_USD) return { claimed: false, outcome: 'capped', reply: '', tools: [], cost_usd: 0 };

  const name = role === 'admin' ? 'Ikiel' : 'Era';
  const ctx = role === 'era' ? await personContext(db, null, 'era').catch(() => '') : '';
  const thread = await recentThread(db, num).catch(() => '');
  const system = systemPrompt({ role, name, ctx, paused: false }) + (thread ? `\nRECENT THREAD (background only — do not answer or summarise it)\n${thread}\n` : '');
  const tools = role === 'admin' ? [...READ_TOOLS, ...ADMIN_TOOLS] : READ_TOOLS;
  const msgs = [{ role: 'user', content: `${name} just sent: "${body}"\n\nAnswer this message only.` }];

  const calls = [];
  let cost = 0, finalText = '', outcome = 'answered', notForMe = null;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools, messages: msgs }),
    });
    const resp = await r.json().catch(() => ({}));
    if (!r.ok) { outcome = 'error'; finalText = ''; calls.push({ at: nowIso(), error: resp?.error?.message || `HTTP ${r.status}` }); break; }
    cost += (resp.usage?.input_tokens || 0) * PRICE.in + (resp.usage?.output_tokens || 0) * PRICE.out;
    const uses = (resp.content || []).filter(b => b.type === 'tool_use');
    const texts = (resp.content || []).filter(b => b.type === 'text').map(b => b.text);
    if (resp.stop_reason !== 'tool_use' || !uses.length) { finalText = texts.join('\n').trim(); break; }
    msgs.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of uses) {
      const t0 = Date.now();
      let result;
      if (tu.name === 'not_for_me') { notForMe = String(tu.input?.reason || 'not addressed to Maya'); result = { ok: true }; }
      else { try { result = await runTool(db, tu.name, tu.input || {}, { role, fromNum: num }); } catch (e) { result = { error: e.message }; } }
      calls.push({ at: nowIso(), who: name, tool: tu.name, input: tu.input || {}, ok: !result?.error, ms: Date.now() - t0 });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: compact(result) });
    }
    if (notForMe) break;
    msgs.push({ role: 'user', content: results });
    if (i === MAX_ITERATIONS - 1) { finalText = texts.join('\n').trim() || 'Saya kehabisan langkah — coba tanya lagi dengan lebih spesifik.'; outcome = 'capped'; }
  }

  if (!dryRun) { await addSpend(db, cost); await logCalls(db, calls.map(c => ({ ...c, dry: false }))); }
  if (notForMe) return { claimed: false, outcome: 'not_for_me', reason: notForMe, reply: '', tools: calls.map(c => c.tool), cost_usd: cost };
  const reply = waFormat(finalText);
  if (!reply) return { claimed: false, outcome: outcome === 'error' ? 'error' : 'empty', reply: '', tools: calls.map(c => c.tool), cost_usd: cost };
  if (!dryRun && wa) await sendText(wa, num, reply);
  return { claimed: true, outcome, reply, tools: calls.map(c => c.tool), cost_usd: cost };
}
