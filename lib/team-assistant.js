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
// Writes come in three tiers. Tier 1 applies at once and reads back with an
// Undo button (mark a clean done, move it, an estimate, a note). Tier 2
// messages someone else, so it waits for Yes (publish to the owner,
// dispatch a tukang, message a housekeeper). Tier 3 never happens here:
// publishing a statement, recording a payment, payroll, bank details,
// deleting — those stay on the Payouts page.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { catalogNames, fetchStays } from './housekeeping.js';
import { standardFor, readinessForWindow } from './housekeeping-readiness.js';
import { ownerRecords } from './housekeeping-owner.js';
import { listItems, getItem, patchItem, appendThread, snoozeItem, publishItem, headsUpItem, completeItem } from './maintenance.js';
import { assignTukang } from './maintenance-dispatch.js';
import { openReadiness } from './housekeeping-readiness.js';
import { eraBacklog } from './maintenance-backlog.js';
import { listGroups } from './statements.js';
import { listRuns, runDetail } from './payroll.js';
import { listStaff, upsertStaff } from './staff.js';
import { openRelaysForContact } from './relay.js';
import { handbookDigest, handbookSection, handbookIndex } from './handbook.js';
import { SOP, personContext } from './staff-help.js';
import { sendText, sendButtons, sendList, parseTap } from './wa-interactive.js';

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
// Tier 1: applied immediately, read back, undoable for 30 minutes.
const WRITE_TOOLS_T1 = [
  { name: 'hk_set_status', description: 'Mark a housekeeping visit done or skipped (task_id from the schedule tool). Applied at once; undoable.',
    input_schema: { type: 'object', properties: { task_id: { type: 'number' }, status: { type: 'string', enum: ['done', 'skipped'] } }, required: ['task_id', 'status'] } },
  { name: 'hk_move', description: 'Move a housekeeping visit to another day (YYYY-MM-DD). The housekeeper is told again on the new day. Applied at once; undoable.',
    input_schema: { type: 'object', properties: { task_id: { type: 'number' }, date: { type: 'string' } }, required: ['task_id', 'date'] } },
  { name: 'hk_reassign', description: 'Give a housekeeping visit to another housekeeper (staff_id from staff_lookup). Applied at once; undoable.',
    input_schema: { type: 'object', properties: { task_id: { type: 'number' }, staff_id: { type: 'number' } }, required: ['task_id', 'staff_id'] } },
  { name: 'hk_add', description: 'Add a housekeeping visit: villa slug, day, kind (regular, turnover, pre_arrival, deep_clean, inspection), optional staff_id. Applied at once; undoable.',
    input_schema: { type: 'object', properties: { slug: { type: 'string' }, date: { type: 'string' }, kind: { type: 'string' }, staff_id: { type: 'number' }, notes: { type: 'string' } }, required: ['slug', 'date', 'kind'] } },
  { name: 'maint_estimate', description: 'Set the estimated cost (IDR, a plain number) on a maintenance ticket. Applied at once; undoable. Does not publish.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, cost: { type: 'number' } }, required: ['id', 'cost'] } },
  { name: 'maint_note', description: 'Add a remark to a ticket\'s thread without changing its state. Cannot be undone.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'maint_move', description: 'Move a ticket filed under the wrong villa to the right one (villa slug). Applied at once; undoable.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, slug: { type: 'string' } }, required: ['id', 'slug'] } },
  { name: 'maint_snooze', description: 'Note that a ticket is waiting on something, with the date to ask again (YYYY-MM-DD) and why. Applied at once; undoable.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, until: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } },
  { name: 'brief_hour', description: 'Set the hour (WITA, 5–11) of Era\'s morning brief; it goes out at five past that hour. Applied at once; undoable.',
    input_schema: { type: 'object', properties: { hour: { type: 'number' } }, required: ['hour'] } },
  { name: 'log_expense', description: 'File a villa expense Era paid: property group key (from statements_status), amount in IDR, what for, date (default today). Lands on the month\'s draft statement, or waits for it; a published month becomes a change request for Ikiel. Applied at once; undoable. If she mentions a receipt photo, tell her to send it right after.',
    input_schema: { type: 'object', properties: { group_key: { type: 'string' }, amount: { type: 'number' }, description: { type: 'string' }, expense_date: { type: 'string' }, unit: { type: 'string' } }, required: ['group_key', 'amount', 'description'] } },
];
// Tier 2: someone else gets a message, so it waits for a Yes.
const WRITE_TOOLS_T2 = [
  { name: 'maint_publish', description: 'Publish a ticket to the owner: either ask them to approve the cost (requires_approval true) or tell them it is routine and scheduled (false). Optionally set the estimate at the same time. Routine work needs no cost; when Era says publish, stage it — do not argue about a missing estimate. Waits for Yes.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, requires_approval: { type: 'boolean' }, estimated_cost: { type: 'number' } }, required: ['id', 'requires_approval'] } },
  { name: 'maint_heads_up', description: 'Tell the owner now about a new ticket, cost to follow. Waits for Yes.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'maint_assign', description: 'Dispatch an approved ticket to a tukang (staff_id from staff_lookup, role tukang). Maya sends him the job sheet. Waits for Yes.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, staff_id: { type: 'number' } }, required: ['id', 'staff_id'] } },
  { name: 'maint_complete', description: 'Mark a ticket done, with a note and the final cost if known. The owner is told. Waits for Yes.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, note: { type: 'string' }, actual_cost: { type: 'number' } }, required: ['id'] } },
  { name: 'message_staff', description: 'Send a WhatsApp message to a staff member on Era\'s behalf (write it in Indonesian for housekeepers). Waits for Yes; Era sees the exact text first.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'] } },
  { name: 'reask_readiness', description: 'Ask the housekeeper again for the pre-guest photos of a visit (task_id). Waits for Yes.',
    input_schema: { type: 'object', properties: { task_id: { type: 'number' } }, required: ['task_id'] } },
  { name: 'staff_update', description: 'Change a staff member\'s WhatsApp number, villas or roles. Waits for Yes.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, wa_num: { type: 'string' }, slugs: { type: 'array', items: { type: 'string' } }, roles: { type: 'array', items: { type: 'string' } } }, required: ['id'] } },
  { name: 'statement_change', description: 'Add, remove or change an expense or adjustment line on a monthly statement ("add laundry 250,000 to HAUS 5 August"). Maya restates it and asks for YES; a published statement goes to Ikiel to approve.',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'the change in plain words, with villa, month, amount and description' } }, required: ['text'] } },
  { name: 'ask_pick', description: 'When a task, ticket, villa or person is ambiguous, offer a list to tap (2–10 choices). Say what you intend to do once they pick. Stops this turn.',
    input_schema: { type: 'object', properties: { intent: { type: 'string', description: 'what you will do with the pick, e.g. "move the clean to Thursday"' }, question: { type: 'string' }, choices: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'title'] } } }, required: ['intent', 'question', 'choices'] } },
];
const NEVER_HERE = 'publishing a statement, recording a payment, payroll, bank details, deleting a ticket or staff member, rebuilding the schedule';

const ADMIN_TOOLS = [
  { name: 'agent_lookup', description: 'Find a rental agent by name, agency or number: tier, last message, notes.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'owner_lookup', description: 'Find an owner by name or number: villas, status, notes.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'campaign_status', description: 'Every campaign in the command center: on or paused, daily cap, last run.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'delivery_health', description: 'WhatsApp delivery over the last two weeks: sent, failed, stuck, read rate, by day.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'system_map', description: 'How the system is wired, generated from code: routes, crons (Bali times), settings keys, env variable names, signed-link helpers.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['routes', 'crons', 'settings', 'env', 'links'] } }, required: ['topic'] } },
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
    if (name === 'system_map') return handbookSection(`system.${input.topic}`, 'system') || { error: 'topic must be routes, crons, settings, env or links' };
    if (name === 'delivery_health') {
      const { buildTrend } = await import('./delivery-health.js');
      const t = await buildTrend(db, { days: 14 });
      return compactObj(t);
    }
  }
  return { error: `unknown tool ${name}` };
}
const compactObj = (o) => JSON.parse(compact(o, 6000).replace(/…\(truncated\)"\}$/, '"}')) ;

// ── Writes ──────────────────────────────────────────────────────────
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
async function sbPatch(db, path, body) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return r.json().catch(() => []);
}
const KINDS = ['regular', 'turnover', 'pre_arrival', 'deep_clean', 'inspection'];
const dayLabel = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// Tier 1. Returns { summary, inverse } — inverse is a plain patch or delete
// so undo needs no model and no second opinion.
async function applyWrite(db, tool, input, { actor, dryRun, villa }) {
  const task = async (id) => (await sbGet(db, `housekeeping_tasks?id=eq.${id}&select=*,staff:assigned_staff_id(name)&limit=1`))?.[0];
  if (tool === 'hk_set_status') {
    const t = await task(input.task_id); if (!t) throw new Error(`no visit #${input.task_id}`);
    const summary = `${villa(t.slug)} ${t.kind.replace('_', ' ')} on ${dayLabel(t.task_date)} → ${input.status}`;
    if (dryRun) return { summary, would: true };
    await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, { status: input.status, done_at: input.status === 'done' ? nowIso() : t.done_at, updated_at: nowIso() });
    return { summary, inverse: { table: 'housekeeping_tasks', id: t.id, fields: { status: t.status, done_at: t.done_at } } };
  }
  if (tool === 'hk_move') {
    const t = await task(input.task_id); if (!t) throw new Error(`no visit #${input.task_id}`);
    if (!isDay(input.date)) throw new Error('date must be YYYY-MM-DD');
    if (input.date < today()) throw new Error('that day has already passed');
    const summary = `${villa(t.slug)} ${t.kind.replace('_', ' ')} moved ${dayLabel(t.task_date)} → ${dayLabel(input.date)}${t.staff?.name ? ` (${t.staff.name} is told on the day)` : ''}`;
    if (dryRun) return { summary, would: true };
    await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, { task_date: input.date, status: 'planned', notified_at: null, moved_by: actor, moved_at: nowIso(), updated_at: nowIso() });
    return { summary, inverse: { table: 'housekeeping_tasks', id: t.id, fields: { task_date: t.task_date, status: t.status, notified_at: t.notified_at, moved_by: t.moved_by, moved_at: t.moved_at } } };
  }
  if (tool === 'hk_reassign') {
    const t = await task(input.task_id); if (!t) throw new Error(`no visit #${input.task_id}`);
    const p = (await sbGet(db, `staff?id=eq.${Number(input.staff_id)}&select=id,name&limit=1`))?.[0]; if (!p) throw new Error('no such staff member');
    const summary = `${villa(t.slug)} ${t.kind.replace('_', ' ')} on ${dayLabel(t.task_date)} → ${p.name}${t.staff?.name ? ` (was ${t.staff.name})` : ''}`;
    if (dryRun) return { summary, would: true };
    await sbPatch(db, `housekeeping_tasks?id=eq.${t.id}`, { assigned_staff_id: p.id, notified_at: null, status: t.status === 'done' ? t.status : 'planned', updated_at: nowIso() });
    return { summary, inverse: { table: 'housekeeping_tasks', id: t.id, fields: { assigned_staff_id: t.assigned_staff_id, notified_at: t.notified_at, status: t.status } } };
  }
  if (tool === 'hk_add') {
    if (!KINDS.includes(input.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    if (!isDay(input.date) || input.date < today()) throw new Error('date must be today or later, YYYY-MM-DD');
    const summary = `new ${input.kind.replace('_', ' ')} at ${villa(input.slug)} on ${dayLabel(input.date)}`;
    if (dryRun) return { summary, would: true };
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/housekeeping_tasks`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ slug: input.slug, task_date: input.date, origin_date: input.date, kind: input.kind, status: 'planned', assigned_staff_id: input.staff_id ? Number(input.staff_id) : null, notes: input.notes ? String(input.notes).slice(0, 500) : null, moved_by: actor, moved_at: nowIso() }) });
    if (r.status === 409) throw new Error('there is already such a visit at that villa on that day');
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    const row = (await r.json())[0];
    return { summary, inverse: { table: 'housekeeping_tasks', delete: row.id } };
  }
  if (tool === 'maint_estimate') {
    const it = await getItem(db, Number(input.id)); if (!it) throw new Error(`no ticket #${input.id}`);
    const cost = Math.round(Number(input.cost) || 0); if (!cost) throw new Error('cost must be a number of rupiah');
    const summary = `#${it.id} ${it.title.slice(0, 40)} → estimate ${idr(cost)}${it.status === 'new' ? ' (still needs publishing)' : ''}`;
    if (dryRun) return { summary, would: true };
    await patchItem(db, it.id, { estimated_cost: cost });
    await appendThread(db, it.id, { who: actor, text: `Estimate ${idr(cost)} (via Maya)` });
    return { summary, inverse: { table: 'maintenance_items', id: it.id, fields: { estimated_cost: it.estimated_cost } } };
  }
  if (tool === 'maint_note') {
    const it = await getItem(db, Number(input.id)); if (!it) throw new Error(`no ticket #${input.id}`);
    const summary = `#${it.id} noted: ${String(input.text).slice(0, 80)}`;
    if (dryRun) return { summary, would: true };
    await appendThread(db, it.id, { who: actor, text: String(input.text).slice(0, 500) });
    return { summary, inverse: null };
  }
  if (tool === 'maint_move') {
    const it = await getItem(db, Number(input.id)); if (!it) throw new Error(`no ticket #${input.id}`);
    const groups = (await sbGet(db, `statement_groups?active=is.true&select=key,name,listing_slugs`)) || [];
    const group = groups.find(g => (g.listing_slugs || []).includes(input.slug)); if (!group) throw new Error(`no owner group holds ${input.slug}`);
    const summary = `#${it.id} ${it.title.slice(0, 40)} moved to ${villa(input.slug)}${it.notified_at ? ' — the previous owner had already been told; send them a word' : ''}`;
    if (dryRun) return { summary, would: true };
    await patchItem(db, it.id, { group_key: group.key, slug: input.slug, unit_label: null });
    await appendThread(db, it.id, { who: actor, text: `Moved from ${it.slug || it.group_key} to ${input.slug} (via Maya)` });
    return { summary, inverse: { table: 'maintenance_items', id: it.id, fields: { group_key: it.group_key, slug: it.slug, unit_label: it.unit_label } } };
  }
  if (tool === 'maint_snooze') {
    const it = await getItem(db, Number(input.id)); if (!it) throw new Error(`no ticket #${input.id}`);
    const until = isDay(input.until) && input.until >= today() ? input.until : null;
    const summary = `#${it.id} ${it.title.slice(0, 40)} → waiting${until ? ` until ${dayLabel(until)}` : ''}: ${String(input.note).slice(0, 60)}`;
    if (dryRun) return { summary, would: true };
    await snoozeItem(db, it.id, { untilDate: until || undefined, note: input.note, who: actor });
    return { summary, inverse: { table: 'maintenance_items', id: it.id, fields: { next_followup_at: it.next_followup_at, promised_date: it.promised_date || null } } };
  }
  if (tool === 'brief_hour') {
    const hour = Math.round(Number(input.hour));
    if (!(hour >= 5 && hour <= 11)) throw new Error('the brief hour must be between 5 and 11');
    const cfg = (await getSettingValue(db, 'era_brief')) || {};
    const summary = `morning brief now at ${String(hour).padStart(2, '0')}:05 WITA (was ${String(cfg.hour ?? 7).padStart(2, '0')}:05)`;
    if (dryRun) return { summary, would: true };
    await saveSettingValue(db, 'era_brief', { ...cfg, hour });
    return { summary, inverse: { setting: 'era_brief', fields: { hour: cfg.hour ?? 7 } } };
  }
  if (tool === 'log_expense') {
    const { logExpense } = await import('./expense-log.js');
    const date = isDay(input.expense_date) ? input.expense_date : today();
    const groups = (await sbGet(db, `statement_groups?active=is.true&select=key,name`)) || [];
    const g = groups.find(x => x.key === input.group_key); if (!g) throw new Error(`no property group "${input.group_key}" — use statements_status to see the keys`);
    const amount = Math.round(Number(input.amount) || 0); if (!amount) throw new Error('amount must be a number of rupiah');
    const summary = `${g.name}: ${String(input.description).slice(0, 60)} ${idr(amount)} (${date})`;
    if (dryRun) return { summary, would: true };
    const res = await logExpense(db, { group_key: g.key, period: date.slice(0, 7), expense_date: date, description: input.description, amount, unit: input.unit || null, by: actor });
    if (res.where === 'published') throw new Error(`${date.slice(0, 7)} for ${g.name} is already ${res.status}; ask me to "add ${input.description} ${amount} to ${g.name} ${date.slice(0, 7)}" and I stage it for Ikiel`);
    return { summary: `${summary} — ${res.where === 'draft' ? 'on the draft' : 'waiting for the month\'s draft'}`, inverse: res.where === 'draft' ? { table: 'statement_lines', delete: res.line_id, recompute: res.statement_id } : { inbox: res.id } };
  }
  throw new Error(`unknown write ${tool}`);
}

async function undoWrite(db, inverse) {
  if (!inverse) throw new Error('nothing to undo');
  if (inverse.setting) { const cur = (await getSettingValue(db, inverse.setting)) || {}; await saveSettingValue(db, inverse.setting, { ...cur, ...inverse.fields }); return; }
  if (inverse.inbox) { const { removeInboxItem } = await import('./expense-log.js'); await removeInboxItem(db, inverse.inbox); return; }
  if (inverse.delete) {
    await fetch(`${db.SUPABASE_URL}/rest/v1/${inverse.table}?id=eq.${inverse.delete}`, { method: 'DELETE', headers: db.sbHeaders });
    if (inverse.recompute) { const { recomputeTotals } = await import('./statements.js'); await recomputeTotals(db, inverse.recompute).catch(() => {}); }
    return;
  }
  await sbPatch(db, `${inverse.table}?id=eq.${inverse.id}`, { ...inverse.fields, updated_at: nowIso() });
}

// Tier 2: the summary Era confirms, then the deterministic execution.
async function describePending(db, tool, input, { villa }) {
  if (tool === 'maint_publish' || tool === 'maint_heads_up' || tool === 'maint_complete' || tool === 'maint_assign') {
    const it = await getItem(db, Number(input.id)); if (!it) throw new Error(`no ticket #${input.id}`);
    const owner = it.statement_groups?.owner_names || 'the owner';
    if (tool === 'maint_publish') return `Publish #${it.id} "${it.title.slice(0, 50)}" to ${owner}: ${input.requires_approval ? 'ask them to approve' : 'routine, just tell them'}${input.estimated_cost ? `, estimate ${idr(input.estimated_cost)}` : it.estimated_cost ? ` (estimate ${idr(it.estimated_cost)})` : ', no cost yet'}.`;
    if (tool === 'maint_heads_up') return `Tell ${owner} now about #${it.id} "${it.title.slice(0, 50)}", cost to follow.`;
    if (tool === 'maint_complete') return `Mark #${it.id} "${it.title.slice(0, 50)}" done${input.actual_cost ? `, final cost ${idr(input.actual_cost)}` : ''}${input.note ? ` — "${String(input.note).slice(0, 80)}"` : ''}. ${owner} will be told.`;
    const p = (await sbGet(db, `staff?id=eq.${Number(input.staff_id)}&select=id,name,roles&limit=1`))?.[0]; if (!p) throw new Error('no such tukang');
    return `Send #${it.id} "${it.title.slice(0, 50)}" to ${p.name}: he gets the job sheet and I tell you what he says.`;
  }
  if (tool === 'message_staff') {
    const people = await listStaff(db, { active_only: true });
    const p = people.find(x => String(x.name).toLowerCase().startsWith(String(input.name).toLowerCase())); if (!p) throw new Error(`no staff member named ${input.name}`);
    return `Send to ${p.name}:\n"${String(input.text).slice(0, 600)}"`;
  }
  if (tool === 'reask_readiness') {
    const t = (await sbGet(db, `housekeeping_tasks?id=eq.${Number(input.task_id)}&select=*,staff:assigned_staff_id(id,name,wa_num)&limit=1`))?.[0]; if (!t) throw new Error('no such visit');
    return `Ask ${t.staff?.name || 'the housekeeper'} again for the photos of ${villa(t.slug)} (${t.kind.replace('_', ' ')}, ${dayLabel(t.task_date)}).`;
  }
  if (tool === 'staff_update') {
    const p = (await sbGet(db, `staff?id=eq.${Number(input.id)}&select=id,name,wa_num,slugs,roles&limit=1`))?.[0]; if (!p) throw new Error('no such staff member');
    const parts = [];
    if (input.wa_num) parts.push(`number ${p.wa_num} → ${String(input.wa_num).replace(/\D/g, '')}`);
    if (input.slugs) parts.push(`villas → ${input.slugs.map(villa).join(', ')}`);
    if (input.roles) parts.push(`roles → ${input.roles.join(', ')}`);
    return `Update ${p.name}: ${parts.join('; ') || 'nothing'}.`;
  }
  throw new Error(`unknown action ${tool}`);
}
async function executePending(db, wa, pending, { actor, num }) {
  const { tool, input } = pending;
  if (tool === 'maint_publish') return publishItem(db, Number(input.id), { requires_approval: !!input.requires_approval, ...(input.estimated_cost ? { estimated_cost: input.estimated_cost } : {}), actor });
  if (tool === 'maint_heads_up') return headsUpItem(db, Number(input.id), { actor });
  if (tool === 'maint_assign') return assignTukang(db, Number(input.id), Number(input.staff_id), { actor });
  if (tool === 'maint_complete') return completeItem(db, Number(input.id), { note: input.note, ...(input.actual_cost ? { actual_cost: input.actual_cost } : {}), by: actor });
  if (tool === 'message_staff') {
    const people = await listStaff(db, { active_only: true });
    const p = people.find(x => String(x.name).toLowerCase().startsWith(String(input.name).toLowerCase())); if (!p) throw new Error('no such staff member');
    const to = String(p.wa_num).replace(/\D/g, '');
    const body = `${String(input.text).slice(0, 900)}\n\n— pesan dari Era, dikirim lewat Maya`;
    const mid = await sendText(wa, to, body);
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ wa_num: to, direction: 'outbound', content: body, timestamp: nowIso(), source: 'webhook', category: 'human:era', wa_message_id: typeof mid === 'string' ? mid : null, status: 'sent' }) }).catch(() => {});
    if (!mid) throw new Error('WhatsApp refused the message (her window may be shut)');
    return { ok: true, to: p.name };
  }
  if (tool === 'reask_readiness') {
    const t = (await sbGet(db, `housekeeping_tasks?id=eq.${Number(input.task_id)}&select=*,staff:assigned_staff_id(id,name,wa_num,active)&limit=1`))?.[0]; if (!t?.staff?.wa_num) throw new Error('no housekeeper on that visit');
    const names = await catalogNames(db).catch(() => ({}));
    const ask = await openReadiness(db, { task: t, person: t.staff, villa: names[t.slug] || t.slug });
    if (!ask) throw new Error('that kind of visit has no photo check');
    const mid = await sendText(wa, String(t.staff.wa_num).replace(/\D/g, ''), ask);
    if (!mid) throw new Error('WhatsApp refused (her window may be shut)');
    return { ok: true };
  }
  if (tool === 'staff_update') return upsertStaff(db, { id: input.id, ...(input.wa_num ? { wa_num: input.wa_num } : {}), ...(input.slugs ? { slugs: input.slugs } : {}), ...(input.roles ? { roles: input.roles } : {}) });
  throw new Error(`unknown action ${tool}`);
}

const YES_RE = /^(yes|y|ya|yes please|ok(ay)?|oke|sure|betul|benar|siap|correct|confirm(ed)?|go ahead|do it|lanjut|👍)[\s.!]*$/i;
const NO_RE = /^(no|nope|cancel|batal|jangan|tidak|stop|wrong|salah)[\s.!]*$/i;
const PENDING_MS = 30 * 60 * 1000;
const newId = () => Math.random().toString(36).slice(2, 8);

export async function hasPending(db, num) {
  const n = String(num || '').replace(/\D/g, '');
  const p = await getSettingValue(db, `team_pending:${n}`).catch(() => null);
  const k = await getSettingValue(db, `team_pick:${n}`).catch(() => null);
  return !!((p && p.expires_at > nowIso()) || (k && k.expires_at > nowIso()));
}

// ── Prompt ──────────────────────────────────────────────────────────
function systemPrompt({ role, name, ctx, paused }) {
  const who = role === 'admin' ? 'Ikiel, your boss, who runs Samba Realty and KAYA Developments' : 'Era, Ikiel\'s villa manager and personal assistant, who runs operations on the ground for the villas Samba manages: viewings, keys and check-in, guest issues, cleaning, repairs, supplies';
  return `You are Maya, Samba Realty's assistant, on WhatsApp with ${who}. You are a colleague: direct, warm, brief. Today is ${witaNow().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} in Bali (WITA).

WHAT YOU DO HERE
- Answer questions about the villas, guests, cleaning, repairs, statements, payroll, staff, viewings and how the system works — from your tools, never from memory. If a tool returns nothing or an error, say so plainly; never invent a date, a name or an amount.
- Answer ONLY the message marked "just sent". The recent thread below is background so you understand references ("that ticket", "the one from this morning"); never summarise it, act on it, or answer earlier messages in it.
- Any question or request — a sentence with "?" or starting siapa / kapan / berapa / apa / bagaimana / di mana / who / when / how much / what / which / where / can you / tolong — is for you: answer it with your tools. Call not_for_me ONLY for a message with no question and no request to you: a note clearly for ${role === 'admin' ? 'Era' : 'Ikiel'} by name, a forwarded chat, small talk, a plain status update with nothing to look up. It is then passed on to a person. When in doubt, answer.
- You can make changes with your write tools. Look things up first (schedule, maintenance_queue, staff_lookup) so you act on the right id; if two things could be meant, use ask_pick rather than guessing. Small reversible changes (a visit done or moved, an estimate, a note, a snooze) apply at once and get an Undo button — do them, then say what you did in one line. Anything that messages someone else (publishing to an owner, dispatching a tukang, messaging staff, a statement change) is staged and confirmed with a Yes button — call the tool, then say nothing more than what is pending. Never do a Tier-2 action and a question in the same turn.
- Things that never happen from WhatsApp, say so and give the page: ${NEVER_HERE} — sambarentals.com/payouts.
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
export async function handleTeamMessage({ db, wa, fromNum, text, apiKey = process.env.ANTHROPIC_API_KEY, dryRun = false, role: roleOverride = null, buttonPayload = null }) {
  const num = String(fromNum || '').replace(/\D/g, '');
  const role = roleOverride || roleFor(num);
  if (!role || !apiKey) return false;
  let body = String(text || '').trim();
  const actor = role === 'admin' ? 'ikiel' : 'era';
  const names0 = await catalogNames(db).catch(() => ({}));
  const villa = (slug) => names0[slug] || slug;
  const tap = parseTap(buttonPayload);
  const say = async (t, buttons = null) => { if (!dryRun && wa) { if (buttons?.length) await sendButtons(wa, num, t, buttons); else await sendText(wa, num, t); } };

  // A pending confirmation, answered by tap or by word.
  const pKey = `team_pending:${num}`;
  const pending = await getSettingValue(db, pKey).catch(() => null);
  if (pending && pending.expires_at > nowIso()) {
    const yes = (tap?.domain === 'team' && tap.verb === 'yes' && tap.id === pending.id) || (!tap && YES_RE.test(body));
    const no = (tap?.domain === 'team' && tap.verb === 'no') || (!tap && NO_RE.test(body));
    if (yes || no) {
      if (!dryRun) await saveSettingValue(db, pKey, null);
      if (no) { await say('Okay, not doing that. Nothing changed.'); return { claimed: true, outcome: 'cancelled', reply: 'Okay, not doing that. Nothing changed.', tools: [], writes: [], cost_usd: 0 }; }
      if (dryRun) return { claimed: true, outcome: 'would_execute', reply: pending.summary, tools: [pending.tool], writes: [{ tool: pending.tool, mode: 'would_execute' }], cost_usd: 0 };
      try {
        await executePending(db, wa, pending, { actor, num });
        const reply = `Done: ${pending.summary}`;
        await say(reply);
        await logCalls(db, [{ at: nowIso(), who: actor, tool: pending.tool, input: pending.input, ok: true, confirmed: true }]);
        return { claimed: true, outcome: 'executed', reply, tools: [pending.tool], writes: [{ tool: pending.tool, mode: 'executed' }], cost_usd: 0 };
      } catch (e) {
        const reply = `Could not do that: ${e.message}`;
        await say(reply);
        return { claimed: true, outcome: 'error', reply, tools: [pending.tool], writes: [], cost_usd: 0 };
      }
    }
  }
  // A pick from a list Maya offered.
  const kKey = `team_pick:${num}`;
  const pick = await getSettingValue(db, kKey).catch(() => null);
  if (pick && pick.expires_at > nowIso()) {
    let chosen = null;
    if (tap?.domain === 'team' && tap.verb === 'pick') chosen = (pick.choices || []).find(c => c.id === tap.id) || null;
    else if (/^\d{1,2}$/.test(body)) chosen = (pick.choices || [])[Number(body) - 1] || null;
    else chosen = (pick.choices || []).find(c => body.toLowerCase() === String(c.title).toLowerCase()) || null;
    if (chosen) {
      if (!dryRun) await saveSettingValue(db, kKey, null);
      body = `${pick.intent} — chosen: ${chosen.title} [${chosen.id}]${chosen.description ? ` (${chosen.description})` : ''}`;
    }
  }
  // Undo, by button or by word: the most recent write, or a named one.
  if ((tap?.domain === 'team' && tap.verb === 'undo') || /^undo\b[\s.!]*$/i.test(body)) {
    const uKey = `team_last_write:${num}`;
    const stack = ((await getSettingValue(db, uKey).catch(() => null)) || []).filter(w => w.expires_at > nowIso());
    const w = tap ? stack.find(x => x.id === tap.id) : stack[stack.length - 1];
    if (!w) { await say('Nothing recent to undo.'); return { claimed: true, outcome: 'nothing_to_undo', reply: 'Nothing recent to undo.', tools: [], writes: [], cost_usd: 0 }; }
    if (!w.inverse) { await say(`That one cannot be undone (${w.summary}).`); return { claimed: true, outcome: 'not_undoable', reply: '', tools: [], writes: [], cost_usd: 0 }; }
    if (dryRun) return { claimed: true, outcome: 'would_undo', reply: `Undo: ${w.summary}`, tools: [], writes: [{ tool: 'undo', mode: 'would_undo' }], cost_usd: 0 };
    try { await undoWrite(db, w.inverse); await saveSettingValue(db, uKey, stack.filter(x => x.id !== w.id)); const reply = `Undone: ${w.summary}`; await say(reply); return { claimed: true, outcome: 'undone', reply, tools: [], writes: [{ tool: 'undo', mode: 'undone' }], cost_usd: 0 }; }
    catch (e) { const reply = `Could not undo: ${e.message}`; await say(reply); return { claimed: true, outcome: 'error', reply, tools: [], writes: [], cost_usd: 0 }; }
  }
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
  const tools = [...READ_TOOLS, ...WRITE_TOOLS_T1, ...WRITE_TOOLS_T2, ...(role === 'admin' ? ADMIN_TOOLS : [])];
  const pendingNote = pending && pending.expires_at > nowIso() ? `\n\n(A confirmation is still pending — "${pending.summary}" — they have not said Yes or No. If this message is about it, ask them to tap Yes or No; otherwise answer normally.)` : '';
  const msgs = [{ role: 'user', content: `${name} just sent: "${body}"${pendingNote}\n\nAnswer this message only.` }];

  const calls = [], writes = [];
  let cost = 0, finalText = '', outcome = 'answered', notForMe = null, pendingOut = null, pickOut = null, suppress = false;
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
      const inp = tu.input || {};
      if (tu.name === 'not_for_me') { notForMe = String(inp.reason || 'not addressed to Maya'); result = { ok: true }; }
      else if (WRITE_TOOLS_T1.some(t => t.name === tu.name)) {
        try {
          const w = await applyWrite(db, tu.name, inp, { actor, dryRun, villa });
          writes.push({ tool: tu.name, mode: dryRun ? 'would_apply' : 'applied', summary: w.summary, inverse: w.inverse || null });
          result = { ok: true, applied: !dryRun, summary: w.summary, undoable: !!w.inverse };
        } catch (e) { result = { error: e.message }; }
      } else if (WRITE_TOOLS_T2.some(t => t.name === tu.name)) {
        try {
          if (tu.name === 'ask_pick') {
            const choices = (inp.choices || []).slice(0, 10).map((c, i) => ({ id: String(c.id || i + 1), title: String(c.title || '').slice(0, 24), description: c.description ? String(c.description).slice(0, 72) : undefined }));
            if (choices.length < 2) throw new Error('need at least two choices');
            pickOut = { intent: String(inp.intent || ''), question: String(inp.question || 'Which one?'), choices, expires_at: new Date(Date.now() + PENDING_MS).toISOString() };
            result = { ok: true, staged: 'list sent; stop here' };
          } else if (tu.name === 'statement_change') {
            const { handleStatementChangeRequest } = await import('./statement-requests.js');
            if (dryRun) { result = { ok: true, would_stage: String(inp.text).slice(0, 200) }; writes.push({ tool: tu.name, mode: 'would_confirm', summary: String(inp.text).slice(0, 120) }); }
            else {
              const took = await handleStatementChangeRequest({ db, wa, fromNum: num, fromName: name, text: String(inp.text), apiKey, force: true });
              writes.push({ tool: tu.name, mode: took ? 'pending' : 'not_staged', summary: String(inp.text).slice(0, 120) });
              result = took ? { ok: true, staged: 'Maya has restated the change and asked for YES in a separate message; say nothing more about it' } : { error: 'could not read that as a statement change; ask for villa, month, amount and description' };
              if (took) suppress = true;
            }
          } else {
            const summary = await describePending(db, tu.name, inp, { villa });
            if (dryRun) { writes.push({ tool: tu.name, mode: 'would_confirm', summary }); result = { ok: true, would_confirm: summary }; }
            else {
              pendingOut = { id: newId(), tool: tu.name, input: inp, summary, expires_at: new Date(Date.now() + PENDING_MS).toISOString() };
              writes.push({ tool: tu.name, mode: 'pending', summary });
              result = { ok: true, staged: `Waiting for Yes: ${summary}`, note: 'the Yes/No buttons are attached to your reply; keep the reply to the summary' };
            }
          }
        } catch (e) { result = { error: e.message }; }
      }
      else { try { result = await runTool(db, tu.name, inp, { role, fromNum: num }); } catch (e) { result = { error: e.message }; } }
      calls.push({ at: nowIso(), who: name, tool: tu.name, input: tu.input || {}, ok: !result?.error, ms: Date.now() - t0 });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: compact(result) });
    }
    if (notForMe) break;
    msgs.push({ role: 'user', content: results });
    if (i === MAX_ITERATIONS - 1) { finalText = texts.join('\n').trim() || 'Saya kehabisan langkah — coba tanya lagi dengan lebih spesifik.'; outcome = 'capped'; }
  }

  if (!dryRun) { await addSpend(db, cost); await logCalls(db, calls.map(c => ({ ...c, dry: false }))); }
  if (notForMe && !writes.length) return { claimed: false, outcome: 'not_for_me', reason: notForMe, reply: '', tools: calls.map(c => c.tool), writes, cost_usd: cost };
  let reply = waFormat(finalText);
  const toolsUsed = calls.map(c => c.tool);

  // A list to pick from ends the turn.
  if (pickOut) {
    if (!dryRun) {
      await saveSettingValue(db, kKey, pickOut);
      if (wa) await sendList(wa, num, { body: reply || pickOut.question, buttonLabel: 'Pilih', rows: pickOut.choices.map(c => ({ id: `team:pick:${c.id}`, title: c.title, description: c.description })) });
    }
    return { claimed: true, outcome: 'pick', reply: reply || pickOut.question, choices: pickOut.choices, tools: toolsUsed, writes, cost_usd: cost };
  }
  // A staged action ends the turn with Yes / No.
  if (pendingOut) {
    if (!dryRun) await saveSettingValue(db, pKey, pendingOut);
    // The wording is fixed: nothing has happened yet, and the buttons are
    // the whole point. The model's own text is dropped here on purpose.
    const text = `Just to confirm — ${pendingOut.summary}\n\nTap Yes to go ahead, No to drop it.`;
    await say(text, [{ id: `team:yes:${pendingOut.id}`, title: 'Yes' }, { id: `team:no:${pendingOut.id}`, title: 'No' }]);
    return { claimed: true, outcome: 'pending', reply: text, pending: pendingOut.summary, tools: toolsUsed, writes, cost_usd: cost };
  }
  if (suppress) return { claimed: true, outcome: 'staged_elsewhere', reply: '', tools: toolsUsed, writes, cost_usd: cost };
  if (!reply && writes.length) reply = `Done: ${writes.map(w => w.summary).join('; ')}`;
  if (!reply) return { claimed: false, outcome: outcome === 'error' ? 'error' : 'empty', reply: '', tools: toolsUsed, writes, cost_usd: cost };

  // Applied writes: remember the inverse and offer Undo.
  const applied = writes.filter(w => w.mode === 'applied');
  if (applied.length && !dryRun) {
    const uKey = `team_last_write:${num}`;
    const stack = ((await getSettingValue(db, uKey).catch(() => null)) || []).filter(w => w.expires_at > nowIso());
    const entries = applied.map(w => ({ id: newId(), tool: w.tool, summary: w.summary, inverse: w.inverse, expires_at: new Date(Date.now() + PENDING_MS).toISOString() }));
    await saveSettingValue(db, uKey, [...stack, ...entries].slice(-3));
    const undoable = entries.filter(e => e.inverse).slice(-3);
    await say(reply, undoable.map(e => ({ id: `team:undo:${e.id}`, title: undoable.length === 1 ? 'Undo' : `Undo ${e.summary.match(/^#\d+/)?.[0] || e.tool.replace('hk_', '').replace('_', ' ')}` })));
  } else {
    await say(reply);
  }
  return { claimed: true, outcome: writes.length ? 'applied' : outcome, reply, tools: toolsUsed, writes: writes.map(w => ({ tool: w.tool, mode: w.mode, summary: w.summary })), cost_usd: cost };
}
