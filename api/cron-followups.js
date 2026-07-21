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
import { topAvailableVillas, buildCarouselComponents, CAROUSEL_CARD_COUNT } from '../lib/wa-carousel.js';
import { reconcileAllRentals, pullAgentAnalytics } from '../lib/rental-sync.js';
import { buildAndSendOwnerReport } from '../lib/daily-report.js';
import { runReview, buildReviewKbContext } from '../lib/maya-review.js';

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

FOLLOW-UP STYLE:
- Be specific about what you're waiting for. Don't say "just checking in."
- Match the warmth to the follow-up number: gentle → social proof → offer help → last nudge.
- Always leave the agent an easy out (e.g. "no rush, just keeping it on your radar").`;

const GRAPH = 'https://graph.facebook.com/v19.0';
const FOLLOWUP_INTERVAL_DAYS = 3;
const MAX_FOLLOWUPS = 4;
const STAGES_NEEDING_FOLLOWUP = ['agreement_requested', 'signed'];
// Shared with the webhook cap — both charge the same daily_usage counter, so
// this is the effective ceiling for the whole CRM's Claude spend. $2.00 with
// accurate per-token costing (see costOfUsage) allows ~100+ replies/day.
const DAILY_SPEND_CAP_USD = 2.00;
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
      const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=*&wa_num=not.is.null`, { headers: sbHeaders });
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
    const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=*&wa_num=not.is.null`, { headers: sbHeaders });
    const agents = await r.json();
    if (!Array.isArray(agents)) {
      return res.status(500).json({ error: 'Failed to fetch agents' });
    }

    // Load portfolio context for Maya's prompt
    const projects = await loadProjects(SUPABASE_URL, sbHeaders);
    const portfolio = buildPortfolioContextFromDb(projects);

    const now = new Date();
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
    if (todaySpend >= DAILY_SPEND_CAP_USD) {
      await logCronRun({ kind: 'suspended', spend: +todaySpend.toFixed(2) });
      return res.status(200).json({ ran_at: now.toISOString(), suspended: true, reason: `daily spend cap ($${DAILY_SPEND_CAP_USD}) already reached: $${todaySpend.toFixed(2)}` });
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
      if (welcomeTpl) {
        for (const agent of agents) {
          const samba = agent.campaign_engagement?.samba;
          if (!samba?.welcome_pending || !agent.wa_num) continue;
          const fName = String(agent.name || '').trim().split(/\s+/)[0] || 'there';
          const ok = await sendTemplate(WA_PHONE_ID, WA_TOKEN, agent.wa_num, welcomeTpl, [fName]);
          if (!ok) { results.push({ agent: agent.name || agent.id, action: 'deferred_welcome_failed' }); continue; }
          // Clear the flag so it sends exactly once (preserve the rest of the bucket).
          await patchAgentEngagement(SUPABASE_URL, sbHeaders, agent, 'samba', { ...samba, welcome_pending: false });
          const rendered = (welcomeTpl.body || '').replace(/\{\{1\}\}/g, fName);
          await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
            method: 'POST', headers: sbHeaders,
            body: JSON.stringify({
              agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
              content: rendered, timestamp: now.toISOString(), source: 'cron',
              category: 'onboarding', template_name: welcomeTpl.name
            })
          }).catch(() => {});
          welcomesSent++;
          results.push({ agent: agent.name || agent.id, action: 'deferred_welcome_sent' });
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

    const protoFromHost = req.headers['x-forwarded-proto'] || 'https';
    const selfHost = req.headers.host;
    const selfOrigin = selfHost ? `${protoFromHost}://${selfHost}` : null;

    if (globalMode === 'autopilot' && selfOrigin) {
      for (const agent of agents) {
        if (agent.automation_override === 'paused' || agent.automation_override === 'off') continue;
        const existingDraft = (agent.suggested_reply || '').trim();
        if (!existingDraft) continue;
        if (existingDraft.startsWith('[')) continue;   // system status messages
        if (!agent.wa_num) continue;
        // Spend gate — regeneration costs ~$0.02 in Claude
        if (todaySpend + COST_PER_REPLY_USD >= DAILY_SPEND_CAP_USD) {
          results.push({ agent: agent.name || agent.id, action: 'draft_skipped', reason: 'spend_cap' });
          continue;
        }

        // REGENERATE the reply fresh using the canonical Maya prompt path
        let freshReply = null, freshCost = COST_PER_REPLY_USD;
        try {
          const sgRes = await fetch(`${selfOrigin}/api/supabase`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        if (todaySpend + COST_PER_REPLY_USD >= DAILY_SPEND_CAP_USD) {
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
        const ok = await sendTemplate(WA_PHONE_ID, WA_TOKEN, agent.wa_num, tmpl, [firstName]);
        if (!ok) {
          results.push({ agent: agent.name || agent.id, pipeline: engPl, type: 'sequence_send_failed', template: nextStep.template_name });
          continue;
        }
        await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
          method: 'POST', headers: sbHeaders,
          body: JSON.stringify({
            agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
            content: renderedBody, timestamp: now.toISOString(),
            source: 'cron', campaign_id: eng.campaign_id
          })
        }).catch(() => {});
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
        if (todaySpend + COST_PER_REPLY_USD >= DAILY_SPEND_CAP_USD) {
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

    // ── RENTALS RECONCILE (daily safety net) ─────────────────────────
    // The portal pushes every listing edit to us in real time (listing-sync
    // webhook into api/supabase.js); this daily pass re-syncs everything in
    // case a webhook was ever missed, so prices/badges can't silently drift.
    let rentalsReconcile = null;
    if (!previewMode) {
      try { rentalsReconcile = await reconcileAllRentals({ SUPABASE_URL, headers: sbHeaders }); }
      catch (e) { rentalsReconcile = { error: e.message }; }
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
    let weeklyReview = null;
    if (!previewMode && now.getUTCDay() === 0) {
      try {
        const kbContext = await buildReviewKbContext(SUPABASE_URL, sbHeaders);
        const staged = await runReview(
          { SUPABASE_URL, headers: sbHeaders, ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY },
          { kbContext }
        );
        weeklyReview = { staged: true, week_of: staged.week_of, threads: staged.thread_count,
          lessons: staged.lessons?.length || 0, questions: staged.questions?.length || 0,
          grade: staged.scoreboard?.grade };
        // Notify Ikiel in the chat app (push -> deep-link to the review panel) so
        // a staged review never sits unseen. Skip empty weeks. Best-effort.
        if (staged.thread_count > 0) {
          const push = await sendOwnerPush({ SUPABASE_URL, headers: sbHeaders }, buildReviewPushPayload(staged));
          weeklyReview.notified = push.sent || 0;
        }
      } catch (e) { weeklyReview = { error: e.message }; }
    }

    // Safety-net: catch any numbers agents shared in the last few days that
    // weren't auto-captured live, and add them to the CRM. Best-effort; the
    // action dedupes so it can't create twins. (Full-history backfill is the
    // 🧲 button in the console.)
    let backfill = null;
    if (!previewMode && selfOrigin) {
      try {
        const bf = await fetch(`${selfOrigin}/api/supabase`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'backfill_contacts', payload: { since_days: 3, limit: 40 } })
        });
        backfill = bf.ok ? await bf.json() : { error: `HTTP ${bf.status}` };
      } catch (e) { backfill = { error: e.message }; }
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
        resumed: autoResumed || 0,
        briefing: !!ownerReport?.sent,
        review: weeklyReview?.grade || (weeklyReview?.staged ? 'staged' : null),
        backfilled: backfill?.created || 0,
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
      rentals_reconcile: rentalsReconcile,
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
    return r.ok;
  } catch (e) { return false; }
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
const CAROUSEL_DIGEST = 'samba_weekly_carousel_v1';   // visual Monday digest
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
    skipped_not_eligible: 0, errors: [],
    preview: previewMode ? {} : undefined,
  };

  // ── Kill switch + cohort filter ─────────────────────────────────
  const config = await loadSetting(supabaseUrl, sbHeaders, 'samba_availability') || {};
  if (!config.enabled) {
    summary.skipped_reason = 'samba_availability.enabled = false';
    return summary;
  }
  summary.enabled = true;

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
  if ((isMonday || improvements.items.length > 0) && config.carousel_enabled !== false && templatesMap[CAROUSEL_DIGEST]) {
    try {
      carouselCards = await topAvailableVillas(digest.properties, CAROUSEL_CARD_COUNT);
    } catch (_) { carouselCards = null; }
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

  // ── Send loop ───────────────────────────────────────────────────
  for (const agent of cohort) {
    if (agent.samba_alerts_opt_out) { summary.skipped_opt_out++; continue; }

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
    if (isMonday && freq === 'monthly' && agent.last_availability_alert_at) {
      const daysSince = (now.getTime() - new Date(agent.last_availability_alert_at).getTime()) / 8.64e7;
      if (daysSince < 27) { summary.skipped_freq_cap++; continue; }
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
    const sendName = sendCarousel ? CAROUSEL_DIGEST : tmpl.name;
    const carouselIntro = isFirstSend
      ? `Hi ${firstName}, I'm Maya from Samba Realty — here are current rental openings you can offer clients (10% agent commission)`
      : isMonday
        ? `Hi ${firstName}, here's this week's Samba rentals availability`
        : `Hi ${firstName}, new openings on the Samba Rentals Agent Portal`;
    const sendComponents = sendCarousel
      ? buildCarouselComponents(firstName, carouselCards, carouselIntro)
      : [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) }];
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
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
    await fetch(`${supabaseUrl}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: agent.wa_num, direction: 'outbound',
        content: renderedPreview, timestamp: now.toISOString(),
        source: 'cron', category, template_name: sendName,
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
  return summary;
}

// Extract the agent's first name for personalisation. Skips Balinese caste
// prefixes (`I` / `Ni`) so "I Made Agus Iryawan" becomes "Made" rather than
// "I". Falls back to "there" when name is missing.
function firstNameOf(name) {
  if (!name) return 'there';
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
    const r = await fetch(
      `${url}/rest/v1/wa_messages?select=agent_id&category=in.(${params})&agent_id=not.is.null&limit=10000`,
      { headers }
    );
    if (!r.ok) return new Set();
    const rows = await r.json();
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
function isAvailabilityEligible(agent, config) {
  if (!agent.wa_num) return false;
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
      const delta = daysBetween(prior.nextLongWindowFrom, p.availability.nextLongWindowFrom);
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
