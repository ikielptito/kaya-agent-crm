// Maya's daily morning report to Ikiel.
//
// Runs from the 9am-WITA cron (api/cron-followups.js). Gathers the last 24h of
// agent activity, has Maya write a short narrative briefing in her voice, and
// delivers it to Ikiel's WhatsApp via the approved UTILITY template
// `samba_owner_briefing_v1` (an automated WhatsApp message outside a 24h window
// must be a template, capped at 1024 chars — so the briefing is concise and the
// deep detail lives in the analytics dashboard).

const GRAPH = 'https://graph.facebook.com/v19.0';
const OWNER_TEMPLATE = 'samba_owner_briefing_v1';
const OWNER_TEMPLATE_V2 = 'samba_owner_briefing_v2';
const CONSOLE_URL = 'https://kaya-agent-crm.vercel.app/chat.html';

function agoHours(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 3.6e6);
}
function todayWitaStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });
}

// Pull everything the report needs from the last `hours` (default 24h).
async function gather(env, hours = 24) {
  const { SUPABASE_URL, headers } = env;
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const q = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers }).then(r => r.json()).catch(() => []);

  // Portal pulse: overnight sessions/enquiries + real Google-account signups
  // from sambarentals.com (sync-secret auth, best-effort — report still sends
  // without it).
  const portalPulse = process.env.LISTING_SYNC_SECRET
    ? fetch('https://sambarentals.com/api/dashboard?portal_pulse=1', {
        headers: { Authorization: 'Bearer ' + process.env.LISTING_SYNC_SECRET },
        signal: AbortSignal.timeout(8000),
      }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);

  const [agents, inbound, outbound, updates, usageRow, portal] = await Promise.all([
    q(`agents?select=id,name,agency,unread_count,automation_override,suggested_reply,last_inbound_at,engagement_tier,samba_alerts_opt_out,is_test,campaign_engagement`),
    q(`wa_messages?direction=eq.inbound&timestamp=gte.${since}&select=agent_id,content,timestamp&order=timestamp.desc&limit=200`),
    q(`wa_messages?direction=eq.outbound&timestamp=gte.${since}&select=source,category,template_name,status&limit=2000`),
    q(`maya_updates?created_at=gte.${since}&select=agent_id,field,new_value,reason&order=created_at.desc&limit=100`),
    q(`settings?key=eq.daily_usage&select=value`),
    portalPulse,
  ]);

  const A = Array.isArray(agents) ? agents : [];
  const nameOf = {}; A.forEach(a => { nameOf[a.id] = a.name || a.agency || `#${a.id}`; });
  const enrolled = A.filter(a => !a.is_test && a.campaign_engagement && a.campaign_engagement.samba);

  // Inbound overnight
  const inb = Array.isArray(inbound) ? inbound : [];
  const inboundAgents = [...new Set(inb.map(m => m.agent_id).filter(Boolean))];
  const snippets = inb.slice(0, 18).map(m => `${nameOf[m.agent_id] || 'Agent'}: ${(m.content || '').replace(/\s+/g, ' ').slice(0, 140)}`);

  // Outbound overnight, by source
  const outb = Array.isArray(outbound) ? outbound : [];
  const bySource = {}; outb.forEach(m => { const s = m.source || 'api'; bySource[s] = (bySource[s] || 0) + 1; });
  const tracked = outb.filter(m => m.status);
  const readPct = tracked.length ? Math.round(tracked.filter(m => m.status === 'read').length / tracked.length * 100) : null;

  // Needs attention: paused (Ikiel handling), unread, or a Maya draft awaiting review.
  const needs = A.filter(a => !a.is_test && (a.unread_count > 0 || a.automation_override === 'paused' || (a.suggested_reply && a.suggested_reply.trim())))
    .map(a => ({
      name: nameOf[a.id], unread: a.unread_count || 0,
      paused: a.automation_override === 'paused',
      draft: !!(a.suggested_reply && a.suggested_reply.trim()),
      waiting_h: agoHours(a.last_inbound_at),
    }))
    .sort((x, y) => (y.waiting_h || 0) - (x.waiting_h || 0));

  // Overnight CRM changes (from the audit log)
  const ups = Array.isArray(updates) ? updates : [];
  const changes = {
    opt_outs: ups.filter(u => u.field === 'samba_alerts_opt_out' && String(u.new_value) === 'true').map(u => nameOf[u.agent_id]),
    new_agents: ups.filter(u => u.field === 'create_agent').map(u => u.new_value),
    frequency: ups.filter(u => u.field === 'contact_frequency').map(u => `${nameOf[u.agent_id]}→${u.new_value}`),
  };

  const usage = usageRow?.[0]?.value || {};
  const spendToday = usage[todayWitaStr(0)] || 0;

  // Tier split for context
  const tiers = {}; enrolled.forEach(a => { const t = a.engagement_tier || 'unset'; tiers[t] = (tiers[t] || 0) + 1; });

  // Portal summary (null when the pulse call failed)
  let portalStats = null;
  if (portal && portal.activity) {
    const f = portal.funnel || {};
    const sum = (...keys) => keys.reduce((s, k) => s + (f[k] || 0), 0);
    portalStats = {
      sessions: portal.activity.sessions || 0,
      engaged_sessions: portal.activity.eng_sessions || 0,
      wa_enquiries: portal.activity.wa_sessions || 0,
      accounts_total: portal.signups?.total || 0,
      new_signups: (portal.signups?.new_24h || []).map(s => s.name),
      signup_prompts_shown: sum('signup_shown_gate', 'signup_shown_auto', 'signup_shown_nav'),
      signups_completed: sum('signup_done_gate', 'signup_done_auto', 'signup_done_nav', 'signup_done_onetap'),
      inapp_blocked: f.signup_inapp_blocked || 0,
      avg_sessions_7d: portal.baseline?.avg_sessions ?? null,
      avg_wa_7d: portal.baseline?.avg_wa_sessions ?? null,
      broadcast_digest: portal.broadcast?.wa_digest || 0,
      broadcast_alerts: portal.broadcast?.wa_alert || 0,
      errors_overnight: portal.errors_overnight || 0,
    };
  }

  return {
    date: new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Makassar' }),
    portal: portalStats,
    inbound_count: inb.length,
    inbound_agents: inboundAgents.length,
    snippets,
    outbound_count: outb.length,
    outbound_by_source: bySource,
    read_pct: readPct,
    needs_attention: needs.slice(0, 8),
    needs_total: needs.length,
    changes,
    enrolled: enrolled.length,
    tiers,
    spend_today_usd: +spendToday.toFixed(2),
  };
}

// Maya writes the briefing as FOUR sections (headline / needs you / stats /
// your move), "|||"-delimited. The v2 template gives each its own line; the
// v1 fallback joins them into the legacy single paragraph. One Claude call.
async function compose(anthropicKey, s) {
  const system = `You are Maya, listings coordinator at Samba Realty. Write Ikiel's private DAILY MORNING BRIEFING about your agent conversations over the last 24 hours. This is internal (owner only), warm but efficient — like a sharp chief of staff.

STRICT RULES:
- Output EXACTLY four sections separated by "|||" (three pipes), in this order: (1) HEADLINE — the overnight story in one or two sentences; (2) NEEDS YOU — who's waiting + how long, or "Nothing waiting on you"; (3) STATS — the numbers that matter today; (4) YOUR MOVE — the 1-2 most important actions.
- Each section is ONE line, max 200 characters, no newlines, no bullets, no markdown, no emoji at the start (the template adds section emoji). Total across all four ≤ 780 characters.
- Name specific agents + what they asked (use the snippets). Never invent agents, questions, or numbers not in the data. If nothing notable happened, say so plainly.
- STATS should lead with portal activity and compare to the 7-day average when it's meaningfully above or below it. If there are NEW SIGNUPS, always name them — a new agent account is headline material and usually worth a welcome touch in YOUR MOVE.
- If the broadcast drove portal activity, connect it ("yesterday's digest drove N portal events"). If portal errors overnight > 0, flag it in NEEDS YOU with the count; if 0, don't mention errors at all.`;

  const data = `DATA (last 24h):
Inbound: ${s.inbound_count} messages from ${s.inbound_agents} agents
Outbound: ${s.outbound_count} (${Object.entries(s.outbound_by_source).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})
Read rate (tracked sends): ${s.read_pct != null ? s.read_pct + '%' : 'still filling in'}
Needs attention (${s.needs_total}): ${s.needs_attention.map(n => `${n.name}${n.paused ? ' [paused]' : ''}${n.draft ? ' [draft ready]' : ''}${n.waiting_h != null ? ` ${n.waiting_h}h` : ''}`).join('; ') || 'none'}
New agents: ${s.changes.new_agents.join(', ') || 'none'}
Opt-outs: ${s.changes.opt_outs.join(', ') || 'none'}
Frequency changes: ${s.changes.frequency.join(', ') || 'none'}
Enrolled agents: ${s.enrolled} | tiers: ${Object.entries(s.tiers).map(([k, v]) => `${k} ${v}`).join(', ')}
Portal (sambarentals.com, overnight): ${s.portal
    ? `${s.portal.sessions} sessions${s.portal.avg_sessions_7d != null ? ` (7-day avg ${s.portal.avg_sessions_7d}/day)` : ''}, ${s.portal.engaged_sessions} engaged, ${s.portal.wa_enquiries} WhatsApp enquiries${s.portal.avg_wa_7d != null ? ` (avg ${s.portal.avg_wa_7d}/day)` : ''}. Agent accounts: ${s.portal.accounts_total} total${s.portal.new_signups.length ? `, NEW SIGNUPS: ${s.portal.new_signups.join(', ')}` : ', no new signups'}. Signup prompts shown ${s.portal.signup_prompts_shown}, completed ${s.portal.signups_completed}${s.portal.inapp_blocked ? `, ${s.portal.inapp_blocked} blocked by in-app browser` : ''}. Broadcast-driven portal events: digest ${s.portal.broadcast_digest}, alerts ${s.portal.broadcast_alerts}. Portal errors overnight: ${s.portal.errors_overnight}.`
    : 'stats unavailable this morning'}
Your Claude spend today: $${s.spend_today_usd}

Recent inbound snippets (newest first):
${s.snippets.join('\n') || '(no inbound overnight)'}

Write the briefing now.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system, messages: [{ role: 'user', content: data }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Claude HTTP ${r.status}`);
  // Template params reject newlines/tabs/runs of spaces — clean each section.
  const clean = t => String(t || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').replace(/^[☀️⚠️📊👉\s]+/u, '');
  const raw = (d.content?.[0]?.text || '').trim();
  let sections = raw.split('|||').map(clean).filter(Boolean);
  if (sections.length > 4) sections = [...sections.slice(0, 3), sections.slice(3).join(' ')];
  if (sections.length !== 4) {
    // Malformed output — degrade to one paragraph in slot 1 so the report
    // still arrives (v1 fallback path flattens identically).
    sections = [clean(raw).slice(0, 780), 'Nothing waiting on you', 'See dashboard for stats', 'Review the console when you can'];
  }
  sections = sections.map(t => t.slice(0, 240));
  // Legacy single-paragraph form for the v1 template fallback.
  const flat = `☀️ ${sections[0]} ⚠️ ${sections[1]} 📊 ${sections[2]} 👉 ${sections[3]}`.slice(0, 1000);
  return { sections, flat };
}

// Send the briefing to Ikiel. Tries the structured v2 template (four
// sections on their own lines + an "Open console" button); if v2 isn't
// approved yet (or Meta rejects the send for any reason) falls back to the
// legacy single-paragraph v1 so the report always arrives.
async function sendBriefing(env, dateStr, { sections, flat }) {
  const to = String(env.OWNER_WA_NUM || '').replace(/\D/g, '');
  if (!to) return { sent: false, reason: 'OWNER_WA_NUM not set' };
  const post = (template) => fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
  }).then(async r => ({ ok: r.ok, d: await r.json().catch(() => ({})) }));

  const v2 = await post({
    name: OWNER_TEMPLATE_V2, language: { code: 'en' },
    components: [
      { type: 'body', parameters: [
        { type: 'text', text: dateStr },
        ...sections.map(t => ({ type: 'text', text: t })),
      ] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'chat.html' }] },
    ],
  });
  if (v2.ok) return { sent: true, template: OWNER_TEMPLATE_V2, messageId: v2.d.messages?.[0]?.id };

  const v1 = await post({
    name: OWNER_TEMPLATE, language: { code: 'en' },
    components: [{ type: 'body', parameters: [
      { type: 'text', text: dateStr },
      { type: 'text', text: flat },
    ] }],
  });
  if (v1.ok) return { sent: true, template: OWNER_TEMPLATE, v2_error: v2.d?.error?.message, messageId: v1.d.messages?.[0]?.id };
  return { sent: false, reason: v1.d?.error?.message || 'both templates failed', v2_error: v2.d?.error?.message };
}

// Entry point called by the cron. preview:true returns the composed report
// without sending (for the ?report=preview test hook).
export async function buildAndSendOwnerReport(env, { preview = false } = {}) {
  const stats = await gather(env);
  let briefing;
  try { briefing = await compose(env.ANTHROPIC_KEY, stats); }
  catch (e) { return { error: 'compose failed: ' + e.message, stats }; }
  const chars = briefing.flat.length;
  if (preview) return { preview: true, stats, sections: briefing.sections, briefing: briefing.flat, chars };
  const send = await sendBriefing(env, stats.date, briefing);
  return { stats, sections: briefing.sections, briefing: briefing.flat, chars, ...send, console_url: CONSOLE_URL };
}
