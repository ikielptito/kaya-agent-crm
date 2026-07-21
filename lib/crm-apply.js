// Shared CRM-apply helpers + the crm_updates/crm_actions instruction block.
// Extracted from api/whatsapp-webhook.js so BOTH Maya paths — the live webhook
// AND the server-side suggest_reply action (console "Suggest" button +
// resume_unanswered catch-up) — record the pipeline/opt-out/handoff changes
// Maya recognises. Before this was shared, suggest_reply asked Maya for
// text-only output and silently dropped every CRM signal (21 Jul 2026: agent
// #78 asked to stop updates, Maya's catch-up reply promised to, but nothing
// was recorded). One source of truth = the two paths can't drift.
import { baseAgentFields, createAgentRow } from './agents.js';

export async function patchAgent(url, headers, id, fields) {
  await fetch(`${url}/rest/v1/agents?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify(fields)
  }).catch(e => console.warn('patchAgent failed:', e.message));
}

export async function applyCrmUpdates(url, headers, agent, updates, evidenceQuote) {
  // updates: [{ field: 'projects.Clay House.status', value: 'Listed', reason: '...' }]
  // Apply each update to the agent, log to maya_updates for review.
  // CRITICAL: when multiple updates target the same root (e.g. projects.X.status and
  // projects.X.stage), they must accumulate into the SAME patch[root] object, not
  // each overwrite the previous with a fresh clone of agent[root].
  const evidence = String(evidenceQuote || '');
  const patch = {};
  const logs = [];
  for (const u of updates) {
    if (!u.field || u.value === undefined) continue;
    // Resolve time markers — Maya outputs __NOW__ / __NOW+3D__ etc, server fills the real ISO.
    let value = u.value;
    if (typeof value === 'string') {
      if (value === '__NOW__') value = new Date().toISOString();
      else if (value === '__NOW+3D__') value = new Date(Date.now() + 3 * 86400000).toISOString();
      else if (value === '__NOW+7D__') value = new Date(Date.now() + 7 * 86400000).toISOString();
    }
    const parts = u.field.split('.');
    if (parts.length === 1) {
      patch[parts[0]] = value;
    } else {
      const root = parts[0];
      // Initialise patch[root] from agent[root] on FIRST touch only.
      // On subsequent updates targeting the same root, build on the in-progress patch.
      if (!(root in patch)) {
        patch[root] = JSON.parse(JSON.stringify(agent[root] || {}));
      }
      let cursor = patch[root];
      for (let i = 1; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = value;
    }
    logs.push({
      agent_id: agent.id,
      field: u.field,
      new_value: typeof value === 'object' ? JSON.stringify(value) : String(value),
      reason: u.reason || '',
      evidence: evidence.slice(0, 500),
      by_maya: true,
      created_at: new Date().toISOString()
    });
  }
  // Apply the patch to the agent (in-place; the main patchAgent later will write conversation_summary too)
  if (Object.keys(patch).length > 0) {
    await patchAgent(url, headers, agent.id, patch);
  }
  // Log each change (best-effort; table may not exist yet)
  for (const log of logs) {
    await fetch(`${url}/rest/v1/maya_updates`, {
      method: 'POST', headers,
      body: JSON.stringify(log)
    }).catch(e => console.warn('maya_updates log failed:', e.message));
  }
}

// Structural CRM actions from Maya (vs field updates). Currently only
// create_agent: an agent referred a teammate (usually via a WhatsApp contact
// card) who should start receiving availability updates.
export async function applyCrmActions(url, headers, agent, actions, evidenceQuote) {
  for (const a of actions) {
    if (a.type !== 'create_agent') continue;
    const waNum = String(a.wa_num || '').replace(/[^\d]/g, '');
    const name = String(a.name || '').trim().slice(0, 80);
    // Guardrails: plausible international number, non-empty name, no invented digits
    if (!name || waNum.length < 9 || waNum.length > 15) continue;
    try {
      // Dedupe by number — if the person already exists, don't create a twin.
      const exists = await fetch(`${url}/rest/v1/agents?wa_num=eq.${waNum}&select=id,name`, { headers }).then(r => r.json());
      if (Array.isArray(exists) && exists.length > 0) {
        await fetch(`${url}/rest/v1/maya_updates`, {
          method: 'POST', headers,
          body: JSON.stringify({
            agent_id: agent.id, field: 'create_agent',
            new_value: `SKIPPED (exists as #${exists[0].id} ${exists[0].name}): ${name} +${waNum}`,
            reason: a.reason || 'referral', evidence: String(evidenceQuote || '').slice(0, 500),
            by_maya: true, created_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        continue;
      }
      // Reliable, self-healing insert (shared with the assistant console) — sets
      // the full NOT-NULL baseline the proven first-message insert uses and
      // self-heals any column the schema adds. Enrolls in Samba so the new
      // contact starts receiving Maya's updates immediately.
      const fields = baseAgentFields({
        name, waNum, agency: agent.agency || null,
        referrerId: agent.id, referrerName: agent.name || `agent #${agent.id}`,
        source: 'referral', reason: a.reason || 'referral',
        serviceType: a.service_type || null,
      });
      const createRes = await createAgentRow(url, headers, fields);
      if (!createRes.ok) { console.warn('applyCrmActions create_agent insert failed:', createRes.error); }
      const newId = createRes.row?.id || null;
      await fetch(`${url}/rest/v1/maya_updates`, {
        method: 'POST', headers,
        body: JSON.stringify({
          agent_id: agent.id, field: 'create_agent',
          new_value: `Created agent${newId ? ' #' + newId : ''}: ${name} +${waNum}`,
          reason: a.reason || 'referral', evidence: String(evidenceQuote || '').slice(0, 500),
          by_maya: true, created_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      // Redirect case: the agent asked us to contact the NEW number INSTEAD of
      // them. Opt the ORIGINAL out of rentals updates here, deterministically,
      // so it can never be missed (independent of any crm_updates Maya emits).
      if (a.replace === true || a.replace === 'true') {
        await patchAgent(url, headers, agent.id, { samba_alerts_opt_out: true });
        await fetch(`${url}/rest/v1/maya_updates`, {
          method: 'POST', headers,
          body: JSON.stringify({
            agent_id: agent.id, field: 'samba_alerts_opt_out', new_value: 'true',
            reason: `redirected future updates to ${name} +${waNum}`,
            evidence: String(evidenceQuote || '').slice(0, 500),
            by_maya: true, created_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('applyCrmActions create_agent failed:', e.message);
    }
  }
}

// The crm_updates / crm_actions instruction block Maya follows. Kept here so
// the webhook and suggest_reply prompts stay in lockstep — if the pipeline
// rules change, they change once. No interpolations in this text, so it
// embeds identically in either prompt.
export const CRM_SIGNALS_INSTRUCTIONS = `You can suggest CRM updates when the agent's message clearly indicates a pipeline change. The structured lifecycle is:

  pitched → interested → agreement_requested → agreement_received → signed → link_received
                                                                                ↘ declined / stalled

For each project, set both .status (display) and .stage (lifecycle) when triggered:

Trigger → fields to update:
- You proactively mention/describe a project to an agent for the first time (no prior stage on that project) →
    projects.<Name>.status = "Contacted", projects.<Name>.stage = "pitched"
- Agent says they'll list a project ("I can list this", "Let's add it to my portfolio") →
    projects.<Name>.status = "Listing agreed", projects.<Name>.stage = "interested"
- Agent asks to see the listing agreement, OR you proactively offer to send it →
    projects.<Name>.stage = "agreement_requested"
    projects.<Name>.next_followup_at = (3 days from now, ISO string)
- Agent says "I've sent the agreement" / sends a document that's clearly the signed contract →
    projects.<Name>.status = "Agreement signed", projects.<Name>.stage = "agreement_received"
    projects.<Name>.next_followup_at = null   (waiting on Ikiel, no auto-followup)
- Agent shares a listing URL or says "the listing is live at..." →
    projects.<Name>.status = "Listed", projects.<Name>.stage = "link_received"
    projects.<Name>.url = "<the URL they provided>"
    projects.<Name>.next_followup_at = null
- Agent declines ("not interested", "doesn't fit our portfolio", "we only do freehold/Canggu/etc") →
    projects.<Name>.status = "Declined", projects.<Name>.stage = "declined"
    projects.<Name>.next_followup_at = null

Be conservative — only update when the language is unambiguous.

ENGAGEMENT TIER — classify the agent's engagement level based on the conversation history and this message. Set via crm_updates when the tier changes:

  engagement_tier values:
  - "hot"   — actively looking for a client, asking specific availability/pricing, requesting brochures, scheduling visits
  - "warm"  — responsive and interested but not actively pushing (acknowledges info, asks casual questions, says "will keep in mind")
  - "cold"  — minimal engagement, one-word replies only, long gaps between messages, or explicitly disinterested without fully declining

Update "engagement_tier" whenever you see a clear signal. Example crm_update:
  { "field": "engagement_tier", "value": "hot", "reason": "agent requesting specific availability for a client" }

Do NOT downgrade from "hot" to "warm" on a single quiet message — only downgrade if the pattern is sustained. Do NOT set a tier on the very first message from a brand-new agent (wait for at least one substantive exchange).

CONTACT FREQUENCY — when an agent asks to hear from us LESS OFTEN but does not fully unsubscribe ("too many messages", "just the weekly one is fine", "only message me monthly", "stop spamming but keep me posted", threats to block unless we slow down), set contact_frequency via crm_updates:
  - "weekly"  — they only get the Monday digest, no per-event alerts (default choice when they just say "less")
  - "monthly" — one digest a month at most
  - "normal"  — restore full frequency (only when they explicitly ask for more again)
Example: { "field": "contact_frequency", "value": "weekly", "reason": "agent asked for fewer messages" }
Acknowledge the change in your reply ("Understood — I'll only send the weekly summary from now on."). Do NOT set samba opt-out for these agents; frequency reduction is exactly so we don't lose them entirely.

SERVICE CLASSIFICATION — KAYA has two sides: Samba = monthly RENTALS, and KAYA Developments = leasehold/freehold property SALES. Agents differ in what they handle, and getting this right controls what we send them. Whenever an agent's message reveals which side they work, record it via crm_updates on the field "campaign_engagement.service_type":
  - "rental"    — they only handle monthly rentals / stays
  - "leasehold" — they only handle property SALES (leasehold/freehold); they do NOT do rentals
  - "both"      — they handle both rentals and sales
Example: { "field": "campaign_engagement.service_type", "value": "leasehold", "reason": "agent said they only do sales, not rentals" }
CRITICAL — "leasehold" is NOT an opt-out. A leasehold-only agent STILL receives our leasehold/sales outreach; the system simply stops sending them rental availability alerts. So when an agent says something like "we only do leasehold/sales, not rentals" (often "…please contact [teammate] for rentals"), you MUST: (1) set campaign_engagement.service_type = "leasehold" on THIS agent via crm_updates, and (2) do NOT set samba_alerts_opt_out and do NOT set replace:true — they are staying with us for leasehold. Only classify when the agent makes it clear; if it's ambiguous, leave service_type unset.

TEAM HANDOFF / NEW CONTACTS — this is CRITICAL and MANDATORY. ALWAYS emit a create_agent crm_action whenever the agent gives us ANY alternate WhatsApp number to use for future contact. There is no exception: if a message contains a phone number and any hint that we should reach that number (a colleague, a department, "contact X instead", "send updates to Y", a shared contact card, "for rentals message …"), you MUST create the contact. This covers: (a) a shared WhatsApp contact card ("[Agent shared a WhatsApp contact card: Name — +628…]"), (b) a teammate's name + number to add to updates, and (c) a redirect — they tell us to contact a different number/colleague/department/division instead (e.g. "for monthly/rental please contact our long-term rental team on +62 822…", "message my colleague X on …", "send future updates to …"). Use crm_actions so we can reach them directly:
  { "type": "create_agent", "name": "<person or team name, e.g. 'Oniriq — Long Term Rentals'>", "wa_num": "<digits only, e.g. 6281234567890>", "reason": "redirect: contact this number for rentals", "service_type": "rental", "replace": false }
Set "service_type" on the NEW contact to what THEY handle — e.g. if the agent redirects rentals to a colleague, that colleague is "rental"; a sales colleague is "leasehold".
Choosing "replace" — think about whether the ORIGINAL agent still wants to hear from us:
- MOST COMMON (partial handoff, e.g. "we only do leasehold, contact X for rentals"): set "replace": false on the create_agent, AND set campaign_engagement.service_type = "leasehold" on the ORIGINAL agent via crm_updates. The original keeps getting leasehold outreach; the system stops their rental alerts. Do NOT opt them out.
- RARE (total handoff — "don't contact me at all anymore, contact them instead"): set "replace": true — the system opts the original out of everything.
Rules: only create when there is an explicit number in the message; never invent or guess digits; if a card came without a number, ask them to resend or type it. Always confirm in your reply that the new contact has been added and how you've routed future updates.

For timestamp fields (stage_updated_at, next_followup_at), use these special marker strings — the system will substitute the actual ISO timestamp:
- For "right now" → use the literal string "__NOW__"
- For "3 days from now" → use the literal string "__NOW+3D__"
- For "null / no follow-up needed" → use null

When updating .stage, ALSO set projects.<Name>.stage_updated_at = "__NOW__" so we can audit.`;
