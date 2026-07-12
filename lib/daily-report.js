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

  const [agents, inbound, outbound, updates, usageRow] = await Promise.all([
    q(`agents?select=id,name,agency,unread_count,automation_override,suggested_reply,last_inbound_at,engagement_tier,samba_alerts_opt_out,is_test,campaign_engagement`),
    q(`wa_messages?direction=eq.inbound&timestamp=gte.${since}&select=agent_id,content,timestamp&order=timestamp.desc&limit=200`),
    q(`wa_messages?direction=eq.outbound&timestamp=gte.${since}&select=source,category,template_name,status&limit=2000`),
    q(`maya_updates?created_at=gte.${since}&select=agent_id,field,new_value,reason&order=created_at.desc&limit=100`),
    q(`settings?key=eq.daily_usage&select=value`),
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

  return {
    date: new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Makassar' }),
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

// Maya writes the briefing (≤~850 chars). One Claude call.
async function compose(anthropicKey, s) {
  const system = `You are Maya, listings coordinator at Samba Realty. Write Ikiel's private DAILY MORNING BRIEFING about your agent conversations over the last 24 hours. This is internal (owner only), warm but efficient — like a sharp chief of staff.

STRICT RULES:
- HARD LIMIT 850 characters total. Be tight.
- Structure: one-line headline; 1-2 lines on what happened overnight (name specific agents + what they asked, using the snippets); a "Needs you:" line naming who is waiting and how long; a one-line KPI stat; then "Your move:" with the single most important 1-2 actions.
- A few simple emojis as section markers are fine (this is internal, not an agent message). No markdown headers.
- Never invent agents, questions, or numbers not in the data. If nothing notable happened, say so plainly.`;

  const data = `DATA (last 24h):
Inbound: ${s.inbound_count} messages from ${s.inbound_agents} agents
Outbound: ${s.outbound_count} (${Object.entries(s.outbound_by_source).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})
Read rate (tracked sends): ${s.read_pct != null ? s.read_pct + '%' : 'still filling in'}
Needs attention (${s.needs_total}): ${s.needs_attention.map(n => `${n.name}${n.paused ? ' [paused]' : ''}${n.draft ? ' [draft ready]' : ''}${n.waiting_h != null ? ` ${n.waiting_h}h` : ''}`).join('; ') || 'none'}
New agents: ${s.changes.new_agents.join(', ') || 'none'}
Opt-outs: ${s.changes.opt_outs.join(', ') || 'none'}
Frequency changes: ${s.changes.frequency.join(', ') || 'none'}
Enrolled agents: ${s.enrolled} | tiers: ${Object.entries(s.tiers).map(([k, v]) => `${k} ${v}`).join(', ')}
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
  return (d.content?.[0]?.text || '').trim().slice(0, 1000);
}

// Send the briefing to Ikiel via the owner template.
async function sendBriefing(env, dateStr, briefing) {
  const to = String(env.OWNER_WA_NUM || '').replace(/\D/g, '');
  if (!to) return { sent: false, reason: 'OWNER_WA_NUM not set' };
  const r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: OWNER_TEMPLATE, language: { code: 'en' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: dateStr },
          { type: 'text', text: briefing },
        ] }]
      }
    })
  });
  const d = await r.json();
  if (!r.ok) return { sent: false, reason: d?.error?.message || `HTTP ${r.status}` };
  return { sent: true, messageId: d.messages?.[0]?.id };
}

// Entry point called by the cron. preview:true returns the composed report
// without sending (for the ?report=preview test hook).
export async function buildAndSendOwnerReport(env, { preview = false } = {}) {
  const stats = await gather(env);
  let briefing;
  try { briefing = await compose(env.ANTHROPIC_KEY, stats); }
  catch (e) { return { error: 'compose failed: ' + e.message, stats }; }
  if (preview) return { preview: true, stats, briefing, chars: briefing.length };
  const send = await sendBriefing(env, stats.date, briefing);
  return { stats, briefing, chars: briefing.length, ...send, console_url: CONSOLE_URL };
}
