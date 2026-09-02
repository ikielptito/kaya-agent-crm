// Daily follow-up runner. Triggered by Vercel Cron at 9am WITA (1am UTC).
// Scans every agent's projects[] for entries where a follow-up is due,
// generates a contextual nudge via Claude, and sends it via WhatsApp.
//
// Lifecycle stages that get followed up:
//   - agreement_requested: Maya asked for the listing agreement, waiting for it
//   - signed:              Ikiel signed, waiting for the agent to publish + send link
//
// Stages that DO NOT get followed up:
//   - none, pitched, interested (still in active conversation; Maya handles inline)
//   - agreement_received (waiting on Ikiel — surfaced in CRM but no auto-nudge)
//   - link_received, declined, stalled (terminal)
//
// Follow-up policy: every 3 days, max 4 follow-ups, then mark stalled and notify Ikiel.
// Each follow-up gets progressively softer in tone.

import { PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, pickWelcomeTemplate } from '../lib/kb.js';
import { sendOwnerPush, buildReviewPushPayload } from '../lib/push.js';
import { pendingEngagements, setEngagement } from '../lib/engagement.js';
import { postToTelegram, telegramEnabled } from '../lib/telegram.js';
import { topAvailableVillas, buildCarouselComponents, uploadCardMedia, CAROUSEL_CARD_COUNT } from '../lib/wa-carousel.js';
import { reconcileAllRentals, pullAgentAnalytics, syncOwners } from '../lib/rental-sync.js';
import { buildAndSendOwnerReport } from '../lib/daily-report.js';
import { runReview, buildReviewKbContext } from '../lib/maya-review.js';
import { sweepRelays } from '../lib/relay.js';
import { sweepUnanswered } from '../lib/sla.js';
import { getSpendAllowance } from '../lib/spend.js';
import { sendNewArrivals } from '../lib/new-arrivals.js';
import { noteNewArrivals } from '../lib/listing-live.js';
import { chaseMissingListingInfo } from '../lib/listing-info.js';
import { isColdProspect } from '../lib/owner-onboarding.js';
import crypto from 'node:crypto';
import { consoleAuthHeaders } from '../lib/auth.js';
import { resolveCampaign, isCampaignPaused, isColdImportAgent, bump as bumpCampaign, noteRun, logEvent as logCampaignEvent, patchCampaign, executeBroadcast } from '../lib/campaigns.js';
import { reportToken } from '../lib/tokens.js';
import { sbRows } from '../lib/sb-rows.js';

// Scoped-down persona for proactive follow-ups. The full MAYA_PERSONA forbids
// initiating contact ("only respond to inbound"), which directly contradicts
// this cron's purpose. Strip out that rule but keep voice, identity, limits.
const FOLLOWUP_PERSONA = `You are Maya, the Listings Coordinator at KAYA Developments in Bali. You work alongside Ikiel (the founder). You're sending a SCHEDULED follow-up — this is an explicit, sanctioned proactive nudge, not a cold reach-out.

VOICE:
- Warm-professional, like a thoughtful concierge.
- Short: 1-3 sentences max.
- No em dashes (use -- if needed).
- NEVER use emojis. Text-only.
- No "guaranteed" language.
- Don't open with the agent's name unless it flows naturally.

IDENTITY:
- You are Maya, not Ikiel. Don't sign messages.
- If you must reference Ikiel ("Ikiel will sign once you send"), use his name naturally.

HARD LIMITS:
- Never invent prices, dates, or commission rates.
- Never promise a unit is reserved.
- Never offer discounts.
- Never ask who the agent's client is, or for their client's name or contact details, and never offer to have our team follow up with their client directly. The agent owns that relationship; everything goes back through them.

FOLLOW-UP STYLE:
- Be specific about what you're waiting for. Don't say "just checking in."
- Match the warmth to the follow-up number: gentle → social proof → offer help → last nudge.
- Always leave the agent an easy out (e.g. "no rush, just keeping it on your radar").`;

const GRAPH = 'https://graph.facebook.com/v24.0';
const FOLLOWUP_INTERVAL_DAYS = 3;
const MAX_FOLLOWUPS = 4;
const STAGES_NEEDING_FOLLOWUP = ['agreement_requested', 'signed'];
// Shared with the webhook cap — both charge the same daily_usage counter, so
// this is the effective ceiling for the whole CRM's Claude spend. With accurate
// per-token costing (see costOfUsage) + Haiku routing, this allows several
// hundred replies/day, minus the weekly Opus self-review's ~$0.40 on Sundays.
const DAILY_SPEND_CAP_USD = Number(process.env.MAYA_DAILY_CAP_USD) > 0 ? Number(process.env.MAYA_DAILY_CAP_USD) : 10.00;   // shared with the webhook
// Forward-looking estimate used ONLY to gate whether the next Claude call would
// exceed the cap. Actual spend is charged from real token usage (costOfUsage),
// so this just needs to be a safe upper bound on one reply (~1.5-2¢ real).
const COST_PER_REPLY_USD = 0.02;

// Sonnet pricing (USD per token): $3/M input, $15/M output; cache read $0.30/M,
// cache write $3.75/M. Applies to both claude-sonnet-4-6 (draft regen) and the
// legacy claude-sonnet-4 used for stage follow-ups — same per-token rates.
function costOfUsage(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) * 3 / 1e6
    + (u.output_tokens || 0) * 15 / 1e6
    + (u.cache_read_input_tokens || 0) * 0.30 / 1e6
    + (u.cache_creation_input_tokens || 0) * 3.75 / 1e6;
}
const WA_MESSAGE_RETENTION_DAYS = 90; // older rows are pruned on each cron run

export default async function handler(req, res) {
  // Vercel Cron sends Authorization: Bearer ${CRON_SECRET}
  const expected = process.env.CRON_SECRET;
  if (expected && req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const WA_TOKEN = process.env.META_WA_TOKEN;
  const WA_PHONE_ID = process.env.META_WA_PHONE_ID;

  if (!SUPABASE_URL || !SUPABASE_KEY || !WA_TOKEN || !WA_PHONE_ID) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  // ?sync=analytics runs only the portal analytics pull (per-agent funnel +
  // channels into settings.agent_portal_stats) and returns — no sends.
  if (req.query?.sync === 'analytics') {
    try {
      const out = await pullAgentAnalytics({ SUPABASE_URL, headers: sbHeaders });
      return res.status(200).json({ portal_analytics: out });
    } catch (e) {
      return res.status(500).json({ error: 'analytics pull failed: ' + e.message });
    }
  }

  // ── Daily-report standalone hooks ────────────────────────────────────
  // ?report=preview composes Maya's briefing and returns it WITHOUT sending.
  // ?report=send composes AND delivers it, then returns — both before any
  // other send logic, so neither triggers availability alerts / follow-ups.
  if (req.query?.report === 'preview' || req.query?.report === 'send') {
    try {
      const rep = await buildAndSendOwnerReport({
        SUPABASE_URL, headers: sbHeaders, TOKEN: WA_TOKEN, PHONE_ID: WA_PHONE_ID,
        ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY, OWNER_WA_NUM: process.env.OWNER_WA_NUM,
      }, { preview: req.query.report === 'preview' });
      return res.status(200).json({ owner_report: rep });
    } catch (e) {
      return res.status(500).json({ error: 'report failed: ' + e.message });
    }
  }

  // ── Question-relay sweep ─────────────────────────────────────────────
  // ?relay=sweep nudges villa contacts sitting on an unanswered agent
  // question, expires the ones nobody answered (telling the agent honestly
  // rather than letting Maya's promise evaporate), and retries answers the
  // agent hasn't come back to collect. Runs hourly; no other send logic.
  if (req.query?.relay === 'sweep') {
    try {
      const out = await sweepRelays(
        { SUPABASE_URL, sbHeaders },
        { phoneId: WA_PHONE_ID, token: WA_TOKEN },
      );
      // Same hourly beat: holding lines + a page for agents waiting >30 min.
      const sla = await sweepUnanswered({ SUPABASE_URL, sbHeaders }, { phoneId: WA_PHONE_ID, token: WA_TOKEN }).catch(e => ({ error: e.message }));
      // And the closing-window nudge: one last in-window message to agents
      // with a concrete open loop before free text becomes impossible.
      const closing = await sweepClosingWindows({ SUPABASE_URL, sbHeaders }, { phoneId: WA_PHONE_ID, token: WA_TOKEN }).catch(e => ({ error: e.message }));
      // Housekeeping tasks are DERIVED on this beat, not sent. It is the only
      // sub-daily cron either repo has, so a booking made at 14:05 has its
      // cleaning task by 15:05 instead of waiting for tomorrow morning.
      // Nothing is messaged until the 9am pass, and re-deriving a task that
      // already exists is a no-op thanks to unique(slug, task_date, kind).
      const housekeeping = await (async () => {
        try {
          const { generateTasks } = await import('../lib/housekeeping.js');
          return await generateTasks({ SUPABASE_URL, sbHeaders });
        } catch (e) { return { error: e.message }; }
      })();
      return res.status(200).json({ relay_sweep: out, sla_sweep: sla, closing_window_nudges: closing, housekeeping });
    } catch (e) {
      return res.status(500).json({ error: 'relay sweep failed: ' + e.message });
    }
  }

  // ── Weekly Maya self-review hooks ────────────────────────────────────
  // ?review=preview runs the critic and returns findings WITHOUT staging.
  // ?review=run runs it AND stages settings.maya_review_pending for approval.
  // (Applying decisions happens in chat.html via api/supabase apply_maya_review.)
  if (req.query?.review === 'preview' || req.query?.review === 'run') {
    try {
      const kbContext = await buildReviewKbContext(SUPABASE_URL, sbHeaders);
      const out = await runReview(
        { SUPABASE_URL, headers: sbHeaders, ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY },
        { kbContext, preview: req.query.review === 'preview' }
      );
      // A staged review nobody hears about is a review that never happened.
      if (req.query.review === 'run' && out.thread_count > 0) {
        try { await sendOwnerPush({ SUPABASE_URL, headers: sbHeaders }, buildReviewPushPayload(out)); } catch { /* best-effort */ }
      }
      return res.status(200).json({ maya_review: out });
    } catch (e) {
      return res.status(500).json({ error: 'review failed: ' + e.message });
    }
  }

  // ── Availability broadcast waves ≥2 ──────────────────────────────────
  // The scheduled morning broadcast is staggered: vercel.json crons hit
  // ?wave=0 at 9:00 WITA (rides the full daily pass below), then ?wave=1 and
  // ?wave=2 at 9:20/9:40. These later invocations send ONLY the availability
  // broadcast to their cohort (agent.id % AVAILABILITY_WAVES), reusing the
  // improvements wave 0 stashed — no follow-ups, no reports, no reconcile.
  // Persist a compact per-run summary (settings.cron_run_log, newest first,
  // capped) so the chat app's Schedule view can show past-run stats. Best-effort.
  const CRON_LOG_CAP = 40;
  async function logCronRun(entry) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.cron_run_log&select=value`, { headers: sbHeaders });
      const log = (await r.json())?.[0]?.value;
      const next = [{ at: new Date().toISOString(), ...entry }, ...(Array.isArray(log) ? log : [])].slice(0, CRON_LOG_CAP);
      await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'cron_run_log', value: next }),
      });
    } catch (e) { /* never block the run */ }
  }

  const waveParam = req.query?.wave !== undefined ? parseInt(req.query.wave, 10) : null;
  if (waveParam !== null && waveParam >= 1) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=*&wa_num=not.is.null&dead_number=not.is.true`, { headers: sbHeaders });
      const agents = await r.json();
      if (!Array.isArray(agents)) return res.status(500).json({ error: 'Failed to fetch agents' });
      const templatesMap = await loadTemplatesMap(WA_PHONE_ID, WA_TOKEN, SUPABASE_URL, sbHeaders);
      const availability = await runAvailabilityNotifications({
        now: new Date(), sbHeaders, supabaseUrl: SUPABASE_URL,
        agents, templatesMap, waToken: WA_TOKEN, waPhoneId: WA_PHONE_ID,
        results: [], previewMode: false,
        wave: waveParam, waveCount: AVAILABILITY_WAVES,
      });
      await logCronRun({ kind: `wave${waveParam + 1}`,
        alerts: availability?.event_alerts_sent || 0, digests: availability?.weekly_digest_sent || 0,
        errors: availability?.errors?.length || 0 });
      return res.status(200).json({ ran_at: new Date().toISOString(), wave: waveParam, availability });
    } catch (e) {
      return res.status(500).json({ error: `wave ${waveParam} failed: ` + e.message });
    }
  }

  try {
    // Global automation switch — when it's "off", suspend Maya's reactive
    // follow-ups (overnight-draft regen, campaign sequences, anything that
    // calls Claude). The Samba availability broadcast is NOT a Maya follow-up
    // — it's a scheduled WhatsApp template send that uses zero LLM tokens —
    // so it still runs. Decoupling here means an operator can keep Maya
    // silent on inbounds while agents keep getting availability updates.
    let mayaOff = false;
    try {
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
      const sRow = (await sRes.json())?.[0];
      mayaOff = sRow?.value?.mode === 'off';
    } catch (e) { /* default: proceed as if mayaOff = false */ }

    // Fetch all agents who have a wa_num AND have at least one project tracked
    const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=*&wa_num=not.is.null&dead_number=not.is.true`, { headers: sbHeaders });
    const agents = await r.json();
    if (!Array.isArray(agents)) {
      return res.status(500).json({ error: 'Failed to fetch agents' });
    }

    // Load portfolio context for Maya's prompt
    const projects = await loadProjects(SUPABASE_URL, sbHeaders);
    const portfolio = buildPortfolioContextFromDb(projects);

    const now = new Date();
    // Self-origin for calling our own /api/supabase actions (autopilot drafts,
    // contact backfill). Declared here, at handler scope: it used to live inside
    // the `if (!mayaOff)` block below, so the backfill step at the end of the
    // run hit a ReferenceError on every daily run from 13 Jul to 22 Aug 2026 —
    // the run returned 500 after the broadcasts, the daily run-log entry was
    // never written, and the contact backfill never executed.
    const protoFromHost = req.headers['x-forwarded-proto'] || 'https';
    const selfHost = req.headers.host;
    const selfOrigin = selfHost ? `${protoFromHost}://${selfHost}` : null;
    const results = [];
    let sent = 0;
    let stalled = 0;
    let skipped = 0;
    let sequenceSent = 0;
    let sequenceCompleted = 0;
    let draftsSent = 0;
    let welcomesSent = 0;

    // Initial spend check — abort if already over cap from inbox auto-replies today
    let todaySpend = await getTodaySpend(SUPABASE_URL, sbHeaders);
    // Effective cap for today = base + unused rollover (lib/spend.js).
    const SPEND_CAP_TODAY = (await getSpendAllowance({ SUPABASE_URL, sbHeaders })).cap;
    if (todaySpend >= SPEND_CAP_TODAY) {
      await logCronRun({ kind: 'suspended', spend: +todaySpend.toFixed(2) });
      return res.status(200).json({ ran_at: now.toISOString(), suspended: true, reason: `spend cap ($${SPEND_CAP_TODAY.toFixed(2)} incl. rollover) already reached: $${todaySpend.toFixed(2)}` });
    }

    // Prune wa_messages older than retention window before doing anything else
    const pruneCutoff = new Date(now.getTime() - WA_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let pruned = 0;
    try {
      const pruneRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?timestamp=lt.${pruneCutoff}`, {
        method: 'DELETE',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' }
      });
      if (pruneRes.ok) {
        const deleted = await pruneRes.json();
        pruned = Array.isArray(deleted) ? deleted.length : 0;
      }
    } catch (e) { /* non-fatal */ }

    // Load all campaigns so we can resolve template_sequence per agent's engagement
    const campaignsMap = await loadCampaignsMap(SUPABASE_URL, sbHeaders);
    // Load all approved WhatsApp templates so we can find the body text + language for sends
    const templatesMap = await loadTemplatesMap(WA_PHONE_ID, WA_TOKEN, SUPABASE_URL, sbHeaders);

    // ─────────────────────────────────────────────────────────────────────
    // MAYA FOLLOW-UPS — every Claude-dependent block from here through the
    // campaign-sequence section below is gated by `mayaOff`. When the
    // operator has the global automation switch off, we still want the Samba
    // availability broadcast (further down) to fire — it's a scheduled
    // template send, not a Maya reply — but we suspend everything that
    // would otherwise run a Claude prompt for an inbound or a follow-up.
    if (!mayaOff) {

    // ── DEFERRED ONBOARDING WELCOMES — agents added outside 9am-9pm WITA had
    // their welcome held (quick_add_agent set campaign_engagement.samba.welcome_pending).
    // This is the 9am WITA send: Maya-initiated outreach that respects quiet hours.
    try {
      const welcomeTpl = pickWelcomeTemplate(Object.values(templatesMap), { requireApproved: false });
      const onboardingCamp = await resolveCampaign({ SUPABASE_URL, sbHeaders }, 'onboarding');
      const agentColdCamp = await resolveCampaign({ SUPABASE_URL, sbHeaders }, 'agent_cold');
      if (welcomeTpl) {
        // Two buckets share this drain: screenshot cold imports report under
        // 'agent_cold', everyone else under 'onboarding'. Each bucket honours
        // its own campaign's paused status.
        const counts = { onboarding: { sent: 0, failed: 0 }, agent_cold: { sent: 0, failed: 0 } };
        for (const agent of agents) {
          const samba = agent.campaign_engagement?.samba;
          if (!samba?.welcome_pending || !agent.wa_num) continue;
          const cold = isColdImportAgent(agent);
          const camp = cold ? agentColdCamp : onboardingCamp;
          if (isCampaignPaused(camp)) {
            results.push({ agent: agent.name || agent.id, action: 'deferred_welcome_skipped', reason: `campaign paused (${cold ? 'agent_cold' : 'onboarding'})` });
            continue;
          }
          const fName = String(agent.name || '').trim().split(/\s+/)[0] || 'there';
          const mid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, agent.wa_num, welcomeTpl, [fName]);
          if (!mid) { counts[cold ? 'agent_cold' : 'onboarding'].failed++; results.push({ agent: agent.name || agent.id, action: 'deferred_welcome_failed' }); continue; }
          // Clear the flag so it sends exactly once (preserve the rest of the bucket).
          await patchAgentEngagement(SUPABASE_URL, sbHeaders, agent, 'samba', { ...samba, welcome_pending: false });
          const rendered = (welcomeTpl.body || '').replace(/\{\{1\}\}/g, fName);
          await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
            method: 'POST', headers: sbHeaders,
            body: JSON.stringify({
              agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
              content: rendered, timestamp: now.toISOString(), source: 'cron',
              category: cold ? 'agent_cold' : 'onboarding', template_name: welcomeTpl.name,
              campaign_id: camp?.id || null, status: 'sent',
              wa_message_id: typeof mid === 'string' ? mid : null,
            })
          }).catch(() => {});
          counts[cold ? 'agent_cold' : 'onboarding'].sent++;
          welcomesSent++;
          results.push({ agent: agent.name || agent.id, action: 'deferred_welcome_sent', campaign: cold ? 'agent_cold' : 'onboarding' });
        }
        if (counts.onboarding.sent || counts.onboarding.failed) {
          await noteRun({ SUPABASE_URL, sbHeaders }, onboardingCamp, counts.onboarding);
        }
        if (counts.agent_cold.sent || counts.agent_cold.failed) {
          await noteRun({ SUPABASE_URL, sbHeaders }, agentColdCamp, counts.agent_cold);
        }
      }
    } catch (e) { results.push({ action: 'deferred_welcome_error', error: e.message }); }

    // ── PENDING DRAFTS FROM OFF-HOURS — regenerate fresh + send at 9am WITA ─
    // When an inbound arrives between 9pm-9am WITA, the webhook generates a draft
    // but doesn't send it. At 9am we send a fresh response — but we ALWAYS
    // regenerate via the suggest_reply server action rather than blindly sending
    // the stored draft. This guarantees: (1) the latest prompts/anti-hallucination
    // rules apply, (2) the latest portfolio/rentals data is used, (3) any
    // additional messages the agent sent overnight are factored in.
    //
    // (We learned this the hard way: a draft generated with an early buggy prompt
    // was sent verbatim by an early version of this cron — the stale draft
    // hallucinated USD nightly rates instead of monthly IDR. Always-regenerate
    // prevents that class of bug entirely.)
    let globalMode = 'draft';
    try {
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
      const sRow = (await sRes.json())?.[0];
      if (sRow?.value?.mode) globalMode = sRow.value.mode;
    } catch (e) { /* default */ }

    if (globalMode === 'autopilot' && selfOrigin) {
      for (const agent of agents) {
        if (agent.automation_override === 'paused' || agent.automation_override === 'off') continue;
        const existingDraft = (agent.suggested_reply || '').trim();
        if (!existingDraft) continue;
        if (existingDraft.startsWith('[')) continue;   // system status messages
        if (!agent.wa_num) continue;
        // Spend gate — regeneration costs ~$0.02 in Claude
        if (todaySpend + COST_PER_REPLY_USD >= SPEND_CAP_TODAY) {
          results.push({ agent: agent.name || agent.id, action: 'draft_skipped', reason: 'spend_cap' });
          continue;
        }

        // REGENERATE the reply fresh using the canonical Maya prompt path
        let freshReply = null, freshCost = COST_PER_REPLY_USD;
        try {
          const sgRes = await fetch(`${selfOrigin}/api/supabase`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...consoleAuthHeaders() },
            body: JSON.stringify({ action: 'suggest_reply', payload: { agentId: agent.id } })
          });
          if (sgRes.ok) {
            const sgData = await sgRes.json();
            freshReply = (sgData?.reply || '').trim();
            if (typeof sgData?.cost_usd === 'number') freshCost = sgData.cost_usd;
          }
        } catch (e) { /* fall through to skip */ }

        if (!freshReply || freshReply.startsWith('[')) {
          // Regeneration failed — DO NOT fall back to the stale draft. Skip and
          // surface so Ikiel can review manually. Better silent than wrong.
          results.push({ agent: agent.name || agent.id, action: 'draft_skipped', reason: 'regeneration_failed' });
          continue;
        }
        todaySpend += freshCost;

        const sendOk = await sendText(WA_PHONE_ID, WA_TOKEN, agent.wa_num, freshReply);
        if (!sendOk) {
          results.push({ agent: agent.name || agent.id, action: 'draft_send_failed' });
          continue;
        }
        await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
          method: 'POST', headers: sbHeaders,
          body: JSON.stringify({
            agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
            content: freshReply, timestamp: now.toISOString(), source: 'cron'
          })
        }).catch(() => {});
        await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
          method: 'PATCH', headers: sbHeaders,
          body: JSON.stringify({ suggested_reply: '', unread_count: 0 })
        }).catch(() => {});

        draftsSent++;
        results.push({ agent: agent.name || agent.id, action: 'draft_auto_sent', preview: freshReply.slice(0, 80) });
      }
    }

    for (const agent of agents) {
      // Skip agents that Ikiel is handling manually (automation_override = 'paused')
      // or that have automation explicitly turned off for them.
      if (agent.automation_override === 'paused' || agent.automation_override === 'off') {
        skipped++;
        continue;
      }

      // ── CAMPAIGN SEQUENCE FOLLOW-UPS (per pipeline) ─────────────────
      // An agent can have one pending sequence per pipeline (KAYA + Samba).
      // Process each independently so one doesn't clobber the other.
      for (const { pipeline: engPl, eng } of pendingEngagements(agent.campaign_engagement)) {
        if (!eng.next_template_at) continue;
        const dueAt = new Date(eng.next_template_at);
        if (dueAt > now) continue;

        const campaign = campaignsMap[eng.campaign_id];
        const sequence = campaign?.template_sequence || [];
        const nextIdx = (eng.sequence_index || 0) + 1;
        const nextStep = sequence[nextIdx];

        if (!nextStep) {
          // End of sequence — mark completed (only this pipeline's bucket)
          await patchAgentEngagement(SUPABASE_URL, sbHeaders, agent, engPl, {
            ...eng,
            status: 'completed_sequence',
            next_template_at: null,
            completed_at: now.toISOString()
          });
          sequenceCompleted++;
          results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_completed', campaign: campaign?.name });
          continue;
        }

        // Spend gate
        if (todaySpend + COST_PER_REPLY_USD >= SPEND_CAP_TODAY) {
          results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_skipped', reason: 'spend_cap' });
          continue;
        }
        const tmpl = templatesMap[nextStep.template_name];
        if (!tmpl) {
          results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_skipped', reason: 'template_not_found:' + nextStep.template_name });
          continue;
        }
        const firstName = firstNameOf(agent.name);
        const renderedBody = (tmpl.body || '').replace(/\{\{1\}\}/g, firstName);
        const seqMid = await sendTemplate(WA_PHONE_ID, WA_TOKEN, agent.wa_num, tmpl, [firstName]);
        if (!seqMid) {
          await bumpCampaign({ SUPABASE_URL, sbHeaders }, eng.campaign_id, { failed: 1 });
          results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_send_failed', template: nextStep.template_name });
          continue;
        }
        // category/status/wa_message_id were missing here until 27 Aug 2026 —
        // sequence sends were invisible to campaign reporting, dedupe, AND the
        // webhook's delivered/read tracking (nothing to match the status to).
        await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
          method: 'POST', headers: sbHeaders,
          body: JSON.stringify({
            agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
            content: renderedBody, timestamp: now.toISOString(),
            source: 'cron', campaign_id: eng.campaign_id,
            category: 'sequence', status: 'sent', template_name: nextStep.template_name,
            wa_message_id: typeof seqMid === 'string' ? seqMid : null,
          })
        }).catch(() => {});
        await bumpCampaign({ SUPABASE_URL, sbHeaders }, eng.campaign_id, { sent: 1 });
        const waitDays = (sequence[nextIdx + 1]?.wait_days) || 1;
        const nextTemplateAt = sequence[nextIdx + 1]
          ? new Date(now.getTime() + waitDays * 86400000).toISOString()
          : null;
        await patchAgentEngagement(SUPABASE_URL, sbHeaders, agent, engPl, {
          ...eng,
          sequence_index: nextIdx,
          last_template_sent: nextStep.template_name,
          last_template_sent_at: now.toISOString(),
          next_template_at: nextTemplateAt
        });
        sequenceSent++;
        todaySpend += COST_PER_REPLY_USD;
        results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_sent', template: nextStep.template_name, step: nextIdx + 1, of: sequence.length });
      }

      // ── LISTING LIFECYCLE FOLLOW-UPS (existing logic below) ─────────
      const projectsObj = agent.projects || {};
      for (const projectName of Object.keys(projectsObj)) {
        const proj = projectsObj[projectName];
        if (!proj || typeof proj !== 'object') continue;
        if (!STAGES_NEEDING_FOLLOWUP.includes(proj.stage)) continue;

        // Check next_followup_at
        const next = proj.next_followup_at ? new Date(proj.next_followup_at) : null;
        if (!next || next > now) { skipped++; continue; }

        // Hit max follow-ups → mark stalled
        const count = proj.followup_count || 0;
        if (count >= MAX_FOLLOWUPS) {
          await markStalled(SUPABASE_URL, sbHeaders, agent, projectName);
          stalled++;
          results.push({ agent: agent.name || agent.id, project: projectName, action: 'stalled' });
          continue;
        }

        // Spend gate — abort if next Claude call would push us over the cap
        if (todaySpend + COST_PER_REPLY_USD >= SPEND_CAP_TODAY) {
          results.push({ agent: agent.name || agent.id, project: projectName, action: 'skipped_spend_cap' });
          continue;
        }

        // Generate follow-up message
        const followup = await generateFollowupMessage(
          ANTHROPIC_KEY, agent, projectName, proj, portfolio, count + 1
        );
        const followupText = followup.text;
        todaySpend += followup.cost_usd;
        if (!followupText) {
          results.push({ agent: agent.name || agent.id, project: projectName, action: 'skipped_no_message' });
          continue;
        }

        // Send via WhatsApp
        const sendOk = await sendText(WA_PHONE_ID, WA_TOKEN, agent.wa_num, followupText);
        if (!sendOk) {
          results.push({ agent: agent.name || agent.id, project: projectName, action: 'send_failed' });
          continue;
        }

        // Log outbound
        await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
          method: 'POST', headers: sbHeaders,
          body: JSON.stringify({
            agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
            content: followupText, timestamp: now.toISOString(), source: 'api'
          })
        }).catch(() => {});

        // Update project state
        const updatedProjects = { ...projectsObj };
        const nextFollowup = new Date(now.getTime() + FOLLOWUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        updatedProjects[projectName] = {
          ...proj,
          followup_count: count + 1,
          last_followup_at: now.toISOString(),
          next_followup_at: nextFollowup.toISOString()
        };
        await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agent.id}`, {
          method: 'PATCH', headers: sbHeaders,
          body: JSON.stringify({ projects: updatedProjects })
        });

        sent++;
        results.push({
          agent: agent.name || agent.id, project: projectName,
          stage: proj.stage, followup_number: count + 1,
          message_preview: followupText.slice(0, 80)
        });
      }
    }

    } // end if (!mayaOff) — Maya follow-ups gate

    // ── SAMBA AVAILABILITY NOTIFICATIONS ─────────────────────────────
    // Runs regardless of `mayaOff` — this is a scheduled WhatsApp
    // template broadcast, not a Maya reply, so the global Maya switch
    // doesn't apply. Owns its own kill switch (settings.samba_availability
    // .enabled) for operators who do want to silence it independently.
    // Sends daily event alerts and Monday weekly digests via templates
    // already approved on the WhatsApp Business account.
    // Preview mode: cron URL came with ?preview=1 (used by the manual-
    // broadcast UI in the analytics dashboard). Composes the message and
    // returns the rendered body + recipient count, but skips the Meta send,
    // skips wa_messages logging, and does not persist a new snapshot. The
    // caller can then show the user what would go out before they confirm.
    const previewMode = req.query?.preview === '1';
    // Scheduled invocations carry ?wave=0 → send to cohort 0 and stash the
    // improvements for the :20/:40 waves. Bare invocations (manual fire from
    // the dashboard, ad-hoc curl) keep the old behavior: everyone in one pass.
    const staggered = waveParam === 0 && !previewMode;
    const availabilityResult = await runAvailabilityNotifications({
      now, sbHeaders, supabaseUrl: SUPABASE_URL,
      agents, templatesMap,
      waToken: WA_TOKEN, waPhoneId: WA_PHONE_ID,
      results,
      previewMode,
      wave: 0,
      waveCount: staggered ? AVAILABILITY_WAVES : 1,
    });

    // ── INTRO SWEEP (first-touch backlog) ────────────────────────────
    // After the regular broadcast: send the carousel intro to a capped batch
    // of enrolled agents who've never received ANY availability message.
    // Gated by settings.samba_availability.intro_sweep_daily_cap (off when
    // unset/0). Runs on the wave-0 daily pass and manual fires, never in
    // preview; per-agent dedupe (introducedSet + last_availability_alert_at)
    // makes an extra manual run safe — it just works further down the queue.
    let introSweep = null;
    if (!previewMode) {
      try {
        introSweep = await runIntroSweep({
          now, sbHeaders, supabaseUrl: SUPABASE_URL,
          agents, templatesMap,
          waToken: WA_TOKEN, waPhoneId: WA_PHONE_ID,
          results,
        });
      } catch (e) { introSweep = { error: e.message }; }
    }

    // ── VIEWINGS PASS (expiry sync, day-of reminders, outcome asks) ──
    let viewingsCron = null;
    if (!previewMode) {
      try {
        const { runViewingsCron } = await import('../lib/viewings.js');
        const send = async (to, body) => {
          const r = await fetch(`${GRAPH}/${WA_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
          });
          if (!r.ok) throw new Error('send failed');
          const d = await r.json().catch(() => ({}));
          const mid = d.messages?.[0]?.id || null;
          // Log so the console thread shows the reminder/outcome ask.
          const ag = await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${to}&select=id&limit=1`, { headers: sbHeaders }).then(x => x.json()).catch(() => []);
          await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
            method: 'POST', headers: sbHeaders,
            body: JSON.stringify({ agent_id: ag?.[0]?.id ?? null, wa_num: to, direction: 'outbound', content: body, wa_message_id: mid, timestamp: new Date().toISOString(), source: 'cron', category: 'viewing_reminder', status: 'sent' }),
          }).catch(() => {});
        };
        viewingsCron = await runViewingsCron({ SUPABASE_URL, sbHeaders }, null, { now, sendText: send });
      } catch (e) { viewingsCron = { error: e.message }; }
    }

    // ── ACCOUNT-INVITE SWEEP (dormant reactivation) ──────────────────
    // One-time nudge asking dormant/cold agents to create a portal account
    // (Google sign-in → personal share link + click/enquiry attribution).
    // Gated by settings.samba_availability.account_invite_daily_cap (off when
    // unset/0) and by the samba_account_invite_v1 template being approved.
    let accountInvites = null;
    if (!previewMode) {
      try {
        accountInvites = await runAccountInviteSweep({
          now, sbHeaders, supabaseUrl: SUPABASE_URL,
          agents, templatesMap,
          waToken: WA_TOKEN, waPhoneId: WA_PHONE_ID,
          results,
        });
      } catch (e) { accountInvites = { error: e.message }; }
    }

    // ── VIEWINGS-FEATURE ANNOUNCEMENT SWEEP (engaged agents, one-time) ──
    let viewingsAnnounce = null;
    if (!previewMode) {
      try {
        viewingsAnnounce = await runViewingsAnnounceSweep({
          now, sbHeaders, supabaseUrl: SUPABASE_URL,
          agents, templatesMap,
          waToken: WA_TOKEN, waPhoneId: WA_PHONE_ID,
          results,
        });
      } catch (e) { viewingsAnnounce = { error: e.message }; }
    }

    // ── UNANSWERED-INBOUND SWEEP (daily safety net) ──────────────────
    // Agents whose latest message is still unanswered (Maya superseded, spend
    // cap, manual takeover that went quiet, webhook hiccup) get a catch-up
    // pass via the existing resume_unanswered action: autopilot/hybrid sends,
    // draft mode leaves a reviewable draft, off/paused skips. Before 2 Aug
    // 2026 this action existed but NOTHING called it — real leads sat
    // unanswered for days (the 27 Jul "1BR, 22jt max" lead among them).
    let unansweredSweep = null;
    if (!previewMode) {
      try {
        const swRes = await fetch('https://kaya-agent-crm.vercel.app/api/supabase', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...consoleAuthHeaders() },
          body: JSON.stringify({ action: 'resume_unanswered', payload: { since_days: 4, limit: 40 } }),
        });
        unansweredSweep = swRes.ok ? await swRes.json() : { error: 'HTTP ' + swRes.status };
      } catch (e) { unansweredSweep = { error: e.message }; }
    }

    // ── RENTALS RECONCILE (daily safety net) ─────────────────────────
    // The portal pushes every listing edit to us in real time (listing-sync
    // webhook into api/supabase.js); this daily pass re-syncs everything in
    // case a webhook was ever missed, so prices/badges can't silently drift.
    let rentalsReconcile = null;
    if (!previewMode) {
      try { rentalsReconcile = await reconcileAllRentals({ SUPABASE_URL, headers: sbHeaders }); }
      catch (e) { rentalsReconcile = { error: e.message }; }
      // Queue any listing seen live for the first time as a new arrival (the
      // portal's save hook does this too; this is the safety net).
      try {
        const { fetchPortalListings } = await import('../lib/rental-sync.js');
        const feed = await fetchPortalListings();
        rentalsReconcile = { ...(rentalsReconcile || {}), new_arrivals: await noteNewArrivals({ SUPABASE_URL, sbHeaders }, feed.filter(l => !l.hidden).map(l => l.slug)) };
      } catch (e) { /* best-effort */ }
    }

    // ── LISTING COMPLETENESS (daily) ─────────────────────────────────
    // Maya asks each villa's listed contact for the key facts still missing
    // from its listing (deposit, electricity, wifi, pool, min stay, pets) —
    // one message per contact, every 5 days, max 4 rounds per listing. Replies
    // land in the relay answer path and are staged for Ikiel's approval.
    let listingInfo = null;
    if (!previewMode) {
      try { listingInfo = await chaseMissingListingInfo({ SUPABASE_URL, sbHeaders }, { phoneId: WA_PHONE_ID, token: WA_TOKEN }); }
      catch (e) { listingInfo = { error: e.message }; }
    }

    // ── OWNER SYNC (daily) ───────────────────────────────────────────
    // Refresh the owners table from the portal's authed owner-contact feed so
    // Maya can reach villa owners/managers by their listing's WhatsApp number.
    // Identity + listing links only; never overwrites owner-managed state.
    let ownerSync = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      try { ownerSync = await syncOwners({ SUPABASE_URL, headers: sbHeaders }); }
      catch (e) { ownerSync = { error: e.message }; }
    }

    // ── WEEKLY OWNER REPORTS (Mondays, WITA) ─────────────────────────
    // Proactively WhatsApp each opted-in owner their weekly performance via the
    // approved samba_owner_weekly_report template + a signed report link. Once
    // per week (guarded by day-of-week AND per-owner last_report_sent_at).
    let weeklyReports = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      const wita = new Date(now.getTime() + 8 * 3600 * 1000);
      if (wita.getUTCDay() === 1) {
        try { weeklyReports = await sendWeeklyOwnerReports({ SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID }); }
        catch (e) { weeklyReports = { error: e.message }; }
      }
    }

    // ── OWNER STATEMENT NOTIFY (event-driven on publish) ─────────────
    // Every published-but-unannounced monthly payout statement gets its
    // owner(s) a samba_owner_statement_v1 template with a signed /st/ link.
    // Dedupe is per statement (notified_at, stamped once). Sheet SYNC runs
    // on its own cron (/api/statements?cron=1) — this is only the send leg,
    // kept here so it inherits the campaign pause/cap/template gates.
    let statementNotify = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      try {
        const { runOwnerStatementSweep } = await import('../lib/statements.js');
        statementNotify = await runOwnerStatementSweep({
          SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, templatesMap,
        });
      } catch (e) { statementNotify = { error: e.message }; }
    }

    // ── MAINTENANCE (approval asks, completion notices, Era nudges) ───
    // Eight queues in one pass: published items the owner hasn't been asked
    // about, approvals Era hasn't heard about, authorised work that isn't
    // finished (nudged on next_followup_at — which Era's own reply moves),
    // finished work the owner hasn't been told about, and the four dispatch
    // queues that get a tukang to the villa and keep Era posted.
    let maintenanceNotify = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      try {
        const { runMaintenanceSweep } = await import('../lib/maintenance-sweep.js');
        maintenanceNotify = await runMaintenanceSweep({
          SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, templatesMap,
        });
      } catch (e) { maintenanceNotify = { error: e.message }; }
    }

    // ── HOUSEKEEPING ─────────────────────────────────────────────────
    // The morning's visits, and on Mondays the week ahead. Tasks themselves
    // were derived on the hourly beat; this only speaks. Unlike maintenance
    // there is no OWNERS_ENABLED gate: these messages go to our own staff,
    // never to an owner, so nothing here can surprise a villa owner.
    let housekeepingNotify = null;
    if (!previewMode) {
      try {
        const { runHousekeepingSweep } = await import('../lib/housekeeping-sweep.js');
        const { catalogNames } = await import('../lib/housekeeping.js');
        housekeepingNotify = await runHousekeepingSweep({
          SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, templatesMap,
          catalogNames: await catalogNames({ SUPABASE_URL, sbHeaders }).catch(() => ({})),
        });
      } catch (e) { housekeepingNotify = { error: e.message }; }
    }

    // ── DELIVERY HEALTH ──────────────────────────────────────────────
    // The nightly physical: yesterday's failures by error code, the phone
    // number's quality rating, per-template quality scores — checked against
    // a stored baseline. Quiet day: logged, nothing sent. Threshold tripped:
    // the model reads the failing rows and Ikiel gets a diagnosis on
    // Telegram instead of discovering a bad weekend by feel.
    let deliveryHealth = null;
    if (!previewMode) {
      try {
        const { runDeliveryHealth } = await import('../lib/delivery-health.js');
        deliveryHealth = await runDeliveryHealth({ SUPABASE_URL, sbHeaders }, {
          waToken: WA_TOKEN, phoneId: WA_PHONE_ID, wabaId: process.env.META_WABA_ID,
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
      } catch (e) { deliveryHealth = { error: e.message }; }
    }

    // ── COLD-INTRO DRIP ──────────────────────────────────────────────
    // The screenshot pipeline, fully automatic: Ikiel imports a listing
    // screenshot → prospect row ('agreed', cold). Each 9am pass sends the
    // approved cold template to up to owner_cold.intro_daily_cap of them
    // (default 8 — WhatsApp-quality pacing), oldest first. send_onboard_intro
    // flips them to 'contacted', which removes them from the queue. Warm
    // prospects are never auto-sent — a personal agreement deserves Ikiel's
    // own opener or a deliberate console send.
    let coldDrip = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      try {
        const coldCfg = await loadSetting(SUPABASE_URL, sbHeaders, 'owner_cold') || {};
        const dripCap = coldCfg.intro_daily_cap === undefined ? 8 : (parseInt(coldCfg.intro_daily_cap, 10) || 0);
        const coldCamp = await resolveCampaign({ SUPABASE_URL, sbHeaders }, 'owner_cold');
        if (isCampaignPaused(coldCamp)) {
          coldDrip = { skipped: 'campaign paused (command center)' };
        } else if (dripCap > 0) {
          const rows = await fetch(
            `${SUPABASE_URL}/rest/v1/owners?onboarding_status=eq.agreed&select=id,name,wa_num,consent_note,notes&order=created_at.asc&limit=50`,
            { headers: sbHeaders }
          ).then(r => r.json());
          const dripQueue = (Array.isArray(rows) ? rows : []).filter(o => o.wa_num && isColdProspect(o));
          coldDrip = { queue: dripQueue.length, sent: 0, errors: [] };
          for (const o of dripQueue.slice(0, dripCap)) {
            const r = await fetch('https://kaya-agent-crm.vercel.app/api/supabase', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...consoleAuthHeaders() },
              body: JSON.stringify({ action: 'send_onboard_intro', payload: { id: o.id } }),
            });
            if (r.ok) coldDrip.sent++;
            else {
              const d = await r.json().catch(() => ({}));
              if (coldDrip.errors.length < 3) coldDrip.errors.push(`${o.name || o.id}: ${d.error || r.status}`);
            }
          }
          // sent is bumped inside send_onboard_intro (one bump per send at the
          // source) — this only stamps the run + counts failures.
          await noteRun({ SUPABASE_URL, sbHeaders }, coldCamp, {
            failed: coldDrip.errors.length,
            summary: { sent: coldDrip.sent, queue: coldDrip.queue, errors: coldDrip.errors.length },
          });
        } else {
          coldDrip = { skipped: 'owner_cold.intro_daily_cap = 0' };
        }
      } catch (e) { coldDrip = { error: e.message }; }
    }

    // ── ONBOARDING PROSPECTS GOING COLD (daily flag, no auto-send) ───
    // Owner prospects Maya contacted who haven't replied in 3+ days get
    // flagged to Ikiel via push (max 2 flags per prospect). We deliberately
    // do NOT auto-send a nudge template while onboarding runs draft-first:
    // a re-approach to a warm personal contact should be a human call.
    // (When onboarding graduates to autopilot, this is the hook where a
    // nudge template send would replace the push.)
    let prospectFlags = null;
    if (!previewMode && process.env.OWNERS_ENABLED === '1') {
      try {
        const staleBefore = new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
        const rows = await fetch(
          `${SUPABASE_URL}/rest/v1/owners?onboarding_status=in.(contacted,in_conversation)` +
          `&onboarding_nudges=lt.2&select=id,name,wa_num,onboarding_status,last_inbound_at,last_onboarding_nudge_at,onboarding_nudges,notes,consent_note`,
          { headers: sbHeaders }
        ).then(r => r.json());
        const stale = (Array.isArray(rows) ? rows : []).filter(o => {
          const lastActivity = o.last_inbound_at || o.last_onboarding_nudge_at;
          // 'contacted' with no reply ever: nudge clock starts at the intro
          // (last_onboarding_nudge_at is null then — treat as stale).
          if (!lastActivity) return true;
          if (lastActivity >= staleBefore) return false;
          // Don't re-flag within the 3-day window of the previous flag.
          return !o.last_onboarding_nudge_at || o.last_onboarding_nudge_at < staleBefore;
        });
        for (const o of stale) {
          // A COLD prospect (found advertising their villa, never spoke to us)
          // who ignored an unsolicited first message is not a lead going cold —
          // it is a no. Chasing them is how a WhatsApp number gets reported and
          // blocked, so the advice differs from a warm contact who agreed and
          // then went quiet. Ikiel, 24 Aug 2026.
          const cold = isColdProspect(o);
          await sendOwnerPush({ SUPABASE_URL, headers: sbHeaders }, {
            title: cold
              ? `Cold prospect hasn't replied: ${o.name || '+' + o.wa_num}`
              : `Owner prospect going cold: ${o.name || '+' + o.wa_num}`,
            body: cold
              ? 'No reply to the cold intro in 3+ days. Treat silence as a no — do not chase; only follow up if you have a genuine reason.'
              : o.onboarding_status === 'contacted'
                ? 'No reply to Maya’s intro in 3+ days — worth a personal WhatsApp or call.'
                : 'Conversation went quiet 3+ days ago — a personal nudge from you would help.',
          }).catch(() => {});
          await fetch(`${SUPABASE_URL}/rest/v1/owners?id=eq.${o.id}`, {
            method: 'PATCH', headers: sbHeaders,
            body: JSON.stringify({ last_onboarding_nudge_at: now.toISOString(), onboarding_nudges: (o.onboarding_nudges || 0) + 1 }),
          }).catch(() => {});
        }
        prospectFlags = { flagged: stale.length };

        // Terminal state: a COLD prospect silent 14+ days after the intro is a
        // no. Move them to 'declined' so the pipeline shows reality instead of
        // prospects rotting in 'contacted' forever. Warm prospects (personal
        // agreement with Ikiel) are never auto-declined — that's his call.
        const deadBefore = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString();
        const oldRows = await fetch(
          `${SUPABASE_URL}/rest/v1/owners?onboarding_status=eq.contacted&updated_at=lt.${deadBefore}` +
          `&select=id,name,last_inbound_at,notes,consent_note`,
          { headers: sbHeaders }
        ).then(r => r.json());
        const dead = (Array.isArray(oldRows) ? oldRows : []).filter(o => !o.last_inbound_at && isColdProspect(o));
        for (const o of dead) {
          await fetch(`${SUPABASE_URL}/rest/v1/owners?id=eq.${o.id}`, {
            method: 'PATCH', headers: sbHeaders,
            body: JSON.stringify({ onboarding_status: 'declined', notes: `${o.notes ? o.notes + ' | ' : ''}auto-declined: no reply 14d after cold intro`, updated_at: now.toISOString() }),
          }).catch(() => {});
        }
        if (dead.length) prospectFlags.auto_declined = dead.length;
      } catch (e) { prospectFlags = { error: e.message }; }
    }

    // ── PORTAL ANALYTICS PULL (daily) ────────────────────────────────
    // Cache per-agent clicks/enquiries + channel totals from the portal into
    // settings.agent_portal_stats so the funnel dashboard + report can join
    // portal engagement with message read-rates in one query.
    let portalAnalytics = null;
    if (!previewMode) {
      try { portalAnalytics = await pullAgentAnalytics({ SUPABASE_URL, headers: sbHeaders }); }
      catch (e) { portalAnalytics = { error: e.message }; }
    }

    // ── ESCALATION SLA ───────────────────────────────────────────────
    // Conversations Ikiel took over (paused) where the agent's last message
    // is still unread hours later get a daily Telegram reminder digest, so
    // an escalated chat can't silently rot. One reminder per inbound message
    // (keyed by last_inbound_at in settings.sla_reminders).
    let slaReminded = 0;
    if (!previewMode) {
      try {
        const SLA_HOURS = 3;
        const reminded = (await loadSetting(SUPABASE_URL, sbHeaders, 'sla_reminders')) || {};
        const stale = agents.filter(a =>
          !a.is_test &&
          a.automation_override === 'paused' &&
          (a.unread_count || 0) > 0 &&
          a.last_inbound_at &&
          (now - new Date(a.last_inbound_at)) > SLA_HOURS * 3600 * 1000 &&
          reminded[a.id] !== a.last_inbound_at
        );
        if (stale.length && telegramEnabled()) {
          const lines = stale.map(a => {
            const hrs = Math.round((now - new Date(a.last_inbound_at)) / 3600000);
            return `• <b>${(a.name || 'Unknown').replace(/[<>&]/g, '')}</b> — waiting ${hrs}h (Maya paused, ${a.unread_count} unread)`;
          });
          await postToTelegram(`⏰ <b>Escalated chats waiting on you</b>\n\n${lines.join('\n')}\n\n<i>Open the Maya inbox to reply, or tap Resume on the original alert.</i>`);
          stale.forEach(a => { reminded[a.id] = a.last_inbound_at; });
          await saveSetting(SUPABASE_URL, sbHeaders, 'sla_reminders', reminded);
          slaReminded = stale.length;
        }
      } catch (e) { console.warn('sla reminder failed:', e.message); }
    }

    // Write back the accumulated daily spend
    if (sent > 0) {
      await persistTodaySpend(SUPABASE_URL, sbHeaders, todaySpend);
    }

    // ── AUTO-RESUME STALE PAUSES ─────────────────────────────────────
    // A manual reply pauses Maya on a thread with no auto-resume, so paused
    // threads pile up (99 had accumulated by 12 Jul). Un-pause any thread with
    // NO message in either direction for AUTO_RESUME_DAYS — active manual
    // conversations (recent messages) stay paused; cold ones return to Maya.
    let autoResumed = 0;
    if (!previewMode) {
      try {
        const pausedRows = await (await fetch(`${SUPABASE_URL}/rest/v1/agents?automation_override=eq.paused&select=id,is_test`, { headers: sbHeaders })).json();
        const ids = (Array.isArray(pausedRows) ? pausedRows : []).filter(a => !a.is_test).map(a => a.id);
        if (ids.length) {
          const cutoff = new Date(now.getTime() - AUTO_RESUME_DAYS * 86400000).toISOString();
          const recentRows = await (await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?agent_id=in.(${ids.join(',')})&timestamp=gte.${cutoff}&select=agent_id`, { headers: sbHeaders })).json();
          const active = new Set((Array.isArray(recentRows) ? recentRows : []).map(m => m.agent_id));
          const toResume = ids.filter(id => !active.has(id));
          if (toResume.length) {
            await fetch(`${SUPABASE_URL}/rest/v1/agents?id=in.(${toResume.join(',')})`, {
              method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ automation_override: null })
            });
            await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
              method: 'POST', headers: sbHeaders,
              body: JSON.stringify(toResume.map(id => ({
                agent_id: id, field: 'automation_override', new_value: 'null (auto-resumed)',
                reason: `No message either direction for ${AUTO_RESUME_DAYS}d — auto-resumed stale pause`, by_maya: true
              })))
            }).catch(() => {});
            autoResumed = toResume.length;
          }
        }
      } catch (e) { console.warn('auto-resume failed:', e.message); }
    }

    // ── DAILY MORNING REPORT to Ikiel (WhatsApp) ─────────────────────
    // Maya writes a short briefing of the last 24h and sends it via the owner
    // template. Best-effort — never blocks the cron response. (The dry-run
    // path returns much earlier, before any sends.)
    let ownerReport = null;
    if (!previewMode) {
      try {
        ownerReport = await buildAndSendOwnerReport({
          SUPABASE_URL, headers: sbHeaders,
          TOKEN: WA_TOKEN, PHONE_ID: WA_PHONE_ID,
          ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY,
          OWNER_WA_NUM: process.env.OWNER_WA_NUM,
        });
      } catch (e) { ownerReport = { error: e.message }; }
    }

    // ── WEEKLY MAYA SELF-REVIEW (Sundays) ────────────────────────────
    // Once a week Maya grades her own replies and STAGES proposed lessons +
    // questions for Ikiel to approve in chat.html. Nothing is applied here —
    // applying is a manual one-tap in the console. Best-effort; never blocks.
    // The weekly self-review has its own cron entry (Sunday 02:00 UTC →
    // ?review=run). It used to ride inside this daily pass, and the two
    // mornings the daily fell over (30–31 Aug 2026) it silently did not run.
    let weeklyReview = null;
    // Safety-net: catch any numbers agents shared in the last few days that
    // weren't auto-captured live, and add them to the CRM. Best-effort; the
    // action dedupes so it can't create twins. (Full-history backfill is the
    // 🧲 button in the console.)
    let backfill = null;
    if (!previewMode && selfOrigin) {
      try {
        const bf = await fetch(`${selfOrigin}/api/supabase`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...consoleAuthHeaders() },
          body: JSON.stringify({ action: 'backfill_contacts', payload: { since_days: 3, limit: 40 } })
        });
        backfill = bf.ok ? await bf.json() : { error: `HTTP ${bf.status}` };
      } catch (e) { backfill = { error: e.message }; }
    }

    // ── CAMPAIGN LIFECYCLE (command center) ──────────────────────────
    // 1) Repair one-off/console campaigns stranded at 'sending' >2h (closed
    //    browser tab, killed function) — the permanent fix for the class of
    //    bug the migration's backfill repaired historically.
    // 2) Launch any 'scheduled' campaign whose time has come, server-side.
    let campaignLifecycle = null;
    if (!previewMode) {
      try {
        const campDb2 = { SUPABASE_URL, sbHeaders };
        campaignLifecycle = { repaired: 0, launched: 0 };
        const cutoff2h = new Date(now.getTime() - 2 * 3600e3).toISOString();
        const stranded = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?status=eq.sending&updated_at=lt.${cutoff2h}&select=id,name,sent_count`, { headers: sbHeaders }).then(r => r.json()).catch(() => []);
        for (const c of (Array.isArray(stranded) ? stranded : [])) {
          const final = (c.sent_count || 0) > 0 ? 'complete' : 'failed';
          await patchCampaign(campDb2, c.id, { status: final });
          await logCampaignEvent(campDb2, c.id, 'auto_repaired', { reason: 'stranded_sending', sent_count: c.sent_count || 0 }, 'cron');
          campaignLifecycle.repaired++;
        }
        const due = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?status=eq.scheduled&scheduled_at=lte.${now.toISOString()}&select=*`, { headers: sbHeaders }).then(r => r.json()).catch(() => []);
        for (const c of (Array.isArray(due) ? due : [])) {
          await patchCampaign(campDb2, c.id, { status: 'sending' });
          await logCampaignEvent(campDb2, c.id, 'launched', { scheduled_at: c.scheduled_at }, 'cron');
          const saCfg = await loadSetting(SUPABASE_URL, sbHeaders, 'samba_availability') || {};
          const runOut = await executeBroadcast(campDb2, c, { testOnly: !!saCfg.test_agents_only });
          campaignLifecycle.launched++;
          results.push({ campaign: c.name, action: 'scheduled_launch', ...runOut });
        }
      } catch (e) { campaignLifecycle = { error: e.message }; }
    }

    // Compact run-log entry for the Schedule view (skip pure previews).
    if (!previewMode) {
      await logCronRun({
        kind: waveParam === 0 ? 'daily' : 'manual',
        agents: agents.length,
        drafts: draftsSent,
        welcomes: welcomesSent,
        followups: sent, stalled,
        sequences: sequenceSent,
        alerts: availabilityResult?.event_alerts_sent || 0,
        digests: availabilityResult?.weekly_digest_sent || 0,
        intros: introSweep?.sent || 0,
        invites: accountInvites?.sent || 0,
        resumed: autoResumed || 0,
        campaigns_repaired: campaignLifecycle?.repaired || 0,
        campaigns_launched: campaignLifecycle?.launched || 0,
        briefing: !!ownerReport?.sent,
        review: weeklyReview?.grade || (weeklyReview?.staged ? 'staged' : null),
        backfilled: backfill?.created || 0,
        // How many the silence gate held out of the Monday digest — the
        // number that proves (or indicts) the 31 Aug cadence change.
        digest_silent_skips: availabilityResult?.skipped_silent_digest || 0,
        health_alerts: deliveryHealth?.alerts?.length || 0,
        spend: +(+todaySpend).toFixed(2),
      });
    }

    return res.status(200).json({
      ran_at: now.toISOString(),
      contact_backfill: backfill ? { created: backfill.created, candidates: backfill.candidates } : null,
      total_agents: agents.length,
      drafts_sent: draftsSent,
      deferred_welcomes_sent: welcomesSent,
      listing_sent: sent, listing_stalled: stalled, skipped,
      sequence_sent: sequenceSent, sequence_completed: sequenceCompleted,
      pruned_wa_messages: pruned,
      sla_reminded: slaReminded,
      day_spend_after: todaySpend.toFixed(2),
      availability: availabilityResult,
      intro_sweep: introSweep,
      account_invites: accountInvites,
      viewings_announce: viewingsAnnounce,
      cold_intro_drip: coldDrip,
      viewings: viewingsCron,
      campaign_lifecycle: campaignLifecycle,
      unanswered_sweep: unansweredSweep,
      rentals_reconcile: rentalsReconcile,
      listing_info_chase: listingInfo && { listings_with_gaps: listingInfo.listings_with_gaps, contacts_messaged: listingInfo.contacts_messaged, exhausted: listingInfo.exhausted, error: listingInfo.error },
      owner_sync: ownerSync,
      weekly_reports: weeklyReports,
      statement_notify: statementNotify,
      maintenance: maintenanceNotify,
      housekeeping: housekeepingNotify,
      delivery_health: deliveryHealth ? { alerts: deliveryHealth.alerts, fail_rate: deliveryHealth.snapshot?.fail_rate } : null,
      prospect_flags: prospectFlags,
      portal_analytics: portalAnalytics,
      auto_resumed_pauses: autoResumed,
      owner_report: ownerReport && { sent: ownerReport.sent, chars: ownerReport.chars, error: ownerReport.error },
      weekly_review: weeklyReview,
      results
    });

  } catch (err) {
    console.error('cron-followups error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function markStalled(url, headers, agent, projectName) {
  const projectsObj = agent.projects || {};
  const proj = projectsObj[projectName] || {};
  projectsObj[projectName] = { ...proj, stage: 'stalled', stalled_at: new Date().toISOString() };
  await fetch(`${url}/rest/v1/agents?id=eq.${agent.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ projects: projectsObj })
  }).catch(() => {});
}

async function generateFollowupMessage(apiKey, agent, projectName, proj, portfolio, followupNumber) {
  const firstName = firstNameOf(agent.name);
  const stageContext = proj.stage === 'agreement_requested'
    ? `You previously asked them to send over their listing agreement for ${projectName}. They haven't sent it yet. This is follow-up #${followupNumber} of ${MAX_FOLLOWUPS}. Ask in a way that's appropriate for the follow-up number (1=gentle reminder, 2=mention that other agents are signing too, 3=offer to send a sample agreement format, 4=last friendly nudge before you back off).`
    : `Ikiel has signed the listing agreement for ${projectName} and you're now waiting for them to publish the listing and send back the live URL. This is follow-up #${followupNumber} of ${MAX_FOLLOWUPS}. Ask softly when they think they'll have it live (1=easy reminder, 2=ask if anything is blocking them, 3=offer to share marketing copy or photos, 4=last nudge).`;

  const system = `${FOLLOWUP_PERSONA}

PORTFOLIO KNOWLEDGE (factual reference):
${portfolio}

You are sending a scheduled follow-up to a property agent. There is no inbound message — you are initiating contact.

Context:
- Agent: ${firstName}${agent.agency ? ' at ' + agent.agency : ''}
- Project: ${projectName}
- Last followup sent: ${proj.last_followup_at || 'never'}
- ${stageContext}

Write ONE short WhatsApp message (1-3 sentences). Warm and casual, never pushy. No emojis. No "just checking in" cliché — be specific about what you're waiting for. Don't repeat their name unless natural.

Respond with ONLY the message text — no JSON, no preamble.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: `Send the follow-up now.` }]
      })
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    return { text, cost_usd: data.usage ? costOfUsage(data.usage) : COST_PER_REPLY_USD };
  } catch (e) {
    console.warn('generateFollowupMessage failed:', e.message);
    return { text: null, cost_usd: 0 };
  }
}

async function loadCampaignsMap(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/campaigns?select=id,name,template_sequence`, { headers });
    if (!r.ok) return {};
    const rows = await r.json();
    const map = {};
    if (Array.isArray(rows)) rows.forEach(c => { map[c.id] = c; });
    return map;
  } catch (e) { return {}; }
}

async function loadTemplatesMap(phoneId, waToken, supabaseUrl, sbHeaders) {
  // Fetch approved templates from Meta. We need WABA_ID for this.
  const wabaId = process.env.META_WABA_ID;
  if (!wabaId || !waToken) return {};
  try {
    const r = await fetch(`${GRAPH}/${wabaId}/message_templates?limit=100&access_token=${waToken}`);
    if (!r.ok) return {};
    const data = await r.json();
    const map = {};
    (data.data || []).filter(t => t.status === 'APPROVED').forEach(t => {
      const bodyComponent = (t.components || []).find(c => c.type === 'BODY');
      map[t.name] = {
        name: t.name,
        language: t.language,
        body: bodyComponent?.text || '',
        placeholderCount: ((bodyComponent?.text || '').match(/\{\{(\d+)\}\}/g) || []).length
      };
    });
    return map;
  } catch (e) { return {}; }
}

// Returns Meta's message id on success (or true if the id is missing from
// the response), false on failure — truthiness is unchanged for the older
// call sites; newer ones store the id so the status webhook can find the row.
async function sendTemplate(phoneId, token, to, tmpl, params) {
  try {
    const components = (params && params.length > 0)
      ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) }]
      : [];
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: tmpl.name, language: { code: tmpl.language || 'en' }, components }
      })
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
  } catch (e) { return false; }
}

// ── Weekly owner report push (Mondays) ───────────────────────────────
// Signed report token — shared signer in lib/tokens.js (MUST match the
// portal's lib/tokens.js: same LISTING_SYNC_SECRET, HMAC-SHA256, 16 hex).
function fmtWeekRange(week) {
  if (!week?.from || !week?.to) return 'this week';
  const f = new Date(week.from + 'T00:00:00Z'), t = new Date(week.to + 'T00:00:00Z');
  const fs = f.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
  const ts = t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${fs}–${ts}`;
}
// Send the approved template with body params + the dynamic URL-button suffix
// (the report token, appended to the button's https://sambarentals.com/r/ base).
//
// RESOLVED 1 Sep 2026, after a month of this template throttling its own
// owners (Ikiel's number took 13 consecutive 131049s and stopped receiving
// reports): the ping was MARKETING because its body advertised "how you
// compare to similar villas". Meta classifies from the body text — a
// byte-identical UTILITY resubmission came straight back as MARKETING — so
// the fix is copy, not category. v3 drops the comparative line FROM THE PING
// ONLY; the report page keeps its full "How you compare" section, so owners
// lose nothing once they tap through. Same walk as the owner-question relay:
// newest first, fall through only while a template is not usable yet, so v3
// takes over the moment it clears review with no deploy.
const OWNER_REPORT_TEMPLATES = ['samba_owner_weekly_report_v3', 'samba_owner_weekly_report'];
const REPORT_TEMPLATE_MISSING = new Set([132001, 132000, 132005, 132007, 132012, 132015]);
async function sendOwnerReportTemplate(phoneId, token, to, { name, week, views, enquiries, tok }) {
  for (const tmpl of OWNER_REPORT_TEMPLATES) {
    try {
      const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to, type: 'template',
          template: {
            name: tmpl,
            language: { code: 'en' },
            components: [
              { type: 'body', parameters: [name, week, views, enquiries].map(text => ({ type: 'text', text: String(text) })) },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
            ],
          },
        }),
      });
      if (r.ok) return true;
      const code = (await r.json().catch(() => ({})))?.error?.code ?? null;
      // Only "that template is not usable yet" falls through to the older
      // name. Any other refusal — a throttle, a bad number — must not be
      // retried on the marketing template; that is the loop this ends.
      if (!REPORT_TEMPLATE_MISSING.has(code)) return false;
    } catch (e) { return false; }
  }
  return false;
}
export async function sendWeeklyOwnerReports({ SUPABASE_URL, sbHeaders, WA_TOKEN, WA_PHONE_ID, preview = false }) {
  if (!preview && (!WA_TOKEN || !WA_PHONE_ID)) return { skipped: 'no WhatsApp credentials' };
  const secret = process.env.LISTING_SYNC_SECRET;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/owners?opt_in=eq.true&report_enabled=eq.true&select=*`, { headers: sbHeaders });
  if (!r.ok) return { error: `owners fetch ${r.status}` };
  const owners = await r.json();
  const list = Array.isArray(owners) ? owners : [];
  const sixDaysAgo = Date.now() - 6 * 86400000;
  let sent = 0, skipped = 0, failed = 0;
  const plan = [];

  // WHO OWNS EACH VILLA'S REPORT. `listing_slugs` is the set of villas a number
  // is connected to, which is not the same question: Era is the enquiry contact
  // on Villa Umah Astanine (Ikiel's villa) AND the owner of Villa Bula, so a
  // per-owner rule would either send her someone else's report or none at all.
  // The portal's owner feed tags each (listing, contact) row 'ops' or 'report',
  // so exactly one number is the report recipient per villa: the dedicated
  // report contact when a listing has one, otherwise its operational contact.
  // Ikiel, 24 Aug 2026. If the feed can't be read we fall back to the old
  // per-owner behaviour rather than skipping the week's reports.
  let recipientOf = null;
  try {
    const fr = await fetch(`${PORTAL_BASE}/api/dashboard?owner_sync=1`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (fr.ok) {
      const rows = (await fr.json())?.owners;
      if (Array.isArray(rows) && rows.length) {
        const bySlug = new Map();
        for (const row of rows) {
          if (!row?.slug || !row?.waNumber) continue;
          const num = String(row.waNumber).replace(/\D/g, '');
          const cur = bySlug.get(row.slug);
          // A 'report' row always wins; otherwise the first 'ops' row stands.
          if (row.role === 'report' || !cur) bySlug.set(row.slug, { num, role: row.role || 'ops' });
        }
        recipientOf = (slug) => bySlug.get(slug)?.num || null;
      }
    }
  } catch (_) { /* fall through to per-owner behaviour */ }
  for (const o of list) {
    // EVERY listing this contact is linked to gets its own report message —
    // a multi-villa owner used to receive only listing_slugs[0], leaving
    // their other villas silently unreported. The template has exactly 4
    // body params and no villa-name slot, so villa identity lives in each
    // message's signed report link.
    const linked = Array.isArray(o.listing_slugs) ? o.listing_slugs.filter(Boolean) : [];
    // Only the villas THIS number is the report recipient for (see above).
    const num = String(o.wa_num || '').replace(/\D/g, '');
    const slugs = recipientOf ? linked.filter(s => recipientOf(s) === num) : linked;
    if (!slugs.length) { skipped++; continue; }
    // Preview: report the routing plan without sending anything or touching
    // dedupe state, so a report-contact change can be checked immediately.
    if (preview) { plan.push({ owner: o.name, wa_num: num, villas: slugs }); continue; }
    // Per-owner dedupe stays a single scalar: checked once before the loop,
    // stamped once after. A mid-loop failure therefore won't re-send the
    // earlier villas next run — accepted trade-off; failures are counted.
    if (o.last_report_sent_at && new Date(o.last_report_sent_at).getTime() > sixDaysAgo) { skipped++; continue; }
    let anySent = false;
    for (const slug of slugs) {
      let d;
      try {
        const rr = await fetch(`${PORTAL_BASE}/api/portal?action=report&slug=${encodeURIComponent(slug)}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
        if (!rr.ok) { failed++; continue; }
        d = await rr.json();
      } catch { failed++; continue; }
      const firstName = String(o.name || 'there').split(/\s+/)[0];
      const views = String(d.metrics?.views?.now ?? 0);
      const enquiries = String(d.metrics?.enquiries?.now ?? 0);
      const tok = reportToken(slug);
      const ok = await sendOwnerReportTemplate(WA_PHONE_ID, WA_TOKEN, o.wa_num, { name: firstName, week: fmtWeekRange(d.week), views, enquiries, tok });
      if (!ok) { failed++; continue; }
      sent++; anySent = true;
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({ owner_id: o.id, wa_num: o.wa_num, direction: 'outbound', content: `[Weekly report sent — ${d.name || slug}: ${views} views, ${enquiries} enquiries]`, timestamp: new Date().toISOString(), source: 'cron', status: 'sent' }),
      }).catch(() => {});
      // Gentle spacing: a 14-villa owner gets 14 templates back-to-back —
      // don't hammer the Graph API or trip per-number rate limits.
      if (slugs.length > 1) await new Promise(res => setTimeout(res, 300));
    }
    if (anySent) {
      await fetch(`${SUPABASE_URL}/rest/v1/owners?id=eq.${o.id}`, {
        method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ last_report_sent_at: new Date().toISOString() }),
      }).catch(() => {});
    }
  }
  return { considered: list.length, sent, skipped, failed, ...(preview ? { plan, routing: recipientOf ? 'per-villa (portal owner feed)' : 'per-owner fallback (feed unavailable)' } : {}) };
}

// Merge an engagement into ONE pipeline bucket, preserving the other pipeline's
// engagement. Mutates the in-memory agent too so a later iteration in the same
// cron run builds on the updated state rather than clobbering it.
async function patchAgentEngagement(url, headers, agent, pipeline, engagement) {
  const merged = setEngagement(agent.campaign_engagement, pipeline, engagement);
  agent.campaign_engagement = merged; // keep in-memory copy current
  try {
    await fetch(`${url}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ campaign_engagement: merged })
    });
  } catch (e) { /* non-fatal */ }
}

async function sendText(phoneId, token, to, text) {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

function getTodayWitaDateStr() {
  const witaTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return witaTime.toISOString().slice(0, 10);
}

async function getTodaySpend(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    return usage[getTodayWitaDateStr()] || 0;
  } catch (e) { return 0; }
}

async function persistTodaySpend(url, headers, newTotal) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    const today = getTodayWitaDateStr();
    usage[today] = newTotal;
    // Trim history beyond 30 days
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Object.keys(usage).forEach(k => { if (k < cutoff) delete usage[k]; });
    await fetch(`${url}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'daily_usage', value: usage })
    });
  } catch (e) { /* non-fatal */ }
}

async function loadProjects(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) && data.length > 0 ? data : null;
  } catch (e) { return null; }
}

function buildPortfolioContextFromDb(projects) {
  if (!projects || projects.length === 0) return FALLBACK_PORTFOLIO;
  return projects.map((p, i) => {
    const lines = [
      `${i + 1}. ${p.name}${p.area ? ' -- ' + p.area : ''}`,
      p.tagline ? `   ${p.tagline}` : null,
      p.commission_pct ? `   Commission: ${p.commission_pct}%` : null
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}


// ─────────────────────────────────────────────────────────────────────
// SAMBA AVAILABILITY NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────
//
// Settings flags (all read from the existing `settings` jsonb table):
//   key 'samba_availability'  value:
//     { enabled: bool, test_agents_only: bool }
//   key 'samba_availability_snapshot'  value:
//     { [propId]: { availableToday, nextLongWindowFrom, monthly } }
//
// Default-off so it ships dark. Flip enabled=true in Supabase when ready.

// Template versioning:
//   v3 — fully branded: "Maya from Samba Rentals", 10% commission line,
//        "Agent Portal" naming. v3 alert has a separate INTRO variant
//        used the very first time an agent ever gets an availability
//        message (long-form greeting), then the regular ALERT every time
//        after — so agents see the introduction once, not on repeat.
//   v2 — slot-based bulleted list, but plainer wording (no intro framing)
//   v1 — single-paragraph fallback before slot templates existed
// We prefer v3 → v2 → v1 per category, and the intro-vs-alert decision
// happens per-agent so introduction state is correct even across rollouts.
// Improvement → emoji tag for visual scanning at the bullet level.
const REASON_EMOJI = {
  new:            '🆕',
  now_available:  '🟢',
  window_earlier: '📅',
  price_drop:     '💰',
};
// Lower number = higher priority (renders first). Newly added properties
// matter most; price drops are nice but rarely time-sensitive.
const REASON_PRIORITY = {
  new:            0,
  now_available:  1,
  window_earlier: 2,
  price_drop:     3,
};
// Trim the "with Dedicated Workspace" tail that some listings carry, to keep
// each bullet legible inside Meta's 240-char per-variable budget once we
// inline a tracking URL.
function shortUnitType(t) {
  return (t || '').split(/\s+with\s+/i)[0].trim();
}
// Build a per-property tracked URL — agent stays in the portal, lands on the
// modal for the specific listing. Falls back to the main tracked URL when
// the property has no slug (very old custom rows pre-slug, defensive).
function propPortalUrl(slug, ref, agentId, base) {
  const safeSlug = String(slug || '').trim();
  if (!safeSlug) return `${base}?ref=${ref}&aid=${agentId}`;
  return `${base}?property=${encodeURIComponent(safeSlug)}&ref=${ref}&aid=${agentId}`;
}

const ALERT_INTRO_V3     = 'samba_availability_intro_v3';
const ALERT_TEMPLATE_V3  = 'samba_availability_alert_v3';
const DIGEST_TEMPLATE_V3 = 'samba_availability_digest_v3';
const ALERT_TEMPLATE_V2  = 'samba_availability_alert_v2';
const DIGEST_TEMPLATE_V2 = 'samba_availability_digest_v2';
const ALERT_TEMPLATE_V1  = 'samba_availability_alert';
const DIGEST_TEMPLATE_V1 = 'samba_availability_digest';
const CAROUSEL_DIGEST = 'samba_weekly_carousel_v1';   // visual Monday digest (fixed greeting baked into the body)
// v2 has a neutral body ("{{1}}" + a one-line tail), so the send-time intro
// renders exactly once — v1 produced "Good morning Hi Wayan, …" double
// salutations whenever an intro sentence was passed. Senders prefer v2 when
// approved; on v1 they fall back to a bare first name so the fixed greeting
// stays grammatical.
const CAROUSEL_DIGEST_V2 = 'samba_weekly_carousel_v2';
function pickCarousel(templatesMap, fullIntro, firstName) {
  if (templatesMap[CAROUSEL_DIGEST_V2]) return { name: CAROUSEL_DIGEST_V2, intro: fullIntro };
  return { name: CAROUSEL_DIGEST, intro: firstName };
}
const AVAILABILITY_CATEGORIES = ['availability_alert', 'availability_digest', 'availability_intro'];
const ALERT_V2_SLOTS = 3;
const DIGEST_AVAIL_SLOTS = 4;
const DIGEST_SOON_SLOTS = 3;
const ALERT_FREQUENCY_HOURS = 72;   // max ~2 event alerts/week + Monday digest = ≤3 touches
// A paused thread (manual takeover) with no message either direction for this
// many days is considered cold and auto-resumed so Maya reclaims coverage.
const AUTO_RESUME_DAYS = 7;
// Minimum genuine improvements for an event alert to interrupt agents; anything
// below rolls into the Monday digest. Raising this is the single biggest lever
// on volume + relevance.
const HIGH_SIGNAL_MIN = 3;
// Days of silence after which the Monday digest drops an agent from weekly to
// a ~monthly rhythm. Measured from last_inbound_at, so it is self-healing: any
// reply pulls the agent straight back into the weekly send.
const DIGEST_SILENT_DAYS = 30;
// Samba opt-in states live on campaign_engagement.samba.status. Existing
// values: 'opted_in', 'enrolled', 'unsubscribed'. This one marks a contact who
// has had the cold first-contact carousel and has not replied yet — tracked,
// but not yet in the daily availability stream.
const INTRO_SENT_STATUS = 'intro_sent';
// Tier-based cadence for event alerts (the Monday digest still goes to everyone
// except paused). Engaged agents get the full stream; disengaged ones only see
// the weekly anchor, which is where most of the 12.6-msg/month cut comes from.
const TIER_EVENT_ALERTS = {
  champion: true, active: true, new: true,   // fully informed
  warm: true,                                // throttled harder (see hours below)
  dormant: false,                            // weekly digest only
};
const TIER_ALERT_HOURS = { warm: 72 };       // warm: at most ~1 alert / 3 days
// Tier vocabulary drift guard — engagement scoring has written 'hot'/'cold'
// rows, and many agents have no engagement_tier at all. Normalise before the
// mute table so an unknown or missing tier can never fall into the full
// event-alert stream by accident (previously NULL defaulted to 'active').
const TIER_ALIASES = { hot: 'active', cold: 'dormant' };
const DEFAULT_TIER = 'warm';
// The scheduled morning broadcast is split into waves 20 min apart
// (vercel.json crons hit ?wave=0/1/2). Cohort = agent.id % AVAILABILITY_WAVES.
// Smooths Meta template volume (quality rating) and Maya's reply burst.
// Bare invocations (manual fire from the dashboard) send to everyone at once.
const AVAILABILITY_WAVES = 3;
const LONG_WINDOW_MOVE_THRESHOLD_DAYS = 7;
const MAX_ALERT_BULLETS = 5;
const MAX_DIGEST_BULLETS = 8;
const TEMPLATE_BODY_BUDGET = 700;     // safety margin under Meta's 1024
const EMPTY_SLOT = '—';               // pad for unused bullet slots (Meta rejects "")
const PORTAL_BASE = 'https://sambarentals.com';

export async function runAvailabilityNotifications(ctx) {
  const { now, sbHeaders, supabaseUrl, agents, templatesMap, waToken, waPhoneId, results, previewMode,
    wave = 0, waveCount = 1 } = ctx;

  const summary = {
    enabled: false, ran: false, recipients: 0,
    event_alerts_sent: 0, weekly_digest_sent: 0,
    skipped_no_changes: 0, skipped_freq_cap: 0, skipped_opt_out: 0,
    skipped_not_eligible: 0, skipped_silent_digest: 0, errors: [],
    preview: previewMode ? {} : undefined,
  };

  // ── Kill switch + cohort filter ─────────────────────────────────
  const config = await loadSetting(supabaseUrl, sbHeaders, 'samba_availability') || {};
  config.marketingCaps = await loadSetting(supabaseUrl, sbHeaders, 'marketing_caps') || {};
  if (!config.enabled) {
    summary.skipped_reason = 'samba_availability.enabled = false';
    return summary;
  }
  summary.enabled = true;

  // Campaign rows (command center): the day's pass is governed by its own
  // campaign's status — digest on Mondays, event alerts otherwise. The intro
  // variant inside the alert pass stamps the availability_intro row so its
  // funnel is tracked separately, but only the day's campaign can pause the
  // pass. Best-effort: a missing row never blocks the broadcast.
  const campDb = { SUPABASE_URL: supabaseUrl, sbHeaders };
  const isMondayForCamp = now.getUTCDay() === 1;
  const alertCamp  = await resolveCampaign(campDb, 'availability_alert');
  const digestCamp = await resolveCampaign(campDb, 'availability_digest');
  const introCamp  = await resolveCampaign(campDb, 'availability_intro');
  const dayCamp = isMondayForCamp ? digestCamp : alertCamp;
  if (isCampaignPaused(dayCamp)) {
    summary.skipped_reason = `campaign paused (command center): ${dayCamp.key}`;
    return summary;
  }

  // ── Digest fetch ────────────────────────────────────────────────
  const digestUrl = process.env.AVAILABILITY_DIGEST_URL;
  const digestSecret = process.env.DIGEST_SHARED_SECRET;
  if (!digestUrl || !digestSecret) {
    summary.errors.push('AVAILABILITY_DIGEST_URL / DIGEST_SHARED_SECRET not set');
    return summary;
  }
  let digest;
  try {
    const r = await fetch(digestUrl, { headers: { Authorization: `Bearer ${digestSecret}` } });
    if (!r.ok) {
      summary.errors.push(`digest fetch ${r.status}`);
      return summary;
    }
    digest = await r.json();
  } catch (e) {
    summary.errors.push('digest fetch failed: ' + e.message);
    return summary;
  }

  // ── Template lookup (v3 preferred, v2 fallback, v1 last) ────────────
  const isMonday = now.getUTCDay() === 1; // 1am UTC Monday ≈ 9am WITA Monday
  const pick = (...names) => names.find(n => templatesMap[n]);
  const regularName = pick(ALERT_TEMPLATE_V3, ALERT_TEMPLATE_V2, ALERT_TEMPLATE_V1);
  // Intro is v3-only; if v3 intro isn't approved yet, first-timers get the
  // regular alert (still rebrand-correct under v3, just less long-form).
  const introName = pick(ALERT_INTRO_V3) || regularName;
  const digestName = pick(DIGEST_TEMPLATE_V3, DIGEST_TEMPLATE_V2, DIGEST_TEMPLATE_V1);
  const neededName = isMonday ? digestName : regularName;
  if (!neededName) {
    summary.errors.push(`no template available (none of v3/v2/v1 ${isMonday ? 'digest' : 'alert'} found)`);
    results.push({ availability: true, action: 'template_missing' });
    return summary;
  }
  summary.template_version = versionOfName(neededName);

  // First-contact detection — agents who've ever received an availability
  // message in any category. Drives intro vs alert choice per agent.
  const introducedSet = isMonday ? new Set() : await loadIntroducedSet(supabaseUrl, sbHeaders);

  // ── Snapshot diff (event alerts only) ───────────────────────────
  // Waves ≥1 never re-diff: wave 0 already advanced the snapshot, so a fresh
  // diff would see "no changes". They reuse the improvements wave 0 stashed
  // for today, and bail if wave 0 never got to a send (kill switch, first
  // run, or below the signal bar — the stash date won't match today).
  const WAVE_STASH_KEY = 'samba_availability_wave';
  const todayKey = now.toISOString().slice(0, 10);
  const newSnapshot = buildSnapshot(digest.properties);
  let improvements;
  if (wave > 0 && !previewMode) {
    const stash = await loadSetting(supabaseUrl, sbHeaders, WAVE_STASH_KEY);
    if (!stash || stash.date !== todayKey) {
      summary.skipped_reason = `wave ${wave + 1}/${waveCount}: no wave stash for ${todayKey}`;
      return summary;
    }
    improvements = { isFirstRun: false, items: stash.items || [] };
    if (!isMonday && improvements.items.length < HIGH_SIGNAL_MIN) {
      summary.ran = true;
      summary.skipped_no_changes = 1;
      return summary;
    }
  } else {
    const prevSnapshot = (await loadSetting(supabaseUrl, sbHeaders, 'samba_availability_snapshot')) || null;
    improvements = prevSnapshot
      ? diffImprovements(prevSnapshot, digest.properties)
      : { isFirstRun: true, items: [] };

    // ── NEW ARRIVALS (wave 0, before the quiet-day early return) ──────
    // Listings that went live since the last pass get their own carousel,
  // ahead of (and excluded from) the regular availability alert. Audience:
  // the event-alert tiers, not on a reduced frequency, no touch in 6h.
  {
    try {
      const arrivalsAudience = agents.filter(a => isAvailabilityEligible(a, config)).filter(a => {
        const tier = TIER_ALIASES[String(a.engagement_tier || '').toLowerCase()] || String(a.engagement_tier || '').toLowerCase() || DEFAULT_TIER;
        if (TIER_EVENT_ALERTS[tier] !== true) return false;
        const freq = String(a.contact_frequency || '').toLowerCase();
        if (freq === 'paused' || freq === 'weekly' || freq === 'monthly') return false;
        if (a.last_availability_alert_at && (now.getTime() - new Date(a.last_availability_alert_at).getTime()) < 6 * 3.6e6) return false;
        return true;
      });
      const arrivalsCamp = await resolveCampaign(campDb, 'new_arrivals');
      if (isCampaignPaused(arrivalsCamp)) {
        summary.new_arrivals = { ran: false, reason: 'campaign paused (command center)' };
      } else {
        summary.new_arrivals = await sendNewArrivals({ SUPABASE_URL: supabaseUrl, sbHeaders }, { phoneId: waPhoneId, token: waToken }, { eligible: arrivalsAudience, digestProperties: digest.properties, previewMode, templatesMap, campaign: arrivalsCamp });
      }
      // Refresh the list so the regular alert respects the 6h touch guard.
      if (summary.new_arrivals?.sent) {
        const stamp = new Date().toISOString();
        const sentIds = new Set(arrivalsAudience.map(a => a.id));
        agents.forEach(a => { if (sentIds.has(a.id)) a.last_availability_alert_at = stamp; });
      }
      // Don't repeat an announced arrival as a "New:" bullet today.
      const announced = (await loadSetting(supabaseUrl, sbHeaders, 'new_arrivals_announced')) || {};
      if (improvements?.items?.length) improvements.items = improvements.items.filter(i => !(i.reason === 'new' && announced[i.slug]));
    } catch (e) { summary.new_arrivals = { error: e.message }; }
  }


    // First-ever run on this CRM: persist snapshot, send nothing (no baseline to diff against).
    if (improvements.isFirstRun && !isMonday) {
      await saveSetting(supabaseUrl, sbHeaders, 'samba_availability_snapshot', newSnapshot);
      summary.ran = true;
      summary.skipped_reason = 'first-run; snapshot saved';
      return summary;
    }

    // High-signal bar: an event alert must carry at least HIGH_SIGNAL_MIN genuine
    // improvements. Sparse days roll into the Monday digest instead of
    // interrupting everyone — this both cuts noise and removes the old "• —" empty
    // bullet padding (which only appeared when there were fewer items than slots).
    if (!isMonday && improvements.items.length < HIGH_SIGNAL_MIN) {
      await saveSetting(supabaseUrl, sbHeaders, 'samba_availability_snapshot', newSnapshot);
      summary.ran = true;
      summary.skipped_no_changes = 1;
      summary.below_signal_bar = improvements.items.length;
      return summary;
    }

    // Stash today's improvements so waves 2..N can reuse them (staggered runs only).
    if (!previewMode && waveCount > 1) {
      await saveSetting(supabaseUrl, sbHeaders, WAVE_STASH_KEY, { date: todayKey, items: improvements.items });
    }
  }

  // ── Recipient filter ────────────────────────────────────────────
  const eligible = agents.filter(a => isAvailabilityEligible(a, config));

  // Staggered runs send to this wave's cohort only; bare runs send to everyone.
  const cohort = waveCount > 1 ? eligible.filter(a => a.id % waveCount === wave) : eligible;
  summary.recipients = cohort.length;
  if (waveCount > 1) summary.wave = `${wave + 1}/${waveCount}`;

  // ── Visual carousel (weekly digest + mid-week availability alerts) ─────
  // Whenever we're about to send an availability message — the Monday digest OR
  // a mid-week "new openings" alert — and the carousel template is approved and
  // the feature flag is on, prepare the swipeable image carousel and send that
  // instead of the plain-text template. Any shortfall (portal unreachable, or
  // <6 villas with cover images) → text fallback, so a send can never break.
  // Carousel is ON by default now (the visual format is the standard); it only
  // stays text if the template isn't approved/loaded, the portal is unreachable,
  // or carousel_enabled is explicitly set to false.
  let carouselCards = null;
  if ((isMonday || improvements.items.length > 0) && config.carousel_enabled !== false && (templatesMap[CAROUSEL_DIGEST] || templatesMap[CAROUSEL_DIGEST_V2])) {
    try {
      carouselCards = await topAvailableVillas(digest.properties, CAROUSEL_CARD_COUNT);
    } catch (_) { carouselCards = null; }
    // Six images to Meta once, not six fetches by Meta per recipient.
    if (carouselCards && !previewMode) {
      const up = await uploadCardMedia(carouselCards, { token: waToken, phoneId: waPhoneId });
      summary.carousel_media = `${up.uploaded} uploaded, ${up.failed} kept as link` + (up.errors.length ? ` (${up.errors.join('; ')})` : '');
    }
    summary.carousel = carouselCards ? `ready (${carouselCards.length} villas)` : 'fallback to text';
  }

  // ── Compose payload ─────────────────────────────────────────────
  // v1 = single body var (paragraph), v2 = one var per bullet slot (real list)
  const alertBody = composeAlertBody(improvements.items);
  const digestBody = composeDigestBody(digest.properties);

  // ── PREVIEW MODE ────────────────────────────────────────────────
  // Composes the message that would be sent to a sample agent — no Meta
  // call, no wa_messages log, no snapshot write. The caller renders this
  // in a confirm-and-fire UI.
  if (previewMode) {
    const sample = eligible.find(a => a.is_test) || eligible[0];
    const sampleName = sample ? firstNameOf(sample.name) : 'Era';
    const ref = isMonday ? 'wa_digest' : 'wa_alert';
    const previewAid = sample?.id || 'preview';
    const trackedUrl = `${PORTAL_BASE}?ref=${ref}&aid=${previewAid}`;
    const perPropUrl = (slug) => propPortalUrl(slug, ref, previewAid, PORTAL_BASE);
    const useName = isMonday ? digestName : regularName;
    const tmpl = templatesMap[useName];
    const useSlots = (tmpl?.placeholderCount || 0) > 3;
    let params;
    if (useSlots) {
      params = isMonday
        ? composeDigestParamsV2(sampleName, digest.properties, trackedUrl, perPropUrl)
        : composeAlertParamsV2(sampleName, improvements.items, trackedUrl, perPropUrl);
    } else {
      params = [sampleName, isMonday ? digestBody : alertBody, trackedUrl];
    }
    let rendered = (tmpl?.body || '');
    params.forEach((p, i) => {
      rendered = rendered.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), p);
    });
    summary.preview = {
      mode: isMonday ? 'weekly_digest' : (improvements.items.length === 0 ? 'no_alerts_no_changes' : 'event_alert'),
      template_name: useName,
      sample_first_name: sampleName,
      sample_agent_id: sample?.id || null,
      rendered_body: rendered,
      improvements_count: improvements.items.length,
      available_now_count: digest.properties.filter(p => p.availability?.availableToday && !p.isHidden).length,
    };
    summary.ran = true;
    return summary;
  }

  // ── Agent of the month (first Monday's digest only) ─────────────
  // Winner = the account-holding agent whose SHARED LINKS earned the most
  // client engagement this month (portal attribution: enquiries ×3 + views).
  // Public recognition is an organic lever: it rewards the behaviour the
  // account campaign is trying to create.
  let shoutoutLine = '';
  try {
    const witaDom = new Date(now.getTime() + 8 * 3600e3).getUTCDate();
    if (now.getUTCDay() === 1 && witaDom <= 7) {
      const stats = await loadSetting(supabaseUrl, sbHeaders, 'agent_portal_stats') || {};
      const attr = stats.attribution_month || {};
      const byHandle = {};
      agents.forEach(a => { const h = a.campaign_engagement?.portal_account?.handle; if (h) byHandle[h] = a; });
      let best = null;
      for (const h of new Set([...Object.keys(attr.views || {}), ...Object.keys(attr.wa || {})])) {
        const score = (attr.wa?.[h] || 0) * 3 + (attr.views?.[h] || 0);
        if ((attr.wa?.[h] || 0) >= 1 && byHandle[h] && (!best || score > best.score)) best = { agent: byHandle[h], score, wa: attr.wa[h] };
      }
      if (best) shoutoutLine = ` — shoutout to ${best.agent.name || 'our top agent'}, whose shared listings brought the most client enquiries this month 👏`;
    }
  } catch { /* recognition is a nicety */ }

  // ── Send loop ───────────────────────────────────────────────────
  for (const agent of cohort) {
    if (agent.samba_alerts_opt_out) { summary.skipped_opt_out++; continue; }
    // Dead numbers (chronic delivery failures / not on WhatsApp) never get
    // broadcasts. Belt-and-braces: the agent fetch already filters these.
    if (agent.dead_number) { summary.skipped_opt_out++; continue; }

    // Idempotency guard — no agent gets a second availability touch within 6h,
    // whatever the day. Protects against double cron fires, a manual re-run
    // after the morning waves, and duplicate Monday digests.
    if (agent.last_availability_alert_at) {
      const hrsSinceAny = (now.getTime() - new Date(agent.last_availability_alert_at).getTime()) / 3.6e6;
      if (hrsSinceAny < 6) { summary.skipped_freq_cap++; continue; }
    }

    // Reduced-frequency preference — set by Maya when an agent asks for fewer
    // messages without unsubscribing. 'weekly' = Monday digest only,
    // 'monthly' = at most one digest per ~4 weeks, 'paused' = nothing.
    const freq = String(agent.contact_frequency || '').toLowerCase();
    if (freq === 'paused') { summary.skipped_freq_cap++; continue; }
    if (!isMonday && (freq === 'weekly' || freq === 'monthly')) { summary.skipped_freq_cap++; continue; }

    // Monday digest used to reach EVERY non-paused agent. On 31 Aug 2026 that
    // was 277 people, of whom 106 had never once replied and 91 more had been
    // silent 31+ days — 71% of the audience getting a marketing template every
    // week with no engagement. Meta reads that the way it is meant to be read
    // (131049: 52 numbers throttled in one weekend, 18% of all sends failing),
    // and the throttle spills onto messages that matter, including the owner
    // relay that should have reached a villa contact while an agent had a
    // client waiting to view.
    //
    // So silence sets the cadence: no reply in DIGEST_SILENT_DAYS → the same
    // ~monthly rhythm an explicit 'monthly' preference gets. Derived from
    // last_inbound_at rather than stored, so a single reply promotes an agent
    // back to weekly on the next run with nothing to reset by hand.
    const silentDays = agent.last_inbound_at
      ? (now.getTime() - new Date(agent.last_inbound_at).getTime()) / 8.64e7
      : Infinity;
    const monthlyCadence = freq === 'monthly' || (isMonday && silentDays > DIGEST_SILENT_DAYS);
    if (isMonday && monthlyCadence) {
      if (!agent.last_availability_alert_at) {
        // Never had one — let it through, then the 27-day gate applies.
      } else {
        const daysSince = (now.getTime() - new Date(agent.last_availability_alert_at).getTime()) / 8.64e7;
        if (daysSince < 27) {
          if (freq !== 'monthly') summary.skipped_silent_digest = (summary.skipped_silent_digest || 0) + 1;
          else summary.skipped_freq_cap++;
          continue;
        }
      }
    }

    // Tier-based cadence (event alerts only; the Monday digest still reaches
    // every non-paused agent). Disengaged tiers are muted from the daily stream
    // so we stop blasting the 95 dormant agents who never reply.
    const tierRaw = String(agent.engagement_tier || '').toLowerCase();
    const tier = TIER_ALIASES[tierRaw] || tierRaw || DEFAULT_TIER;
    // Mute-by-default: only tiers explicitly marked true get the event stream.
    // Unknown vocabulary ('cold', typos, future tiers) → Monday digest only.
    if (!isMonday && TIER_EVENT_ALERTS[tier] !== true) { summary.skipped_tier_cap = (summary.skipped_tier_cap || 0) + 1; continue; }

    // Frequency cap (event alerts only — digest is once weekly so cap is moot).
    // Cap widens for less-engaged tiers so they get fewer interruptions.
    if (!isMonday && agent.last_availability_alert_at) {
      const capHours = TIER_ALERT_HOURS[tier] || ALERT_FREQUENCY_HOURS;
      const hoursSince = (now.getTime() - new Date(agent.last_availability_alert_at).getTime()) / 3.6e6;
      if (hoursSince < capHours) {
        summary.skipped_freq_cap++;
        continue;
      }
    }

    const firstName = firstNameOf(agent.name);
    const ref = isMonday ? 'wa_digest' : 'wa_alert';
    const trackedUrl = `${PORTAL_BASE}?ref=${ref}&aid=${agent.id}`;
    const perPropUrl = (slug) => propPortalUrl(slug, ref, agent.id, PORTAL_BASE);
    // Per-agent template choice: digest on Mondays, intro on first-ever
    // availability send (non-Monday only), regular alert otherwise.
    const isFirstSend = !isMonday && !introducedSet.has(agent.id);
    const useName = isMonday ? digestName : (isFirstSend ? introName : regularName);
    const tmpl = templatesMap[useName];
    const useSlots = (tmpl?.placeholderCount || 0) > 3;
    let params;
    if (useSlots) {
      params = isMonday
        ? composeDigestParamsV2(firstName, digest.properties, trackedUrl, perPropUrl)
        : composeAlertParamsV2(firstName, improvements.items, trackedUrl, perPropUrl);
    } else {
      params = [firstName, isMonday ? digestBody : alertBody, trackedUrl];
    }
    const category = isMonday
      ? 'availability_digest'
      : (isFirstSend && useName === ALERT_INTRO_V3 ? 'availability_intro' : 'availability_alert');

    // Inline the send so we can capture the Meta error body — sendTemplate
    // returns boolean only and the cause is invaluable for diagnosing template
    // rejections (parameter format, language mismatch, unapproved name, etc.)
    let metaErr = null;
    let waMessageId = null;
    // Carousel only for the Monday digest and the first-ever send (intro).
    // Mid-week alerts go as the text template listing ONLY the new openings —
    // the carousel showed the same top villas every day, so agents read
    // back-to-back sends as the identical blast re-sent ("stop sending daily").
    const sendCarousel = !!carouselCards && (isMonday || isFirstSend);
    const carousel = pickCarousel(templatesMap,
      null /* intro chosen below */, firstName);
    const sendName = sendCarousel ? carousel.name : tmpl.name;
    // Rotating referral ask: even ISO weeks only, digest sends only — one
    // gentle line, not every week, never on a first touch.
    const weekNum = Math.floor((now.getTime() - Date.parse(now.getUTCFullYear() + '-01-01')) / (7 * 86400e3));
    const referralLine = (isMonday && !isFirstSend && weekNum % 2 === 0)
      ? ' — PS: know a villa owner? Send me their contact card; founding villas list free for good'
      : '';
    const fullIntro = isFirstSend
      ? `Hi ${firstName}, I'm Maya from Samba Realty — here are current rental openings you can offer clients (10% agent commission)`
      : isMonday
        ? `Hi ${firstName}, here's this week's Samba rentals availability${shoutoutLine || referralLine}`
        : `Hi ${firstName}, new openings on the Samba Rentals Agent Portal`;
    // v2 template: the intro IS the message body. v1: bare name only — its
    // body already carries the greeting and pitch.
    const carouselIntro = carousel.name === CAROUSEL_DIGEST_V2 ? fullIntro : firstName;
    const sendComponents = sendCarousel
      ? buildCarouselComponents(firstName, carouselCards, carouselIntro)
      : [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) }];
    try {
      const r = await fetch(`https://graph.facebook.com/v24.0/${waPhoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + waToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: agent.wa_num, type: 'template',
          template: {
            name: sendName, language: { code: (sendCarousel ? 'en' : (tmpl.language || 'en')) },
            components: sendComponents,
          },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        waMessageId = d.messages?.[0]?.id;
      } else {
        const d = await r.json().catch(() => ({}));
        metaErr = d?.error?.message || `HTTP ${r.status}`;
      }
    } catch (e) {
      metaErr = e.message;
    }

    if (metaErr) {
      summary.errors.push(`agent ${agent.id}: ${metaErr}`);
      continue;
    }

    // Log the full rendered template body so the CRM inbox shows what the
    // agent actually received on WhatsApp. The wa_messages.content column
    // is plain text with no size limit, so no truncation needed.
    let renderedPreview;
    if (sendCarousel) {
      // Rich marker so the console renders the actual swipeable carousel (with
      // hero images + links), matching what the agent sees on WhatsApp. Any
      // consumer that reads plain content still gets a readable "[[carousel]]…".
      renderedPreview = '[[carousel]]' + JSON.stringify({
        title: isMonday ? 'Weekly availability' : 'Current openings',
        cards: carouselCards.map(c => ({
          title: c.name,
          subtitle: [c.detail, c.area].filter(Boolean).join(' · '),
          image: c.imageUrl,
          url: `https://sambarentals.com/?property=${c.slug}`,
          badge: c.badge || null,
        })),
      });
    } else {
      renderedPreview = tmpl.body || '';
      params.forEach((p, i) => {
        renderedPreview = renderedPreview.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), p);
      });
    }
    const rowCamp = category === 'availability_intro' ? introCamp : (isMonday ? digestCamp : alertCamp);
    await fetch(`${supabaseUrl}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: renderedPreview, timestamp: now.toISOString(),
        source: 'cron', category, template_name: sendName,
        campaign_id: rowCamp?.id || null,
        // Store Meta's message id + a 'sent' baseline so the webhook status
        // handler can match delivered/read events to these rows. Without
        // wa_message_id, every cron send was invisible to delivery tracking.
        wa_message_id: waMessageId, status: 'sent',
      }),
    }).catch(() => {});
    await fetch(`${supabaseUrl}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ last_availability_alert_at: now.toISOString() }),
    }).catch(() => {});

    if (isMonday) summary.weekly_digest_sent++;
    else if (isFirstSend && useName === ALERT_INTRO_V3) { summary.event_alerts_sent++; summary.intro_sent = (summary.intro_sent || 0) + 1; }
    else summary.event_alerts_sent++;
    results.push({ availability: true, agent: agent.name || agent.id,
      kind: isMonday ? 'weekly_digest' : (isFirstSend && useName === ALERT_INTRO_V3 ? 'intro_alert' : 'event_alert'),
      template: useName });
  }

  // Persist the new snapshot only after a successful send pass — if Supabase
  // is down mid-loop, leaving the old snapshot means we'll retry next cron.
  // Waves ≥1 never advance the snapshot; that's wave 0's job.
  if (wave === 0) {
    await saveSetting(supabaseUrl, sbHeaders, 'samba_availability_snapshot', newSnapshot);
  }
  summary.ran = true;

  // Command-center bookkeeping: the day's campaign row gets the run stamped
  // and its lifetime counters advanced (waves accumulate — bump is atomic).
  const introSent = summary.intro_sent || 0;
  const skips = (summary.skipped_freq_cap || 0) + (summary.skipped_opt_out || 0) + (summary.skipped_tier_cap || 0) + (summary.skipped_silent_digest || 0);
  if (isMonday) {
    await noteRun(campDb, digestCamp, { sent: summary.weekly_digest_sent, skipped: skips, failed: summary.errors.length, summary: { wave: summary.wave || 'all', sent: summary.weekly_digest_sent, skipped: skips, errors: summary.errors.length } });
  } else {
    await noteRun(campDb, alertCamp, { sent: Math.max(0, summary.event_alerts_sent - introSent), skipped: skips, failed: summary.errors.length, summary: { wave: summary.wave || 'all', sent: summary.event_alerts_sent - introSent, skipped: skips, errors: summary.errors.length } });
    if (introSent) await noteRun(campDb, introCamp, { sent: introSent });
  }
  return summary;
}

// ── INTRO SWEEP ──────────────────────────────────────────────────────
// One-time first-touch for enrolled agents the availability broadcast has
// never reached. The daily broadcast is event-driven (needs ≥HIGH_SIGNAL_MIN
// new openings) and tier-gated (dormant = Monday digest only), so an agent
// can sit enrolled for weeks without a single availability message. This
// sweep works through that backlog at a capped rate: each run sends the
// carousel intro (top available villas + "I'm Maya" framing) to up to
// `intro_sweep_daily_cap` never-touched agents, most-engaged tiers first.
// Dormant agents are deliberately INCLUDED — their tag usually comes from
// old KAYA sales history, and everyone deserves exactly one proper hello.
// Off by default: runs only when settings.samba_availability
// .intro_sweep_daily_cap is set to a positive number.
export async function runIntroSweep(ctx) {
  const { now, sbHeaders, supabaseUrl, agents, templatesMap, waToken, waPhoneId, results, previewMode } = ctx;
  const summary = { enabled: false, sent: 0, queue: 0, errors: [] };

  const config = await loadSetting(supabaseUrl, sbHeaders, 'samba_availability') || {};
  config.marketingCaps = await loadSetting(supabaseUrl, sbHeaders, 'marketing_caps') || {};
  const cap = parseInt(config.intro_sweep_daily_cap, 10) || 0;
  if (!config.enabled || cap <= 0) {
    summary.skipped_reason = !config.enabled
      ? 'samba_availability.enabled = false'
      : 'intro_sweep_daily_cap not set';
    return summary;
  }
  const introSweepCamp = await resolveCampaign({ SUPABASE_URL: supabaseUrl, sbHeaders }, 'availability_intro');
  if (isCampaignPaused(introSweepCamp)) {
    summary.skipped_reason = 'campaign paused (command center)';
    return summary;
  }
  summary.enabled = true;

  // Mondays are digest day — never stack an intro on top of the digest.
  if (now.getUTCDay() === 1) { summary.skipped_reason = 'Monday (digest day)'; return summary; }

  // Carousel-only: the visual intro doesn't depend on that day's availability
  // changes, so it can go out on quiet days too. If the carousel template
  // isn't approved or the portal can't serve enough covers, skip today rather
  // than sending a text intro with empty bullet slots.
  if (!templatesMap[CAROUSEL_DIGEST] && !templatesMap[CAROUSEL_DIGEST_V2]) { summary.skipped_reason = 'carousel template not approved'; return summary; }

  const digestUrl = process.env.AVAILABILITY_DIGEST_URL;
  const digestSecret = process.env.DIGEST_SHARED_SECRET;
  if (!digestUrl || !digestSecret) {
    summary.errors.push('AVAILABILITY_DIGEST_URL / DIGEST_SHARED_SECRET not set');
    return summary;
  }
  let digest;
  try {
    const r = await fetch(digestUrl, { headers: { Authorization: `Bearer ${digestSecret}` } });
    if (!r.ok) { summary.errors.push(`digest fetch ${r.status}`); return summary; }
    digest = await r.json();
  } catch (e) {
    summary.errors.push('digest fetch failed: ' + e.message);
    return summary;
  }
  let cards;
  try { cards = await topAvailableVillas(digest.properties, CAROUSEL_CARD_COUNT); } catch (_) { cards = null; }
  if (!cards) { summary.skipped_reason = 'carousel unavailable (portal or covers short)'; return summary; }
  if (!previewMode) {
    const up = await uploadCardMedia(cards, { token: waToken, phoneId: waPhoneId });
    summary.carousel_media = `${up.uploaded} uploaded, ${up.failed} kept as link`;
  }

  // Never-touched = no availability-category wa_messages row AND no
  // last_availability_alert_at stamp. Belt-and-braces on purpose: old
  // wa_messages rows get pruned (which would make a long-introduced agent
  // look new again), while the timestamp column never lies about a past send.
  const introduced = await loadIntroducedSet(supabaseUrl, sbHeaders);
  const TIER_ORDER = { champion: 0, active: 1, hot: 1, new: 2, warm: 3, dormant: 5, cold: 5 };
  const tierRank = (a) => TIER_ORDER[String(a.engagement_tier || '').toLowerCase().trim()] ?? 4;
  // Anyone who has ever written to us goes first, ahead of the tier ordering:
  // a contact with an existing conversation is both likelier to answer and
  // less likely to treat a first-contact message as spam. 16 of the 73 in the
  // current backlog are in that position.
  const hasTalked = (a) => (a.last_inbound_at ? 0 : 1);
  const queue = agents
    .filter(a => isIntroEligible(a, config))
    .filter(a => !introduced.has(a.id) && !a.last_availability_alert_at)
    .sort((a, b) => hasTalked(a) - hasTalked(b) || tierRank(a) - tierRank(b) || a.id - b.id);
  summary.queue = queue.length;
  // Visibility: how much of the queue is cold first-contact vs. an opted-in
  // agent who simply never came up in a broadcast. The two behave differently
  // downstream, and the split is the number worth watching after a run.
  summary.queue_never_enrolled = queue.filter(a => !a.campaign_engagement?.samba).length;

  for (const agent of queue.slice(0, cap)) {
    const firstName = firstNameOf(agent.name);
    const introCarousel = pickCarousel(templatesMap,
      `Hi ${firstName}, I'm Maya from Samba Realty — here are current rental openings you can offer clients (10% agent commission)`, firstName);
    const components = buildCarouselComponents(firstName, cards, introCarousel.intro);

    let metaErr = null;
    let waMessageId = null;
    try {
      const r = await fetch(`https://graph.facebook.com/v24.0/${waPhoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + waToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: agent.wa_num, type: 'template',
          template: { name: introCarousel.name, language: { code: 'en' }, components },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        waMessageId = d.messages?.[0]?.id;
      } else {
        const d = await r.json().catch(() => ({}));
        metaErr = d?.error?.message || `HTTP ${r.status}`;
      }
    } catch (e) {
      metaErr = e.message;
    }
    if (metaErr) {
      summary.errors.push(`agent ${agent.id}: ${metaErr}`);
      continue;
    }

    // Same rich carousel marker the broadcast logs, so the console inbox
    // renders what the agent actually saw.
    const renderedPreview = '[[carousel]]' + JSON.stringify({
      title: 'Meet Maya — current openings',
      cards: cards.map(c => ({
        title: c.name,
        subtitle: [c.detail, c.area].filter(Boolean).join(' · '),
        image: c.imageUrl,
        url: `https://sambarentals.com/?property=${c.slug}`,
        badge: c.badge || null,
      })),
    });
    await fetch(`${supabaseUrl}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: renderedPreview, timestamp: now.toISOString(),
        source: 'cron', category: 'availability_intro', template_name: introCarousel.name,
        campaign_id: introSweepCamp?.id || null,
        wa_message_id: waMessageId, status: 'sent',
      }),
    }).catch(() => {});

    // Stamp the touch AND advance the CRM pipeline label — a real first
    // message is exactly what 'Not contacted' → 'Contacted' means. (The
    // manual campaign flow does the same bump client-side.)
    const patch = { last_availability_alert_at: now.toISOString() };
    const sambaStatus = agent.samba?.status || 'Not contacted';
    if (sambaStatus === 'Not contacted') {
      patch.samba = { ...(agent.samba || {}), status: 'Contacted' };
    }
    // Cold first contact: stamp the opt-in record so this agent is tracked,
    // but as INTRO_SENT rather than opted_in. That keeps them OUT of the daily
    // availability stream until they answer — one unsolicited message is a
    // reasonable introduction, a daily series off the back of it is not, and
    // it is block-and-report rates on exactly that pattern that cost a
    // WhatsApp number its quality rating.
    if (!agent.campaign_engagement?.samba) {
      patch.campaign_engagement = {
        ...(agent.campaign_engagement || {}),
        samba: { source: 'intro_sweep', status: INTRO_SENT_STATUS, intro_at: now.toISOString() },
      };
    }
    await fetch(`${supabaseUrl}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify(patch),
    }).catch(() => {});

    summary.sent++;
    results.push({ availability: true, agent: agent.name || agent.id, kind: 'intro_sweep', template: introCarousel.name });
  }
  summary.remaining = Math.max(0, queue.length - summary.sent);
  await noteRun({ SUPABASE_URL: supabaseUrl, sbHeaders }, introSweepCamp, {
    sent: summary.sent, failed: summary.errors.length,
    summary: { sent: summary.sent, queue: summary.queue, remaining: summary.remaining, errors: summary.errors.length },
  });
  return summary;
}

// ── ACCOUNT-INVITE SWEEP ─────────────────────────────────────────────
// One-time reactivation nudge for dormant/cold agents: create a free portal
// account (Google sign-in) and get a personal share link with click/enquiry
// attribution — a reason to come back that isn't "yet another availability
// blast". Works through the backlog at a capped daily rate, one invite per
// agent ever (campaign_engagement.account_invite stamp + wa_messages
// backstop). Off by default: runs only when settings.samba_availability
// .account_invite_daily_cap is a positive number AND the template is approved.
const ACCOUNT_INVITE_TEMPLATE = 'samba_account_invite_v1';
const ACCOUNT_INVITE_CATEGORY = 'account_invite';

// ── AUTO-RESPONDER DETECTION ────────────────────────────────────────────
// An agent whose "replies" are an out-of-office robot looks permanently
// engaged: every send refreshes last_inbound_at within a minute (Abirama
// Properties — 13 inbounds, 3 distinct texts, all at 01:01, 27 Aug 2026).
// Heuristic: among the last 5 inbounds, the same non-trivial text (>40
// chars) appearing 3+ times is a machine — humans never resend identical
// paragraphs. Detected agents get a durable stamp so campaign filters skip
// them without re-checking (a real human reply later is unaffected: these
// checks gate CAMPAIGN sends only, never Maya's replies to real messages).
async function isAutoResponderThread(supabaseUrl, headers, agentId) {
  try {
    const rows = await (await fetch(
      `${supabaseUrl}/rest/v1/wa_messages?agent_id=eq.${agentId}&direction=eq.inbound&order=timestamp.desc&limit=5&select=content`,
      { headers })).json();
    if (!Array.isArray(rows) || rows.length < 3) return false;
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const counts = {};
    for (const r of rows) {
      const c = norm(r.content);
      if (c.length <= 40) continue;
      counts[c] = (counts[c] || 0) + 1;
      if (counts[c] >= 3) return true;
    }
    return false;
  } catch { return false; }
}

async function stampAutoResponder(supabaseUrl, headers, agent) {
  await fetch(`${supabaseUrl}/rest/v1/agents?id=eq.${agent.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      campaign_engagement: {
        ...(agent.campaign_engagement || {}),
        auto_responder: { detected_at: new Date().toISOString() },
      },
    }),
  }).catch(() => {});
}

// ── CLOSING-WINDOW NUDGE (hourly, rides the relay sweep) ────────────────
// The 24h free-text window is a wasting asset: once it shuts, reaching the
// agent costs a template re-opener. In the final 1–2 hours of a window,
// agents with a concrete OPEN LOOP get one last free-text nudge. Scope is
// deliberately tight (Dony's lesson, 26 Aug 2026): the only loop today is
// "engaged with the account invite but never created an account". One nudge
// per agent EVER, contact hours only, never when paused. The 1h-wide bucket
// means each closing window is seen exactly once by the hourly cron; the
// stamp is belt-and-braces on top.
export async function sweepClosingWindows(db, wa) {
  const summary = { checked: 0, nudged: 0 };
  const witaHour = (new Date().getUTCHours() + 8) % 24;
  if (witaHour < 9 || witaHour >= 21) { summary.skipped = 'outside contact hours'; return summary; }
  const hi = new Date(Date.now() - 22 * 3600e3).toISOString();   // window closes within 2h…
  const lo = new Date(Date.now() - 23 * 3600e3).toISOString();   // …but not within 1h
  const rows = await fetch(
    `${db.SUPABASE_URL}/rest/v1/agents?last_inbound_at=gte.${lo}&last_inbound_at=lte.${hi}&select=id,name,wa_num,last_inbound_at,campaign_engagement,automation_override`,
    { headers: db.sbHeaders }).then(r => r.json()).catch(() => []);
  for (const a of (Array.isArray(rows) ? rows : [])) {
    summary.checked++;
    if (a.automation_override === 'paused' || a.automation_override === 'off') continue;
    const ce = a.campaign_engagement || {};
    if (ce.auto_responder) continue;                    // robot inbox, not a person
    const inv = ce.account_invite;
    if (!inv?.sent_at) continue;                        // no invite → no open loop
    if (ce.portal_account) continue;                    // already has an account
    if (inv.window_nudge_at) continue;                  // one nudge ever
    if (!(a.last_inbound_at > inv.sent_at)) continue;   // never engaged with the invite
    const num = String(a.wa_num || '').replace(/\D/g, '');
    if (!num) continue;
    if (await isAutoResponderThread(db.SUPABASE_URL, db.sbHeaders, a.id)) {
      await stampAutoResponder(db.SUPABASE_URL, db.sbHeaders, a);
      continue;
    }
    const first = firstNameOf(a.name);
    const link = `https://sambarentals.com/?signin=1&ref=acct_invite&aid=${a.id}`;
    const body = `${first && first !== 'there' ? first + ' — one' : 'One'} small thing before I let you go 😊 Your agent account is a single tap with Google: ${link}\n\nTakes 20 seconds, and every listing you share starts counting for you. If now isn't the time, no worries at all!`;
    let mid = null;
    try {
      const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body } }),
      });
      const d = await r.json().catch(() => ({}));
      mid = d?.messages?.[0]?.id || null;
    } catch { /* skip on failure */ }
    if (!mid) continue;
    // Nudges roll up under the account-invite campaign (its categories claim
    // both). Deliberately not gated on that campaign's paused status — the
    // nudge closes a loop already opened with this agent.
    const nudgeCamp = await resolveCampaign(db, 'account_invite');
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: db.sbHeaders,
      body: JSON.stringify({
        agent_id: a.id, wa_num: num, direction: 'outbound', content: body,
        wa_message_id: mid, timestamp: new Date().toISOString(),
        source: 'cron', category: 'account_invite_nudge', status: 'sent',
        campaign_id: nudgeCamp?.id || null,
      }),
    }).catch(() => {});
    await bumpCampaign(db, nudgeCamp?.id, { sent: 1 });
    await fetch(`${db.SUPABASE_URL}/rest/v1/agents?id=eq.${a.id}`, {
      method: 'PATCH', headers: db.sbHeaders,
      body: JSON.stringify({
        campaign_engagement: { ...ce, account_invite: { ...inv, window_nudge_at: new Date().toISOString() } },
      }),
    }).catch(() => {});
    summary.nudged++;
  }
  return summary;
}

// ── VIEWINGS-FEATURE ANNOUNCEMENT (one-time, capped sweep) ──────────────
// Tell agents Maya can now book viewings (confirm the slot with the villa,
// calendar invites both ways, day-of reminders). Unlike the invite sweep this
// targets ENGAGED agents — they're the ones with clients to bring — ordered
// most-recently-active first. One per agent ever; capped per day; drains its
// queue and stops by itself. Ikiel, 26 Aug 2026.
const VIEWINGS_ANNOUNCE_TEMPLATE = 'samba_viewings_v1';
const VIEWINGS_ANNOUNCE_CATEGORY = 'viewings_announce';
const VIEWINGS_ANNOUNCE_RECENT_DAYS = 90;   // "engaged" = wrote to us in this window

export async function runViewingsAnnounceSweep(ctx) {
  const { now, sbHeaders, supabaseUrl, agents, templatesMap, waToken, waPhoneId, results } = ctx;
  const summary = { enabled: false, sent: 0, queue: 0, errors: [] };

  const config = await loadSetting(supabaseUrl, sbHeaders, 'samba_availability') || {};
  config.marketingCaps = await loadSetting(supabaseUrl, sbHeaders, 'marketing_caps') || {};
  const cap = parseInt(config.viewings_announce_daily_cap, 10) || 0;
  if (!config.enabled || cap <= 0) {
    summary.skipped_reason = !config.enabled
      ? 'samba_availability.enabled = false'
      : 'viewings_announce_daily_cap not set';
    return summary;
  }
  const vaCamp = await resolveCampaign({ SUPABASE_URL: supabaseUrl, sbHeaders }, 'viewings_announce');
  if (isCampaignPaused(vaCamp)) {
    summary.skipped_reason = 'campaign paused (command center)';
    return summary;
  }
  summary.enabled = true;

  if (now.getUTCDay() === 1) { summary.skipped_reason = 'Monday (digest day)'; return summary; }
  if (!templatesMap[VIEWINGS_ANNOUNCE_TEMPLATE]) {
    summary.skipped_reason = `${VIEWINGS_ANNOUNCE_TEMPLATE} not approved yet`;
    return summary;
  }

  const announcedSet = await loadCategorySet(supabaseUrl, sbHeaders, [VIEWINGS_ANNOUNCE_CATEGORY]);
  const today = now.toISOString().slice(0, 10);
  const recentCutoff = now.getTime() - VIEWINGS_ANNOUNCE_RECENT_DAYS * 86400e3;
  const queue = agents
    .filter(a => a.last_inbound_at && Date.parse(a.last_inbound_at) > recentCutoff)
    .filter(a => !a.campaign_engagement?.auto_responder)
    .filter(a => !isMarketingCapped(a, config) && passesSambaBaseGate(a, config))
    .filter(a => !a.campaign_engagement?.viewings_announce && !announcedSet.has(a.id))
    .filter(a => !String(a.last_availability_alert_at || '').startsWith(today))
    .sort((a, b) => String(b.last_inbound_at || '').localeCompare(String(a.last_inbound_at || '')) || a.id - b.id);
  summary.queue = queue.length;
  summary.auto_responders = 0;

  for (const agent of queue) {
    if (summary.sent >= cap) break;
    // A robot inbox isn't an engaged agent — detect, stamp, move on without
    // burning a cap slot on it.
    if (await isAutoResponderThread(supabaseUrl, sbHeaders, agent.id)) {
      await stampAutoResponder(supabaseUrl, sbHeaders, agent);
      summary.auto_responders++;
      continue;
    }
    const firstName = firstNameOf(agent.name);
    let metaErr = null;
    let waMessageId = null;
    try {
      const r = await fetch(`${GRAPH}/${waPhoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + waToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: agent.wa_num, type: 'template',
          template: {
            name: VIEWINGS_ANNOUNCE_TEMPLATE, language: { code: 'en' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: firstName }] },
            ],
          },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        waMessageId = d.messages?.[0]?.id;
      } else {
        const d = await r.json().catch(() => ({}));
        metaErr = d?.error?.message || `HTTP ${r.status}`;
      }
    } catch (e) {
      metaErr = e.message;
    }
    if (metaErr) {
      summary.errors.push(`agent ${agent.id}: ${metaErr}`);
      continue;
    }

    const bodyTmpl = templatesMap[VIEWINGS_ANNOUNCE_TEMPLATE]?.body || '';
    const rendered = bodyTmpl.replace(/\{\{1\}\}/g, firstName)
      || `Viewings announcement sent to ${firstName} (${VIEWINGS_ANNOUNCE_TEMPLATE})`;
    await fetch(`${supabaseUrl}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: rendered, timestamp: now.toISOString(),
        source: 'cron', category: VIEWINGS_ANNOUNCE_CATEGORY,
        template_name: VIEWINGS_ANNOUNCE_TEMPLATE,
        campaign_id: vaCamp?.id || null,
        wa_message_id: waMessageId, status: 'sent',
      }),
    }).catch(() => {});
    await fetch(`${supabaseUrl}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({
        campaign_engagement: {
          ...(agent.campaign_engagement || {}),
          viewings_announce: { sent_at: now.toISOString(), template: VIEWINGS_ANNOUNCE_TEMPLATE },
        },
      }),
    }).catch(() => {});

    summary.sent++;
    results.push({ availability: true, agent: agent.name || agent.id, kind: 'viewings_announce', template: VIEWINGS_ANNOUNCE_TEMPLATE });
  }
  summary.remaining = Math.max(0, queue.length - summary.sent);
  await noteRun({ SUPABASE_URL: supabaseUrl, sbHeaders }, vaCamp, {
    sent: summary.sent, failed: summary.errors.length,
    summary: { sent: summary.sent, queue: summary.queue, remaining: summary.remaining, auto_responders: summary.auto_responders, errors: summary.errors.length },
  });
  return summary;
}

export async function runAccountInviteSweep(ctx) {
  const { now, sbHeaders, supabaseUrl, agents, templatesMap, waToken, waPhoneId, results } = ctx;
  const summary = { enabled: false, sent: 0, queue: 0, errors: [] };

  const config = await loadSetting(supabaseUrl, sbHeaders, 'samba_availability') || {};
  config.marketingCaps = await loadSetting(supabaseUrl, sbHeaders, 'marketing_caps') || {};
  const cap = parseInt(config.account_invite_daily_cap, 10) || 0;
  if (!config.enabled || cap <= 0) {
    summary.skipped_reason = !config.enabled
      ? 'samba_availability.enabled = false'
      : 'account_invite_daily_cap not set';
    return summary;
  }
  const inviteCamp = await resolveCampaign({ SUPABASE_URL: supabaseUrl, sbHeaders }, 'account_invite');
  if (isCampaignPaused(inviteCamp)) {
    summary.skipped_reason = 'campaign paused (command center)';
    return summary;
  }
  summary.enabled = true;

  // Mondays are digest day — don't stack an invite on top of the digest.
  if (now.getUTCDay() === 1) { summary.skipped_reason = 'Monday (digest day)'; return summary; }

  // templatesMap only carries APPROVED templates, so presence = approved.
  if (!templatesMap[ACCOUNT_INVITE_TEMPLATE]) {
    summary.skipped_reason = `${ACCOUNT_INVITE_TEMPLATE} not approved yet`;
    return summary;
  }

  const invitedSet = await loadCategorySet(supabaseUrl, sbHeaders, [ACCOUNT_INVITE_CATEGORY]);
  const today = now.toISOString().slice(0, 10);
  // Eligible: the dormant/cold tiers, plus ANY agent who has never replied
  // regardless of tier label — the audit found ~40 silent "new"/"unset"
  // imports that predate the welcome flow and were queued for nothing
  // (broadcast-only limbo, the Yoga case; 27 Aug 2026). One invite each,
  // same pacing, same stamps.
  const isDormant = (a) => /^(dormant|cold)$/i.test(String(a.engagement_tier || '').trim())
    || (!a.last_inbound_at && !(a.campaign_engagement?.samba?.status === 'enrolled'));
  // Agents who have ever written to us go first — likelier to answer, and a
  // nudge to a known contact can't read as spam.
  const hasTalked = (a) => (a.last_inbound_at ? 0 : 1);
  const queue = agents
    .filter(isDormant)
    .filter(a => !isMarketingCapped(a, config) && passesSambaBaseGate(a, config))
    .filter(a => !a.campaign_engagement?.account_invite && !invitedSet.has(a.id))
    // Skip anyone already messaged today (the broadcast runs before us).
    .filter(a => !String(a.last_availability_alert_at || '').startsWith(today))
    .sort((a, b) => hasTalked(a) - hasTalked(b)
      || String(b.last_inbound_at || '').localeCompare(String(a.last_inbound_at || ''))
      || a.id - b.id);
  summary.queue = queue.length;

  for (const agent of queue.slice(0, cap)) {
    const firstName = firstNameOf(agent.name);
    let metaErr = null;
    let waMessageId = null;
    try {
      const r = await fetch(`${GRAPH}/${waPhoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + waToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: agent.wa_num, type: 'template',
          template: {
            name: ACCOUNT_INVITE_TEMPLATE, language: { code: 'en' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: firstName }] },
              // Dynamic URL suffix = CRM agent id, so the portal attributes
              // the visit (?signin=1&ref=acct_invite&aid=<id>).
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(agent.id) }] },
            ],
          },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        waMessageId = d.messages?.[0]?.id;
      } else {
        const d = await r.json().catch(() => ({}));
        metaErr = d?.error?.message || `HTTP ${r.status}`;
      }
    } catch (e) {
      metaErr = e.message;
    }
    if (metaErr) {
      summary.errors.push(`agent ${agent.id}: ${metaErr}`);
      continue;
    }

    // Log a readable copy for the console inbox (the template body with the
    // name filled in), then stamp the one-time invite on the agent row.
    const bodyTmpl = templatesMap[ACCOUNT_INVITE_TEMPLATE]?.body || '';
    // The template carries a URL button the console can't render — append it
    // to the logged copy so the thread shows what the agent actually received
    // (it looked like a link-less pitch, 26 Aug 2026).
    const rendered = (bodyTmpl.replace(/\{\{1\}\}/g, firstName)
      || `Account invite sent to ${firstName} (${ACCOUNT_INVITE_TEMPLATE})`)
      + `\n\n[Button: Create my account → sambarentals.com/?signin=1&ref=acct_invite&aid=${agent.id}]`;
    await fetch(`${supabaseUrl}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: rendered, timestamp: now.toISOString(),
        source: 'cron', category: ACCOUNT_INVITE_CATEGORY,
        template_name: ACCOUNT_INVITE_TEMPLATE,
        campaign_id: inviteCamp?.id || null,
        wa_message_id: waMessageId, status: 'sent',
      }),
    }).catch(() => {});
    await fetch(`${supabaseUrl}/rest/v1/agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({
        campaign_engagement: {
          ...(agent.campaign_engagement || {}),
          account_invite: { sent_at: now.toISOString(), template: ACCOUNT_INVITE_TEMPLATE },
        },
      }),
    }).catch(() => {});

    summary.sent++;
    results.push({ availability: true, agent: agent.name || agent.id, kind: 'account_invite', template: ACCOUNT_INVITE_TEMPLATE });
  }
  summary.remaining = Math.max(0, queue.length - summary.sent);
  await noteRun({ SUPABASE_URL: supabaseUrl, sbHeaders }, inviteCamp, {
    sent: summary.sent, failed: summary.errors.length,
    summary: { sent: summary.sent, queue: summary.queue, remaining: summary.remaining, errors: summary.errors.length },
  });
  return summary;
}

// Distinct agent_ids with any wa_messages row in the given categories — the
// durable-ish backstop behind per-agent stamps (rows get pruned, stamps don't).
// Empty set on failure so a degraded Supabase can't suppress the whole run.
async function loadCategorySet(url, headers, categories) {
  try {
    const params = categories.map(c => encodeURIComponent(c)).join(',');
    const rows = await sbRows(url, headers, `wa_messages?select=agent_id&category=in.(${params})&agent_id=not.is.null&order=id.asc`);
    return new Set((rows || []).map(x => x.agent_id));
  } catch (e) {
    return new Set();
  }
}

// Extract the agent's first name for personalisation. Skips Balinese caste
// prefixes (`I` / `Ni`) so "I Made Agus Iryawan" becomes "Made" rather than
// "I". Falls back to "there" when name is missing.
function firstNameOf(name) {
  if (!name) return 'there';
  // A contact saved by number gets "Hi +60166473209" otherwise (27 Aug 2026).
  if (/\d{5,}/.test(String(name))) return 'there';
  const parts = String(name).trim().split(/\s+/);
  if (!parts.length) return 'there';
  if (parts.length > 1 && /^(I|Ni)$/i.test(parts[0])) return parts[1];
  return parts[0];
}

function versionOfName(name) {
  if (!name) return null;
  if (name.endsWith('_v3')) return 'v3';
  if (name.endsWith('_v2')) return 'v2';
  return 'v1';
}

// Distinct agent_ids that have ever received any availability-category
// message. Used as the "already introduced" set so we know not to send the
// long-form intro twice. Returns an empty set on query failure so a degraded
// Supabase doesn't suppress sends — the worst case is a repeat intro.
async function loadIntroducedSet(url, headers) {
  try {
    const params = AVAILABILITY_CATEGORIES.map(c => encodeURIComponent(c)).join(',');
    const rows = await sbRows(url, headers, `wa_messages?select=agent_id&category=in.(${params})&agent_id=not.is.null&order=id.asc`);
    return new Set((rows || []).map(x => x.agent_id));
  } catch (e) {
    return new Set();
  }
}

// Per-agent eligibility. The CRM's campaign_engagement.samba.status is
// free-form ('Not contacted', 'opted in', 'completed_sequence', and others),
// so we treat the *presence* of a Samba engagement record as "enrolled in
// the Samba pipeline." Explicit mutes (samba_alerts_opt_out, automation
// override = paused/off, or status containing 'declined' / 'stalled') still
// exclude. test_agents_only restricts to is_test=true for staged rollout.
// Shared gate: the hard exclusions that apply to ANY Samba send — no number,
// opted out, automation paused, wrong service line. Split out so the intro
// sweep can honour all of them without also demanding prior enrolment.
function passesSambaBaseGate(agent, config) {
  if (!agent.wa_num) return false;
  if (agent.samba_alerts_opt_out) return false;
  if (agent.dead_number) return false;
  if (agent.automation_override === 'paused' || agent.automation_override === 'off') return false;
  if (config.test_agents_only && !agent.is_test) return false;
  if (agent.campaign_engagement?.service_type === 'leasehold') return false;
  const status = String(agent.campaign_engagement?.samba?.status || '').toLowerCase().trim();
  if (/declined|stalled|unsubscribed/.test(status)) return false;
  return true;
}

// Who may receive the FIRST-CONTACT intro. Deliberately does NOT require
// campaign_engagement.samba: that field is the opt-in record, and the whole
// point of the intro sweep is to reach people who don't have one yet. Before
// this, the sweep filtered on isAvailabilityEligible, so the 74 contacts most
// in need of an introduction were excluded from the feature built to
// introduce them — it only ever served already-opted-in agents who happened
// never to have been messaged.
function isIntroEligible(agent, config) {
  if (isMarketingCapped(agent, config)) return false;
  if (!passesSambaBaseGate(agent, config)) return false;
  // Already introduced and waiting on a reply — don't send a second one.
  const status = String(agent.campaign_engagement?.samba?.status || '').toLowerCase().trim();
  if (status === INTRO_SENT_STATUS) return false;
  return true;
}

// Meta per-user marketing cap (131049) recorded by the status webhook:
// skip anyone capped until later than now. Missing/old entries → eligible.
function isMarketingCapped(agent, config) {
  const caps = config.marketingCaps || {};
  const num = String(agent.wa_num || '').replace(/\D/g, '');
  const c = caps[num];
  return !!(c && c.until && Date.parse(c.until) > Date.now());
}
function isAvailabilityEligible(agent, config) {
  if (!agent.wa_num) return false;
  if (isMarketingCapped(agent, config)) return false;
  if (agent.samba_alerts_opt_out) return false;
  if (agent.automation_override === 'paused' || agent.automation_override === 'off') return false;
  if (config.test_agents_only && !agent.is_test) return false;
  // Service classification: leasehold-only agents don't do rentals, so they are
  // excluded from Samba (rental) availability alerts — but NOT opted out (they
  // still get KAYA leasehold outreach). 'rental' and 'both' stay eligible.
  if (agent.campaign_engagement?.service_type === 'leasehold') return false;
  const samba = agent.campaign_engagement?.samba;
  if (!samba) return false;
  // Treat any non-empty status as enrolled, except explicit terminal states
  const status = String(samba.status || '').toLowerCase().trim();
  if (/declined|stalled|unsubscribed/.test(status)) return false;
  // Introduced but silent: they've had one cold first-contact carousel and
  // have not answered it. They do NOT join the daily availability stream on
  // the strength of a message they never asked for — a reply promotes them
  // (see promoteIntroToOptedIn in the inbound webhook).
  if (status === INTRO_SENT_STATUS) return false;
  return true;
}

function buildSnapshot(properties) {
  const out = {};
  for (const p of properties) {
    out[p.id] = {
      availableToday: !!p.availability?.availableToday,
      nextLongWindowFrom: p.availability?.nextLongWindowFrom || null,
      monthly: p.monthly || null,
    };
  }
  return out;
}

// Improvement = any of: became available today, long-window opens ≥7 days
// earlier, brand-new property in catalog, monthly price dropped.
function diffImprovements(prev, properties) {
  const items = [];
  for (const p of properties) {
    const prior = prev[p.id];
    const meta = propMeta(p);
    if (!prior) {
      items.push({ propId: p.id, slug: p.slug, name: p.name, reason: 'new', summary: `New: ${p.name}${meta ? ` (${meta})` : ''}${p.monthly ? ' — ' + p.monthly + '/mo' : ''}` });
      continue;
    }
    if (!prior.availableToday && p.availability?.availableToday) {
      items.push({ propId: p.id, slug: p.slug, name: p.name, reason: 'now_available', summary: `${p.name}${meta ? ` (${meta})` : ''} just opened — ${p.monthly || 'ask Era'}/mo` });
      continue;
    }
    if (p.availability?.nextLongWindowFrom && prior.nextLongWindowFrom) {
      // Positive delta = the long window now opens EARLIER than yesterday's
      // snapshot said. A window sliding later (someone booked) is not news.
      const delta = daysBetween(p.availability.nextLongWindowFrom, prior.nextLongWindowFrom);
      if (delta >= LONG_WINDOW_MOVE_THRESHOLD_DAYS) {
        items.push({ propId: p.id, slug: p.slug, name: p.name, reason: 'window_earlier',
          summary: `${p.name}${meta ? ` (${meta})` : ''} available from ${formatShortDate(p.availability.nextLongWindowFrom)} (was ${formatShortDate(prior.nextLongWindowFrom)})` });
        continue;
      }
    }
    if (prior.monthly && p.monthly && parseRate(p.monthly) < parseRate(prior.monthly)) {
      items.push({ propId: p.id, slug: p.slug, name: p.name, reason: 'price_drop',
        summary: `${p.name}${meta ? ` (${meta})` : ''} price dropped to ${p.monthly}/mo (was ${prior.monthly})` });
    }
  }
  // Sort by urgency: newly added listings first, then just-opened, then
  // window-moved-earlier, then price drops. Within the same priority bucket
  // the catalog order is preserved (sort is stable) — so building groups
  // (Hostex first by display_order, customs alphabetical) still cluster.
  items.sort((a, b) => (REASON_PRIORITY[a.reason] ?? 99) - (REASON_PRIORITY[b.reason] ?? 99));
  return { isFirstRun: false, items };
}

// Meta's WhatsApp Cloud API rejects newlines and tabs inside template
// variables (only the surrounding static text in the template may contain
// them). v1 templates have a single body var so we collapse to a paragraph
// with ' · ' separators. v2 templates have one var per bullet slot so the
// surrounding template body renders the bullets as a true list.

// ── v1 (paragraph fallback) ─────────────────────────────────────────
function composeAlertBody(improvements) {
  const trimmed = improvements.slice(0, MAX_ALERT_BULLETS);
  const more = improvements.length - trimmed.length;
  const items = trimmed.map(i => boldName(i.summary, i.name));
  if (more > 0) items.push(`+ ${more} more on the portal`);
  return clipToBudget(items.join(' · '), TEMPLATE_BODY_BUDGET);
}

function composeDigestBody(properties) {
  const { availableNow, openingSoon } = bucketDigestProperties(properties);
  const sections = [];
  if (availableNow.length) {
    const items = availableNow.slice(0, MAX_DIGEST_BULLETS).map(formatAvailableLine);
    if (availableNow.length > MAX_DIGEST_BULLETS) items.push(`+ ${availableNow.length - MAX_DIGEST_BULLETS} more`);
    sections.push('AVAILABLE NOW — ' + items.join(' · '));
  }
  if (openingSoon.length) {
    const items = openingSoon.slice(0, MAX_DIGEST_BULLETS).map(formatOpeningLine);
    if (openingSoon.length > MAX_DIGEST_BULLETS) items.push(`+ ${openingSoon.length - MAX_DIGEST_BULLETS} more`);
    sections.push('OPENING SOON — ' + items.join(' · '));
  }
  if (!sections.length) sections.push('No properties currently available. Check back next week.');
  return clipToBudget(sections.join(' || '), TEMPLATE_BODY_BUDGET);
}

// ── v2 (slot-based: one variable per bullet line) ───────────────────
// Returns [firstName, slot1, slot2, slot3, overflow, url] — 6 params total.
// Each bullet now leads with a reason-emoji and ends with a tracked
// per-property URL so the agent taps straight into that listing's portal
// modal (no scanning the full catalog after they tap through).
function composeAlertParamsV2(firstName, improvements, mainUrl, perPropUrl) {
  const params = [firstName];
  for (let i = 0; i < ALERT_V2_SLOTS; i++) {
    if (i < improvements.length) {
      const imp = improvements[i];
      params.push(formatBulletLine(imp.summary, imp.name, imp.reason, perPropUrl && perPropUrl(imp.slug)));
    } else {
      params.push(EMPTY_SLOT);
    }
  }
  const more = improvements.length - ALERT_V2_SLOTS;
  params.push(more > 0 ? `+ ${more} more on the portal` : EMPTY_SLOT);
  params.push(mainUrl);
  return params;
}

// Returns [firstName, avail1..4, soon1..3, url] — 9 params total
function composeDigestParamsV2(firstName, properties, mainUrl, perPropUrl) {
  const { availableNow, openingSoon } = bucketDigestProperties(properties);
  const params = [firstName];
  for (let i = 0; i < DIGEST_AVAIL_SLOTS; i++) {
    params.push(i < availableNow.length
      ? clipToBudget(appendUrl(formatAvailableLine(availableNow[i]), perPropUrl && perPropUrl(availableNow[i].slug)), 240)
      : EMPTY_SLOT);
  }
  for (let i = 0; i < DIGEST_SOON_SLOTS; i++) {
    params.push(i < openingSoon.length
      ? clipToBudget(appendUrl(formatOpeningLine(openingSoon[i]), perPropUrl && perPropUrl(openingSoon[i].slug)), 240)
      : EMPTY_SLOT);
  }
  params.push(mainUrl);
  return params;
}

// Reason-emoji + bolded property name + summary + inline tracked URL.
function formatBulletLine(summary, name, reason, url) {
  const emoji = REASON_EMOJI[reason] || '•';
  const body = boldName(summary, name);
  const tail = url ? ` → ${url}` : '';
  return clipToBudget(`${emoji} ${body}${tail}`, 240);
}
function appendUrl(line, url) {
  return url ? `${line} → ${url}` : line;
}

// ── shared formatting helpers ───────────────────────────────────────
function bucketDigestProperties(properties) {
  const todayStr = new Date().toISOString().split('T')[0];
  const availableNow = properties.filter(p => p.availability?.availableToday && !p.isHidden);
  const openingSoon = properties.filter(p => !p.availability?.availableToday
    && p.availability?.nextLongWindowFrom
    && daysBetween(todayStr, p.availability.nextLongWindowFrom) <= 30
    && !p.isHidden);
  return { availableNow, openingSoon };
}

// "1BR Apartment · Tumbak Bayuh, Pererenan" — whichever parts exist.
// The unit-type tail ("with Dedicated Workspace") gets stripped so each
// bullet stays under the 240-char per-variable budget after we inline a
// tracked URL.
function propMeta(p) {
  return [shortUnitType(p.unitType), p.tag].filter(Boolean).join(' · ');
}

function formatAvailableLine(p) {
  const meta = propMeta(p);
  const price = p.monthly ? `${p.monthly}/mo${p.yearly ? ' · ' + p.yearly + '/yr' : ''}` : 'ask Era';
  return `*${p.name}*${meta ? ` (${meta})` : ''} — ${price}`;
}

function formatOpeningLine(p) {
  const meta = propMeta(p);
  const when = formatShortDate(p.availability.nextLongWindowFrom);
  const price = p.monthly ? `${p.monthly}/mo` : 'price TBC';
  return `*${p.name}*${meta ? ` (${meta})` : ''} — opens ${when} (${price})`;
}

// Wraps the first occurrence of `name` in *bold* markers. Safe against
// re-bolding (skips if already wrapped) so the function is idempotent.
function boldName(summary, name) {
  if (!summary || !name) return summary;
  if (summary.includes(`*${name}*`)) return summary;
  return summary.replace(name, `*${name}*`);
}

// Settings helpers — wrap the jsonb settings table the rest of the cron uses
async function loadSetting(url, headers, key) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.value || null;
  } catch (e) { return null; }
}

async function saveSetting(url, headers, key, value) {
  try {
    await fetch(`${url}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value }),
    });
  } catch (e) { /* non-fatal */ }
}

// "27jt" → 27000000. "ask" / undefined → Infinity (so "ask" never looks like
// a price drop vs a numeric price).
function parseRate(s) {
  if (!s) return Infinity;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(jt|m)?/i);
  if (!m) return Infinity;
  const n = parseFloat(m[1]);
  return /jt|m/i.test(m[2] || '') ? n * 1_000_000 : n;
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + 'T00:00:00Z') - new Date(fromStr + 'T00:00:00Z')) / 86400000);
}

function formatShortDate(s) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(s + 'T00:00:00Z');
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function clipToBudget(s, budget) {
  if (s.length <= budget) return s;
  return s.slice(0, budget - 1).replace(/\s+\S*$/, '') + '…';
}
