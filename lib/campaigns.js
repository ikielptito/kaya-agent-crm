// Campaign command center core: the registry of always-on campaigns, the
// self-healing campaign-row resolver the sweeps call, the atomic counter
// bump, the audit log, the server-side audience builder, and the server-side
// broadcast engine (the browser only ever *triggers* a send — the loop runs
// here, so a closed tab can no longer strand a campaign mid-send).
//
// Data model (migrations/2026-08-27-campaign-command-center.sql):
//   campaigns.key        — stable identity for always-on rows (registry keys)
//   campaigns.kind       — 'one_off' | 'always_on' | 'sequence'
//   campaigns.status     — draft|scheduled|sending|live|paused|complete|cancelled|failed
//   campaigns.*_count    — lifetime funnel counters, changed ONLY via campaign_bump()
//   campaign_events      — who did what, when (pause, arm, cap change, launch, …)
//
// Pausing: every sweep resolves its campaign row at the start of a run and
// skips when status = 'paused'. That makes the row's status a real control,
// not a display value — per-campaign pause/resume without inventing a new
// settings knob per sweep. The existing settings caps still apply on top.

import crypto from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v24.0';

// One row per automated sweep. `control` maps the command center's ops onto
// the settings knobs each sweep already reads:
//   master: true        → governed only by the samba_availability.enabled kill
//                         switch + this row's paused status
//   cap: {key, path}    → the sweep is OFF until settings[key][path] > 0
//                         ("arm" sets the cap AND flips status to live)
// Kept in code (not DB) so a settings-shape change never needs a migration.
// The seed rows in the migration SQL mirror name/goal/categories/schedule.
export const CAMPAIGN_REGISTRY = {
  availability_alert: {
    name: 'Availability alerts', goal: 'reply', seedStatus: 'live',
    categories: ['availability_alert'],
    context: 'High-signal availability changes to matched agents',
    schedule: { cron: 'daily 09:00-09:40 WITA, 3 waves', gate: 'HIGH_SIGNAL_MIN=3, 72h frequency, tier-muted' },
    control: { master: true },
  },
  availability_digest: {
    name: 'Weekly digest', goal: 'reply', seedStatus: 'live',
    categories: ['availability_digest'],
    context: 'Monday availability digest, reaches every non-paused agent',
    schedule: { cron: 'Mondays 09:00 WITA, 3 waves' },
    control: { master: true },
  },
  availability_intro: {
    name: 'First-touch intro', goal: 'reply', seedStatus: 'paused',
    categories: ['availability_intro'],
    context: 'Carousel intro to agents the broadcast has never reached',
    schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.intro_sweep_daily_cap' },
    control: { cap: { key: 'samba_availability', path: 'intro_sweep_daily_cap' } },
  },
  new_arrivals: {
    name: 'New arrivals', goal: 'reply', seedStatus: 'live',
    categories: ['new_arrivals'],
    context: 'Just-went-live listings announced as a NEW-badge carousel',
    schedule: { cron: 'daily 09:00 WITA (wave 0), when listings went live' },
    control: { master: true },
  },
  account_invite: {
    name: 'Account invites', goal: 'signup', seedStatus: 'paused',
    categories: ['account_invite', 'account_invite_nudge'],
    context: 'Portal-account invite for dormant agents + closing-window nudge',
    schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.account_invite_daily_cap' },
    control: { cap: { key: 'samba_availability', path: 'account_invite_daily_cap' } },
  },
  viewings_announce: {
    name: 'Viewings announce', goal: 'reply', seedStatus: 'paused',
    categories: ['viewings_announce'],
    context: 'One-time "Maya books viewings now" note to engaged agents',
    schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.viewings_announce_daily_cap' },
    control: { cap: { key: 'samba_availability', path: 'viewings_announce_daily_cap' } },
  },
  onboarding: {
    name: 'Welcome / onboarding', goal: 'reply', seedStatus: 'live',
    categories: ['onboarding'],
    context: 'Welcome template for newly added agents (deferred to 9am WITA)',
    schedule: { cron: 'daily 09:00 WITA (wave 0)' },
    control: { master: true },
  },
  agent_cold: {
    name: 'Agent cold outreach', goal: 'reply', seedStatus: 'live',
    categories: ['agent_cold'],
    context: 'Cold intros to agents found via listing screenshots (Maya quick-add)',
    schedule: { cron: 'sends on import (9am WITA if added off-hours)', volume: 'manual, you control it by how many screenshots you feed Maya' },
    control: { master: true },
  },
  owner_cold: {
    name: 'Owner cold outreach', goal: 'reply', seedStatus: 'paused',
    categories: ['owner_cold'],
    context: 'Cold intro drip to prospect villa owners (screenshot pipeline)',
    schedule: { cron: 'daily 09:00 WITA', cap_setting: 'owner_cold.intro_daily_cap', env_gate: 'OWNERS_ENABLED=1' },
    control: { cap: { key: 'owner_cold', path: 'intro_daily_cap' }, env: 'OWNERS_ENABLED' },
  },
  owner_statements: {
    name: 'Owner statements', goal: 'click', seedStatus: 'paused',
    categories: ['owner_statement'],
    context: 'Monthly payout statement notification when Ikiel publishes',
    schedule: { cron: 'daily 09:00 WITA (wave 0), event-driven on publish', cap_setting: 'owner_statements.notify_daily_cap', env_gate: 'OWNERS_ENABLED=1' },
    control: { cap: { key: 'owner_statements', path: 'notify_daily_cap' }, env: 'OWNERS_ENABLED' },
  },
  maintenance: {
    name: 'Maintenance', goal: 'click', seedStatus: 'paused',
    categories: ['maintenance', 'maintenance_staff'],
    context: 'Owner approval requests, completion notices, and follow-up nudges to Era',
    schedule: { cron: 'daily 09:00 WITA (wave 0), event-driven on publish/approve/complete', cap_setting: 'maintenance.notify_daily_cap', env_gate: 'OWNERS_ENABLED=1' },
    control: { cap: { key: 'maintenance', path: 'notify_daily_cap' }, env: 'OWNERS_ENABLED' },
  },
};

export const LIFECYCLE = ['draft', 'scheduled', 'sending', 'live', 'paused', 'complete', 'cancelled', 'failed'];

// ── Small Supabase helpers (db = { SUPABASE_URL, sbHeaders }) ───────────
async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
export async function getSettingValue(db, key) {
  return (await sbGet(db, `settings?key=eq.${encodeURIComponent(key)}&select=value`))?.[0]?.value ?? null;
}
export async function saveSettingValue(db, key, value) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
    method: 'POST',
    headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value }),
  });
}

// ── Campaign row access ─────────────────────────────────────────────────
const resolveCache = new Map();   // key → row, per warm invocation only

// Fetch the always-on campaign row for a registry key; insert it from the
// registry if it's missing (self-healing — a deleted row regrows on the next
// run instead of silently un-tracking a sweep).
export async function resolveCampaign(db, key) {
  if (resolveCache.has(key)) return resolveCache.get(key);
  const reg = CAMPAIGN_REGISTRY[key];
  if (!reg) return null;
  let row = (await sbGet(db, `campaigns?key=eq.${encodeURIComponent(key)}&select=*&limit=1`))?.[0] || null;
  if (!row) {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/campaigns`, {
      method: 'POST',
      headers: { ...db.sbHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        name: reg.name, kind: 'always_on', key, pipeline: 'samba', mode: 'broadcast',
        status: reg.seedStatus, goal: reg.goal, categories: reg.categories,
        context: reg.context, schedule: reg.schedule,
      }),
    }).catch(() => null);
    row = r && r.ok ? (await r.json())?.[0] || null : null;
    if (row) await logEvent(db, row.id, 'created', { self_healed: true }, 'system');
  }
  if (row) resolveCache.set(key, row);
  return row;
}

export function isCampaignPaused(row) {
  return !!row && row.status === 'paused';
}

// A screenshot-sourced cold import (Ikiel feeds Maya listing screenshots of
// agents to acquire). New rows carry samba.source='cold_import'; the notes
// regex catches rows written before that convention and any phrasing Maya
// uses as long as "screenshot" or "cold outreach" survives into the notes.
export function isColdImportAgent(agent) {
  if (agent?.campaign_engagement?.samba?.source === 'cold_import') return true;
  return /screenshot|cold outreach/i.test(String(agent?.notes || ''));
}

// Atomic counter increment via the campaign_bump() RPC. Best-effort by
// design — a lost bump must never fail a send.
export async function bump(db, campaignId, deltas = {}) {
  if (!campaignId) return;
  const body = { p_id: campaignId };
  for (const [k, v] of Object.entries({
    sent: 'p_sent', delivered: 'p_delivered', read: 'p_read',
    replied: 'p_replied', failed: 'p_failed', skipped: 'p_skipped', converted: 'p_converted',
  })) { if (deltas[k]) body[v] = deltas[k]; }
  if (Object.keys(body).length === 1) return;
  await fetch(`${db.SUPABASE_URL}/rest/v1/rpc/campaign_bump`, {
    method: 'POST', headers: db.sbHeaders, body: JSON.stringify(body),
  }).catch(() => {});
}

export async function logEvent(db, campaignId, type, detail = null, actor = 'system') {
  if (!campaignId) return;
  await fetch(`${db.SUPABASE_URL}/rest/v1/campaign_events`, {
    method: 'POST', headers: db.sbHeaders,
    body: JSON.stringify({ campaign_id: campaignId, type, actor, detail }),
  }).catch(() => {});
}

export async function patchCampaign(db, id, fields) {
  const body = { ...fields, updated_at: new Date().toISOString() };
  if ('status' in fields) body.status_changed_at = new Date().toISOString();
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/campaigns?id=eq.${id}`, {
    method: 'PATCH', headers: { ...db.sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  return r.ok ? (await r.json())?.[0] || null : null;
}

// End-of-run bookkeeping every sweep calls: stamp when it ran, what happened,
// and bump the aggregate counters in one place.
export async function noteRun(db, campaign, { sent = 0, skipped = 0, failed = 0, summary = null } = {}) {
  if (!campaign) return;
  await bump(db, campaign.id, { sent, skipped, failed });
  await fetch(`${db.SUPABASE_URL}/rest/v1/campaigns?id=eq.${campaign.id}`, {
    method: 'PATCH', headers: db.sbHeaders,
    body: JSON.stringify({
      last_run_at: new Date().toISOString(),
      last_run_summary: summary || { sent, skipped, failed },
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

// ── Audience builder ────────────────────────────────────────────────────
// Server-side port of the console's getCampaignAudience, extended with the
// full suppression waterfall the command center shows before any launch.
// filter: { tiers?[], frequency?[], last_reply_days?, portal_account?('yes'|'no'|'any'),
//           not_received_category?, not_received_days?, agent_ids?[] (manual pick) }
// Returns { eligible: [{id,name,tier,wa_num,in_window,last_reply_days}], breakdown }.
export async function buildAudience(db, filter = {}) {
  const now = Date.now();
  const [agents, saCfg, caps] = await Promise.all([
    sbGet(db, 'agents?select=id,name,agency,wa_num,engagement_tier,contact_frequency,samba_alerts_opt_out,dead_number,automation_override,is_test,last_inbound_at,campaign_engagement&wa_num=not.is.null'),
    getSettingValue(db, 'samba_availability'),
    getSettingValue(db, 'marketing_caps'),
  ]);
  const config = saCfg || {};
  const marketingCaps = caps || {};
  const list = Array.isArray(agents) ? agents : [];

  const breakdown = {
    total: list.length, opted_out: 0, dead_number: 0, capped_24h: 0,
    frequency_limited: 0, auto_responder: 0, filtered_out: 0, test_excluded: 0, eligible: 0,
  };
  const manualIds = Array.isArray(filter.agent_ids) && filter.agent_ids.length
    ? new Set(filter.agent_ids.map(Number)) : null;

  // "hasn't received <category> in N days" needs a message scan.
  let recentlyTouched = null;
  if (filter.not_received_category) {
    const days = Math.max(1, parseInt(filter.not_received_days, 10) || 30);
    const since = new Date(now - days * 86400e3).toISOString();
    const rows = await sbGet(db,
      `wa_messages?select=agent_id&direction=eq.outbound&category=eq.${encodeURIComponent(filter.not_received_category)}&timestamp=gte.${since}&agent_id=not.is.null&limit=10000`);
    recentlyTouched = new Set((rows || []).map(r => r.agent_id));
  }

  const tierOf = (a) => {
    const raw = String(a.engagement_tier || '').toLowerCase().trim();
    return { hot: 'active', cold: 'dormant' }[raw] || raw || 'unset';
  };
  const eligible = [];
  for (const a of list) {
    if (manualIds && !manualIds.has(a.id)) { breakdown.filtered_out++; continue; }
    // Suppressions first — these are the rows the launch can never reach.
    if (a.samba_alerts_opt_out) { breakdown.opted_out++; continue; }
    const status = String(a.campaign_engagement?.samba?.status || '').toLowerCase();
    if (/declined|stalled|unsubscribed/.test(status)) { breakdown.opted_out++; continue; }
    if (a.dead_number) { breakdown.dead_number++; continue; }
    if (a.campaign_engagement?.auto_responder) { breakdown.auto_responder++; continue; }
    const num = String(a.wa_num || '').replace(/\D/g, '');
    const cap = marketingCaps[num];
    if (cap && cap.until && Date.parse(cap.until) > now) { breakdown.capped_24h++; continue; }
    const freq = String(a.contact_frequency || '').toLowerCase();
    if (freq === 'paused' || a.automation_override === 'paused' || a.automation_override === 'off') {
      breakdown.frequency_limited++; continue;
    }
    if (config.test_agents_only && !a.is_test) { breakdown.test_excluded++; continue; }
    // User filters.
    if (!manualIds) {
      if (Array.isArray(filter.tiers) && filter.tiers.length && !filter.tiers.includes(tierOf(a))) { breakdown.filtered_out++; continue; }
      if (Array.isArray(filter.frequency) && filter.frequency.length && !filter.frequency.includes(freq || 'normal')) { breakdown.filtered_out++; continue; }
      if (filter.last_reply_days != null && filter.last_reply_days !== '') {
        const maxDays = parseInt(filter.last_reply_days, 10);
        const daysSince = a.last_inbound_at ? (now - Date.parse(a.last_inbound_at)) / 86400e3 : Infinity;
        if (Number.isFinite(maxDays) && daysSince > maxDays) { breakdown.filtered_out++; continue; }
      }
      if (filter.portal_account === 'yes' && !a.campaign_engagement?.portal_account) { breakdown.filtered_out++; continue; }
      if (filter.portal_account === 'no' && a.campaign_engagement?.portal_account) { breakdown.filtered_out++; continue; }
      if (recentlyTouched && recentlyTouched.has(a.id)) { breakdown.filtered_out++; continue; }
    }
    const inWindow = !!(a.last_inbound_at && (now - Date.parse(a.last_inbound_at)) <= 24 * 3600e3);
    eligible.push({
      id: a.id, name: a.name || a.agency || `#${a.id}`, tier: tierOf(a),
      wa_num: num, in_window: inWindow,
      last_reply_days: a.last_inbound_at ? Math.floor((now - Date.parse(a.last_inbound_at)) / 86400e3) : null,
    });
  }
  breakdown.eligible = eligible.length;
  breakdown.in_window = eligible.filter(e => e.in_window).length;
  // Never-contacted first, then most recently active — same ordering instinct
  // as the console's audience builder.
  eligible.sort((x, y) => (x.last_reply_days === null) - (y.last_reply_days === null)
    || (x.last_reply_days ?? 0) - (y.last_reply_days ?? 0) || x.id - y.id);
  return { eligible, breakdown };
}

// ── Launch confirmation token ───────────────────────────────────────────
// Binds the execute phase to exactly the audience that was previewed: the
// token is an HMAC over (campaign id + resolved agent ids), so a changed
// audience invalidates the confirm. Server-recomputed — nothing to store.
export function confirmToken(campaignId, agentIds) {
  const secret = process.env.LISTING_SYNC_SECRET || process.env.CONSOLE_SECRET || 'samba';
  return crypto.createHmac('sha256', secret)
    .update(String(campaignId) + '|' + (agentIds || []).map(Number).sort((a, b) => a - b).join(','))
    .digest('hex').slice(0, 24);
}

// ── Server-side broadcast engine ────────────────────────────────────────
// Runs a one-off campaign's send loop inside the API function (maxDuration
// 300s): ~1.2s spacing × ≤200 recipients ≈ 240s worst case. Replaces the
// console's in-browser loop for command-center launches.
//
// campaign row fields used: agent_ids (audience snapshot), template_name,
// broadcast_msg (free text), schedule.template_params (body variables,
// '{name}' token → recipient first name), categories/goal for stamping.
const BROADCAST_MAX_RECIPIENTS = 200;   // matches lib/assistant.js
const SEND_SPACING_MS = 1200;

function firstNameOf(name) {
  if (!name || /\d{5,}/.test(String(name))) return 'there';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length > 1 && /^(I|Ni)$/i.test(parts[0])) return parts[1];
  return parts[0] || 'there';
}

async function fetchApprovedTemplate(name) {
  const wabaId = process.env.META_WABA_ID, token = process.env.META_WA_TOKEN;
  if (!wabaId || !token || !name) return null;
  try {
    const r = await fetch(`${GRAPH}/${wabaId}/message_templates?limit=100&access_token=${token}`);
    if (!r.ok) return null;
    const t = ((await r.json()).data || []).find(x => x.name === name && x.status === 'APPROVED');
    if (!t) return null;
    const body = (t.components || []).find(c => c.type === 'BODY');
    return { name: t.name, language: t.language, body: body?.text || '' };
  } catch { return null; }
}

export async function executeBroadcast(db, campaign, { testOnly = false } = {}) {
  const TOKEN = process.env.META_WA_TOKEN, PHONE_ID = process.env.META_WA_PHONE_ID;
  const out = { sent: 0, skipped: 0, failed: 0, errors: [] };
  if (!TOKEN || !PHONE_ID) { out.errors.push('WhatsApp env vars not configured'); return out; }

  const ids = (Array.isArray(campaign.agent_ids) ? campaign.agent_ids : []).slice(0, BROADCAST_MAX_RECIPIENTS);
  if (!ids.length) { out.errors.push('empty audience snapshot'); return out; }
  const agents = await sbGet(db,
    `agents?id=in.(${ids.map(Number).join(',')})&select=id,name,agency,wa_num,samba_alerts_opt_out,dead_number,is_test,last_inbound_at`) || [];

  const params = campaign.schedule?.template_params || [];
  const tpl = campaign.template_name ? await fetchApprovedTemplate(campaign.template_name) : null;
  if (campaign.template_name && !tpl) {
    out.errors.push(`template ${campaign.template_name} is not APPROVED`);
    await patchCampaign(db, campaign.id, { status: 'failed' });
    await logEvent(db, campaign.id, 'failed', { reason: 'template not approved' });
    return out;
  }

  for (const a of agents) {
    // Re-check suppressions at send time — the snapshot can be minutes old.
    if (testOnly && !a.is_test) { out.skipped++; continue; }
    if (a.samba_alerts_opt_out || a.dead_number || !a.wa_num) { out.skipped++; continue; }
    const fn = firstNameOf(a.name);
    let body, waMessageId = null, err = null;
    try {
      if (tpl) {
        const vals = params.map(p => String(p).replaceAll('{name}', fn));
        const components = vals.length
          ? [{ type: 'body', parameters: vals.map(v => ({ type: 'text', text: v })) }] : [];
        const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: a.wa_num, type: 'template',
            template: { name: tpl.name, language: { code: tpl.language || 'en' }, components },
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) err = d?.error?.message || `HTTP ${r.status}`;
        else waMessageId = d.messages?.[0]?.id || null;
        body = (tpl.body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => vals[Number(n) - 1] ?? '');
      } else {
        // Free text only reaches in-window recipients (WhatsApp rule).
        const inWindow = !!(a.last_inbound_at && (Date.now() - Date.parse(a.last_inbound_at)) <= 24 * 3600e3);
        if (!inWindow) { out.skipped++; continue; }
        body = String(campaign.broadcast_msg || '').replaceAll('{name}', fn);
        const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: a.wa_num, type: 'text', text: { body } }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) err = d?.error?.message || `HTTP ${r.status}`;
        else waMessageId = d.messages?.[0]?.id || null;
      }
    } catch (e) { err = e.message; }

    if (err) {
      out.failed++;
      if (out.errors.length < 5) out.errors.push(`${a.name || a.id}: ${err}`);
      await bump(db, campaign.id, { failed: 1 });
      continue;
    }
    out.sent++;
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: db.sbHeaders,
      body: JSON.stringify({
        agent_id: a.id, wa_num: a.wa_num, direction: 'outbound', content: body,
        wa_message_id: waMessageId, timestamp: new Date().toISOString(),
        source: 'api', category: 'broadcast', status: 'sent',
        template_name: tpl ? tpl.name : null, campaign_id: campaign.id,
      }),
    }).catch(() => {});
    await bump(db, campaign.id, { sent: 1 });
    await new Promise(r => setTimeout(r, SEND_SPACING_MS));
  }

  const final = out.sent > 0 || out.failed === 0 ? 'complete' : 'failed';
  // sent/fail counters were already bumped atomically per message; only the
  // skip total and lifecycle land here.
  await patchCampaign(db, campaign.id, {
    status: final,
    skip_count: (campaign.skip_count || 0) + out.skipped,
    last_run_at: new Date().toISOString(), last_run_summary: out,
  });
  await logEvent(db, campaign.id, final === 'complete' ? 'completed' : 'failed', out);
  return out;
}
