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

import { MAYA_PERSONA, PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO } from '../lib/kb.js';

const GRAPH = 'https://graph.facebook.com/v19.0';
const FOLLOWUP_INTERVAL_DAYS = 3;
const MAX_FOLLOWUPS = 4;
const STAGES_NEEDING_FOLLOWUP = ['agreement_requested', 'signed'];

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

  try {
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

    for (const agent of agents) {
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

        // Generate follow-up message
        const followupText = await generateFollowupMessage(
          ANTHROPIC_KEY, agent, projectName, proj, portfolio, count + 1
        );
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

    return res.status(200).json({
      ran_at: now.toISOString(),
      total_agents: agents.length,
      sent, stalled, skipped,
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
  const firstName = agent.name ? agent.name.split(' ')[0] : 'there';
  const stageContext = proj.stage === 'agreement_requested'
    ? `You previously asked them to send over their listing agreement for ${projectName}. They haven't sent it yet. This is follow-up #${followupNumber} of ${MAX_FOLLOWUPS}. Ask in a way that's appropriate for the follow-up number (1=gentle reminder, 2=mention that other agents are signing too, 3=offer to send a sample agreement format, 4=last friendly nudge before you back off).`
    : `Ikiel has signed the listing agreement for ${projectName} and you're now waiting for them to publish the listing and send back the live URL. This is follow-up #${followupNumber} of ${MAX_FOLLOWUPS}. Ask softly when they think they'll have it live (1=easy reminder, 2=ask if anything is blocking them, 3=offer to share marketing copy or photos, 4=last nudge).`;

  const system = `${MAYA_PERSONA}

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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: `Send the follow-up now.` }]
      })
    });
    const data = await res.json();
    return (data.content?.[0]?.text || '').trim();
  } catch (e) {
    console.warn('generateFollowupMessage failed:', e.message);
    return null;
  }
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
