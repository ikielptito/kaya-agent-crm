// Campaign Command Center API — all command-center actions in one router.
// Called by the Samba admin panel via its server-side proxy (the sync secret
// passes consoleAuthorized), and available to the CRM consoles with their
// console key. POST { action, payload }.
//
// Actions:
//   campaign_center                 — one-roundtrip overview payload
//   campaign_detail {id}            — funnel, series, recipients, failures, timeline
//   campaign_control {id?, op, …}   — pause/resume/arm/set_cap/cancel/archive/
//                                     kill_all/enable_sending/test_mode
//   audience_preview {filter}       — reachability waterfall, never sends
//   launch_broadcast {phase, …}     — two-phase draft → execute (token-bound)
//
// The broadcast loop runs HERE (vercel.json maxDuration 300): ≤200 recipients
// × 1.2s spacing ≈ 240s worst case. The browser only triggers.

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  CAMPAIGN_REGISTRY, resolveCampaign, patchCampaign, logEvent, bump,
  buildAudience, confirmToken, executeBroadcast,
  getSettingValue, saveSettingValue,
} from '../lib/campaigns.js';
import { getSpendAllowance } from '../lib/spend.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const EST_TEMPLATE_COST_USD = 0.04;   // Meta marketing template, Indonesia (rough)
const MAX_RECIPIENTS = 200;

export default async function handler(req, res) {
  setConsoleCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!consoleAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });
  const sbHeaders = {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'return=minimal',
  };
  const db = { SUPABASE_URL, sbHeaders };
  const sb = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
    return r.ok ? r.json() : null;
  };

  const { action, payload } = req.body || {};
  const actor = payload?.actor || 'admin';

  try {
    // ── OVERVIEW ─────────────────────────────────────────────────────
    if (action === 'campaign_center') {
      const since14 = new Date(Date.now() - 14 * 86400e3).toISOString();
      const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
      const [campaigns, msgs14, out30, in30, agents, saCfg, caps, cronLog, spend, conv30] = await Promise.all([
        sb('campaigns?select=*&archived_at=is.null&order=created_at.desc&limit=100'),
        sb(`wa_messages?select=campaign_id,timestamp&direction=eq.outbound&campaign_id=not.is.null&timestamp=gte.${since14}&limit=20000`),
        sb(`wa_messages?select=agent_id,status&direction=eq.outbound&timestamp=gte.${since30}&limit=20000`),
        sb(`wa_messages?select=agent_id&direction=eq.inbound&timestamp=gte.${since30}&limit=20000`),
        sb('agents?select=id,samba_alerts_opt_out,dead_number,is_test,engagement_tier,contact_frequency,campaign_engagement&wa_num=not.is.null'),
        getSettingValue(db, 'samba_availability'),
        getSettingValue(db, 'marketing_caps'),
        getSettingValue(db, 'cron_run_log'),
        getSpendAllowance(db),
        sb(`campaign_events?select=id&type=eq.conversion&created_at=gte.${since30}&limit=1000`),
      ]);

      // 14-day per-campaign send sparklines.
      const spark = {};
      for (const m of (msgs14 || [])) {
        const day = String(m.timestamp).slice(0, 10);
        ((spark[m.campaign_id] ||= {}))[day] = (spark[m.campaign_id][day] || 0) + 1;
      }

      // Portfolio KPIs, 30 days.
      const reached = new Set(), repliedSet = new Set();
      let tracked = 0, readN = 0;
      for (const m of (out30 || [])) {
        if (m.agent_id != null) reached.add(m.agent_id);
        if (m.status) { tracked++; if (m.status === 'read') readN++; }
      }
      for (const m of (in30 || [])) if (m.agent_id != null) repliedSet.add(m.agent_id);

      // Suppression + audience health.
      const ag = agents || [];
      const now = Date.now();
      const activeCaps = Object.values(caps || {}).filter(c => c.until && Date.parse(c.until) > now).length;
      const suppression = {
        total: ag.length,
        opted_out: ag.filter(a => a.samba_alerts_opt_out).length,
        dead_numbers: ag.filter(a => a.dead_number).length,
        meta_capped: activeCaps,
        monthly_only: ag.filter(a => String(a.contact_frequency || '').toLowerCase() === 'monthly').length,
        auto_responders: ag.filter(a => a.campaign_engagement?.auto_responder).length,
      };
      const tiers = {};
      for (const a of ag) {
        const raw = String(a.engagement_tier || '').toLowerCase().trim();
        const t = ({ hot: 'active', cold: 'dormant' }[raw]) || raw || 'unset';
        tiers[t] = (tiers[t] || 0) + 1;
      }

      // Template health straight from Meta (status + quality per template).
      let templates = [];
      try {
        const wabaId = process.env.META_WABA_ID, token = process.env.META_WA_TOKEN;
        if (wabaId && token) {
          const tr = await fetch(`${GRAPH}/${wabaId}/message_templates?fields=name,status,language,quality_score&limit=100&access_token=${token}`);
          if (tr.ok) templates = ((await tr.json()).data || []).map(t => ({
            name: t.name, status: t.status, language: t.language,
            quality: t.quality_score?.score || null,
          }));
        }
      } catch { /* best-effort */ }

      return res.status(200).json({
        campaigns: (campaigns || []).map(c => ({ ...c, spark: spark[c.id] || {} })),
        kpis: {
          reach_30d: reached.size, replied_30d: repliedSet.size,
          read_rate_30d: tracked ? Math.round(readN / tracked * 100) : null,
          sent_30d: (out30 || []).length,
          conversions_30d: (conv30 || []).length,
        },
        spend, suppression, tiers, templates,
        settings: {
          enabled: !!(saCfg || {}).enabled,
          test_agents_only: !!(saCfg || {}).test_agents_only,
          intro_sweep_daily_cap: (saCfg || {}).intro_sweep_daily_cap ?? null,
          account_invite_daily_cap: (saCfg || {}).account_invite_daily_cap ?? null,
          viewings_announce_daily_cap: (saCfg || {}).viewings_announce_daily_cap ?? null,
          carousel_enabled: (saCfg || {}).carousel_enabled !== false,
        },
        cron_log: Array.isArray(cronLog) ? cronLog.slice(0, 8) : [],
        // Cron beats in UTC, for the client's next-run countdowns.
        cron_utc: { waves: ['01:00', '01:20', '01:40'], hourly_sweep: ':05' },
      });
    }

    // ── DETAIL ───────────────────────────────────────────────────────
    if (action === 'campaign_detail') {
      const id = String(payload?.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const row = (await sb(`campaigns?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'campaign not found' });

      const since90 = new Date(Date.now() - 90 * 86400e3).toISOString();
      const [msgs, events] = await Promise.all([
        sb(`wa_messages?select=agent_id,status,timestamp,template_name,error,category&campaign_id=eq.${encodeURIComponent(id)}&direction=eq.outbound&timestamp=gte.${since90}&order=timestamp.desc&limit=5000`),
        sb(`campaign_events?select=type,actor,detail,created_at&campaign_id=eq.${encodeURIComponent(id)}&order=created_at.desc&limit=50`),
      ]);
      const rows = msgs || [];

      // Daily series (sends + reads land on the send's day — read events
      // PATCH the same row, so "reads" here = sends that were eventually read).
      const series = {};
      for (const m of rows) {
        const d = String(m.timestamp).slice(0, 10);
        const s = series[d] || (series[d] = { sent: 0, read: 0, failed: 0 });
        s.sent++;
        if (m.status === 'read') s.read++;
        if (m.status === 'failed') s.failed++;
      }

      // Template performance within the campaign.
      const tstats = {};
      for (const m of rows) {
        const k = m.template_name || 'free-text';
        const t = tstats[k] || (tstats[k] = { sent: 0, tracked: 0, read: 0, failed: 0 });
        t.sent++;
        if (m.status) { t.tracked++; if (m.status === 'read') t.read++; if (m.status === 'failed') t.failed++; }
      }

      // Recipients: best status per agent + 48h reply attribution.
      const rank = { failed: 0, sent: 1, delivered: 2, read: 3 };
      const perAgent = {};
      for (const m of rows) {
        if (m.agent_id == null) continue;
        const cur = perAgent[m.agent_id];
        const r0 = rank[m.status] ?? 1;
        if (!cur || r0 > cur.rank) perAgent[m.agent_id] = { rank: r0, status: m.status || 'sent', at: m.timestamp, error: m.error || null };
        else if (m.error && !cur.error) cur.error = m.error;
      }
      const ids = Object.keys(perAgent).map(Number);
      let agentsMap = {}, repliers = new Set();
      if (ids.length) {
        const chunks = [];
        for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
        const H48 = 48 * 3600e3;
        for (const chunk of chunks) {
          const [ags, inbs] = await Promise.all([
            sb(`agents?id=in.(${chunk.join(',')})&select=id,name,agency,engagement_tier,last_inbound_at,campaign_engagement`),
            sb(`wa_messages?agent_id=in.(${chunk.join(',')})&direction=eq.inbound&timestamp=gte.${row.created_at || since90}&select=agent_id,timestamp&limit=10000`),
          ]);
          for (const a of (ags || [])) agentsMap[a.id] = a;
          for (const m of (inbs || [])) {
            const send = perAgent[m.agent_id];
            if (send && Date.parse(m.timestamp) > Date.parse(send.at) && Date.parse(m.timestamp) - Date.parse(send.at) < H48) repliers.add(m.agent_id);
          }
        }
      }
      const recipients = ids.map(aid => {
        const a = agentsMap[aid] || {};
        const v = perAgent[aid];
        return {
          id: aid, name: a.name || a.agency || `#${aid}`,
          tier: a.engagement_tier || 'unset',
          status: repliers.has(aid) ? 'replied' : v.status,
          portal_account: !!a.campaign_engagement?.portal_account,
          error: v.error, at: v.at,
        };
      }).sort((x, y) => (y.status === 'replied') - (x.status === 'replied') || String(x.name).localeCompare(String(y.name)));

      // Failure reasons, grouped + humanised.
      const failures = {};
      for (const m of rows) {
        if (m.status !== 'failed') continue;
        let label = m.error || 'unknown error';
        if (/\b131026\b/.test(label)) label = 'Number not on WhatsApp (131026)';
        else if (/\b131049\b/.test(label)) label = 'Meta per-user marketing cap (131049)';
        else if (/\b131047\b/.test(label)) label = '24h window closed (131047)';
        else label = label.slice(0, 120);
        failures[label] = (failures[label] || 0) + 1;
      }

      return res.status(200).json({
        campaign: row,
        registry: row.key ? (CAMPAIGN_REGISTRY[row.key] ? { control: CAMPAIGN_REGISTRY[row.key].control } : null) : null,
        series: Object.entries(series).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v })),
        templates: Object.entries(tstats).map(([name, t]) => ({ name, ...t, read_rate: t.tracked ? Math.round(t.read / t.tracked * 100) : null })).sort((a, b) => b.sent - a.sent),
        recipients: recipients.slice(0, 500),
        recipients_total: recipients.length,
        replied_in_window: repliers.size,
        failures: Object.entries(failures).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
        events: events || [],
        note: 'message-level data covers the last 90 days; campaign counters are lifetime',
      });
    }

    // ── CONTROL ──────────────────────────────────────────────────────
    if (action === 'campaign_control') {
      const { id, op, value } = payload || {};
      if (!op) return res.status(400).json({ error: 'op required' });

      // Global switches (no campaign id).
      if (op === 'kill_all' || op === 'enable_sending' || op === 'test_mode') {
        const cfg = (await getSettingValue(db, 'samba_availability')) || {};
        if (op === 'kill_all') cfg.enabled = false;
        if (op === 'enable_sending') cfg.enabled = true;
        if (op === 'test_mode') cfg.test_agents_only = !!value;
        await saveSettingValue(db, 'samba_availability', cfg);
        // Stamp the event on every always-on row so each timeline shows it.
        if (op !== 'test_mode') {
          const rows = await sb(`campaigns?kind=eq.always_on&select=id`) || [];
          for (const c of rows) await logEvent(db, c.id, op === 'kill_all' ? 'kill_switch' : 'resumed', { global: true, op }, actor);
        }
        return res.status(200).json({ ok: true, settings: { enabled: !!cfg.enabled, test_agents_only: !!cfg.test_agents_only } });
      }

      if (!id) return res.status(400).json({ error: 'id required' });
      const row = (await sb(`campaigns?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'campaign not found' });
      const reg = row.key ? CAMPAIGN_REGISTRY[row.key] : null;

      const setCap = async (n) => {
        if (!reg?.control?.cap) throw new Error('this campaign has no daily cap');
        const { key, path } = reg.control.cap;
        const cfg = (await getSettingValue(db, key)) || {};
        cfg[path] = n;
        await saveSettingValue(db, key, cfg);
        await patchCampaign(db, id, { caps: { ...(row.caps || {}), daily_cap: n } });
      };

      if (op === 'pause') {
        if (!['live', 'sending', 'scheduled'].includes(row.status) && row.kind !== 'always_on') {
          return res.status(400).json({ error: `cannot pause a ${row.status} campaign` });
        }
        await patchCampaign(db, id, { status: 'paused' });
        await logEvent(db, id, 'paused', null, actor);
      } else if (op === 'resume') {
        if (row.status !== 'paused') return res.status(400).json({ error: `cannot resume a ${row.status} campaign` });
        await patchCampaign(db, id, { status: row.kind === 'always_on' ? 'live' : 'scheduled' });
        await logEvent(db, id, 'resumed', null, actor);
      } else if (op === 'arm') {
        const n = Math.max(1, parseInt(value, 10) || 0);
        if (!n) return res.status(400).json({ error: 'arm needs a positive daily cap' });
        await setCap(n);
        await patchCampaign(db, id, { status: 'live' });
        await logEvent(db, id, 'armed', { daily_cap: n }, actor);
      } else if (op === 'disarm') {
        await setCap(0);
        await patchCampaign(db, id, { status: 'paused' });
        await logEvent(db, id, 'paused', { disarmed: true }, actor);
      } else if (op === 'set_cap') {
        const n = Math.max(0, parseInt(value, 10) || 0);
        await setCap(n);
        await logEvent(db, id, 'cap_changed', { daily_cap: n }, actor);
      } else if (op === 'cancel') {
        if (!['draft', 'scheduled'].includes(row.status)) return res.status(400).json({ error: `cannot cancel a ${row.status} campaign` });
        await patchCampaign(db, id, { status: 'cancelled' });
        await logEvent(db, id, 'cancelled', null, actor);
      } else if (op === 'archive') {
        if (!['complete', 'cancelled', 'failed'].includes(row.status)) return res.status(400).json({ error: 'only finished campaigns can be archived' });
        await patchCampaign(db, id, { archived_at: new Date().toISOString() });
        await logEvent(db, id, 'archived', null, actor);
      } else {
        return res.status(400).json({ error: `unknown op: ${op}` });
      }
      const fresh = (await sb(`campaigns?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))?.[0];
      return res.status(200).json({ ok: true, campaign: fresh });
    }

    // ── AUDIENCE PREVIEW ─────────────────────────────────────────────
    if (action === 'audience_preview') {
      const { eligible, breakdown } = await buildAudience(db, payload?.filter || {});
      return res.status(200).json({
        breakdown,
        sample: eligible.slice(0, 10).map(a => ({ id: a.id, name: a.name, tier: a.tier, in_window: a.in_window })),
        over_cap: eligible.length > MAX_RECIPIENTS ? eligible.length - MAX_RECIPIENTS : 0,
        max_recipients: MAX_RECIPIENTS,
      });
    }

    // ── LAUNCH (two-phase) ───────────────────────────────────────────
    if (action === 'launch_broadcast') {
      const phase = payload?.phase;

      if (phase === 'draft') {
        const { name, goal, filter, message, template_name, template_params, scheduled_at } = payload || {};
        if (!name) return res.status(400).json({ error: 'name required' });
        if (!message && !template_name) return res.status(400).json({ error: 'message or template_name required' });

        // Template launches require Meta approval — checked up front so the
        // review step can never show an unlaunchable draft as launchable.
        if (template_name) {
          const wabaId = process.env.META_WABA_ID, token = process.env.META_WA_TOKEN;
          const tr = await fetch(`${GRAPH}/${wabaId}/message_templates?fields=name,status&limit=100&access_token=${token}`).then(r => r.json()).catch(() => ({}));
          const tpl = (tr.data || []).find(t => t.name === template_name);
          if (!tpl) return res.status(400).json({ error: `template "${template_name}" not found on the WABA` });
          if (tpl.status !== 'APPROVED') return res.status(400).json({ error: `template "${template_name}" is ${tpl.status}, not APPROVED` });
        }

        const { eligible, breakdown } = await buildAudience(db, filter || {});
        if (!eligible.length) return res.status(400).json({ error: 'audience is empty after suppressions', breakdown });
        if (eligible.length > MAX_RECIPIENTS) {
          return res.status(400).json({ error: `audience is ${eligible.length}, above the ${MAX_RECIPIENTS} per-launch ceiling — narrow the filter`, breakdown });
        }

        const saCfg = (await getSettingValue(db, 'samba_availability')) || {};
        const agentIds = eligible.map(a => a.id);
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/campaigns`, {
          method: 'POST', headers: { ...sbHeaders, Prefer: 'return=representation' },
          body: JSON.stringify({
            name: String(name).slice(0, 120), kind: 'one_off', pipeline: 'samba', mode: 'broadcast',
            status: 'draft', goal: goal || 'reply',
            audience_mode: Array.isArray(filter?.agent_ids) && filter.agent_ids.length ? 'manual' : 'filter',
            audience_filter: filter || {}, agent_ids: agentIds,
            broadcast_msg: message || null, template_name: template_name || null,
            schedule: { type: scheduled_at ? 'at' : 'immediate', template_params: template_params || [] },
            scheduled_at: scheduled_at || null,
            caps: {
              test_agents_only: !!saCfg.test_agents_only,
              quiet_hours: '09:00-21:00 WITA (operator launches exempt)',
              max_recipients: MAX_RECIPIENTS,
            },
            total_count: agentIds.length, sent_count: 0, skip_count: 0, fail_count: 0,
          }),
        });
        if (!ins.ok) return res.status(500).json({ error: 'campaign insert failed: ' + (await ins.text()).slice(0, 200) });
        const row = (await ins.json())?.[0];
        await logEvent(db, row.id, 'created', { via: 'command_center', recipients: agentIds.length }, actor);
        return res.status(200).json({
          campaign_id: row.id,
          confirm_token: confirmToken(row.id, agentIds),
          recipients: agentIds.length,
          in_window: breakdown.in_window,
          breakdown,
          sample: eligible.slice(0, 10).map(a => a.name),
          estimate_usd: template_name ? +(agentIds.length * EST_TEMPLATE_COST_USD).toFixed(2) : 0,
          test_agents_only: !!saCfg.test_agents_only,
        });
      }

      if (phase === 'execute') {
        const { campaign_id, confirm_token } = payload || {};
        if (!campaign_id || !confirm_token) return res.status(400).json({ error: 'campaign_id and confirm_token required' });
        const row = (await sb(`campaigns?id=eq.${encodeURIComponent(campaign_id)}&select=*&limit=1`))?.[0];
        if (!row) return res.status(404).json({ error: 'campaign not found' });
        if (row.status !== 'draft') return res.status(409).json({ error: `campaign is ${row.status}, not draft — nothing to execute` });
        if (confirmToken(row.id, row.agent_ids || []) !== confirm_token) {
          return res.status(409).json({ error: 'confirm token mismatch — the audience changed since the preview; draft again' });
        }
        if (row.scheduled_at && Date.parse(row.scheduled_at) > Date.now()) {
          await patchCampaign(db, row.id, { status: 'scheduled' });
          await logEvent(db, row.id, 'launched', { scheduled_for: row.scheduled_at }, actor);
          return res.status(200).json({ ok: true, scheduled_for: row.scheduled_at });
        }
        await patchCampaign(db, row.id, { status: 'sending' });
        await logEvent(db, row.id, 'launched', { recipients: (row.agent_ids || []).length }, actor);
        const saCfg = (await getSettingValue(db, 'samba_availability')) || {};
        const out = await executeBroadcast(db, row, { testOnly: !!saCfg.test_agents_only });
        return res.status(200).json({ ok: true, ...out });
      }

      return res.status(400).json({ error: 'phase must be "draft" or "execute"' });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (e) {
    console.error('campaigns api error:', e);
    return res.status(500).json({ error: e.message });
  }
}
