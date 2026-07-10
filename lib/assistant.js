// Maya Assistant — the boss-facing command console behind the pinned
// "Maya — Assistant" thread in chat.html. Ikiel chats with Maya privately;
// she answers questions about agents/conversations and carries out CRM work
// through a Claude tool-use loop.
//
// Safety model:
// - Anything going to MULTIPLE agents is a two-phase broadcast: the model can
//   only DRAFT it (draft_broadcast). The draft is stored in
//   settings.assistant_pending_broadcast and rendered as a confirmation card
//   in the app. Only the user's explicit confirm calls execute_broadcast,
//   which re-checks 24h windows and sends deterministically (no LLM involved).
// - Single sends (send_message) are allowed directly since the user asked in
//   the same breath, but they enforce the 24h free-text window.
// - The assistant has its own daily spend ledger (settings.assistant_usage)
//   so a long boss chat can never trip the agent-facing Maya's spend cap.

const MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 6;              // tool-use round trips per user message
const ASSISTANT_DAILY_CAP_USD = 1.50;  // separate from Maya's webhook cap
const EST_COST_PER_CALL_USD = 0.04;
const BROADCAST_TTL_MS = 30 * 60 * 1000; // pending draft expires after 30 min
const BROADCAST_MAX_RECIPIENTS = 200;
const GRAPH = 'https://graph.facebook.com/v19.0';
const PORTAL_ORIGIN = 'https://sambarentals.com';   // canonical agent portal (custom domain)

// A rental's public deep link + slug helpers. portal_url in the DB may still
// carry the old vercel.app host, so we always rebuild on the canonical origin.
function slugFromPortalUrl(u) {
  const m = String(u || '').match(/[?&]property=([^&]+)/);
  return m ? m[1] : '';
}
function listingUrl(slug) {
  return slug ? `${PORTAL_ORIGIN}/?property=${slug}` : PORTAL_ORIGIN;
}

// Agent fields the assistant may PATCH. Everything else is off-limits.
const PATCHABLE_FIELDS = ['notes', 'engagement_tier', 'contact_frequency',
  'samba_alerts_opt_out', 'automation_override', 'name', 'agency'];

// ── Tool definitions (Anthropic tool-use schema) ──────────────────────
const TOOLS = [
  {
    name: 'list_agents',
    description: 'List agents in the CRM with their key fields (name, agency, WhatsApp number, samba_enrolled, opted_out, contact_frequency, engagement_tier, last_inbound_at, unread_count, notes). Use this to find agents, build broadcast audiences, or see who needs attention. Test agents are excluded unless include_test is true.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive match on name or agency' },
        enrolled_samba_only: { type: 'boolean', description: 'Only agents enrolled in the Samba availability campaign' },
        include_opted_out: { type: 'boolean', description: 'Include agents who opted out of broadcasts (default false when enrolled_samba_only is set)' },
        include_test: { type: 'boolean' },
        limit: { type: 'number', description: 'Max rows (default 150)' }
      }
    }
  },
  {
    name: 'agent_activity',
    description: 'Per-agent message activity over the last N days: inbound count (how much they write to us), outbound count, last inbound / last outbound timestamps. Use for "most active/responsive agents" questions. Sorted by inbound count descending.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Lookback window in days (default 30)' } }
    }
  },
  {
    name: 'get_thread',
    description: 'Fetch the recent WhatsApp conversation with one agent (both directions, oldest to newest).',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'number' },
        limit: { type: 'number', description: 'Max messages (default 25)' }
      },
      required: ['agent_id']
    }
  },
  {
    name: 'search_messages',
    description: 'Full-text search across all WhatsApp messages. agents_matched is computed over the FULL history (scans up to 5000 matching rows), so it is safe to diff against list_agents for "who have we not told about X yet" — even when the message sample is truncated. Set exclude_digests=true to ignore the automated availability digests/alerts (they mention every villa, so a digest mention is weak signal that an agent actually "heard about" something).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to search for, e.g. "Saturno"' },
        direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Optional filter' },
        days: { type: 'number', description: 'Lookback in days (default 365)' },
        exclude_digests: { type: 'boolean', description: 'Skip automated availability_intro/alert/digest sends — count only direct mentions (manual, Maya replies, assistant broadcasts)' },
        limit: { type: 'number', description: 'Max sample messages returned for reading (default 40; agents_matched is always complete regardless)' }
      },
      required: ['text']
    }
  },
  {
    name: 'get_rentals',
    description: 'The live Samba Realty rental portfolio: name, area, type, beds, monthly rate IDR, photos/maps links, notes. ALWAYS fetch this before writing any message that mentions a rental villa so facts are exact.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_projects',
    description: 'The live KAYA Developments sales portfolio (projects, units, pricing, commission). Fetch before mentioning any sales project.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_agent',
    description: 'Update fields on an agent record. Allowed fields: notes, engagement_tier (hot/warm/cold), contact_frequency (normal/weekly/monthly/paused), samba_alerts_opt_out (boolean), automation_override (null/off/draft/hybrid/autopilot/paused), name, agency. Logged to the audit trail.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'number' },
        fields: { type: 'object', description: 'Only the allowed fields listed above' },
        reason: { type: 'string', description: 'Why — goes in the audit log' }
      },
      required: ['agent_id', 'fields', 'reason']
    }
  },
  {
    name: 'create_agent',
    description: 'Add a new agent to the CRM. Deduplicates by WhatsApp number.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        wa_num: { type: 'string', description: 'Digits only incl. country code, e.g. 6281234567890' },
        agency: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['name', 'wa_num']
    }
  },
  {
    name: 'set_maya_mode',
    description: "Change Maya's GLOBAL automation mode for agent conversations: off, draft, hybrid, or autopilot.",
    input_schema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['off', 'draft', 'hybrid', 'autopilot'] } },
      required: ['mode']
    }
  },
  {
    name: 'send_message',
    description: 'Send ONE free-form WhatsApp text to ONE agent right now. Fails if the agent is outside the 24h reply window (WhatsApp rule). For multiple agents use draft_broadcast instead — never loop this tool over a list.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'number' },
        text: { type: 'string', description: "The message, in Maya's outbound voice" }
      },
      required: ['agent_id', 'text']
    }
  },
  {
    name: 'list_templates',
    description: 'List the Meta-APPROVED WhatsApp templates with their body text and placeholder counts. Templates deliver even OUTSIDE the 24h window — they are the only way to reach cold/inactive agents in bulk. Check this before drafting a template broadcast.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'draft_broadcast',
    description: 'Prepare (NOT send) a broadcast to multiple agents. The user must confirm in the app before anything is sent — after calling this, tell them the draft is ready and awaiting their confirmation. Calling it again replaces the previous draft. TWO MODES: (1) free-text via `message` — only delivers to agents inside the 24h window, others are skipped; (2) approved template via `template_name` + `template_params` — delivers to EVERYONE regardless of window. Use template mode whenever a meaningful part of the audience is out of window. In template_params, the literal token {name} is replaced with each recipient’s first name at send time.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Free-text mode: exact text every recipient gets (no merge fields). Omit when using template mode. Always end with the specific listing link (get it from get_rentals listing_url) and you may reference sambarentals.com generally.' },
        template_name: { type: 'string', description: 'Template mode: name of an APPROVED template from list_templates' },
        template_params: { type: 'array', items: { type: 'string' }, description: 'Template mode: one value per {{n}} placeholder, in order. Use the token {name} for the recipient’s first name.' },
        listing_slug: { type: 'string', description: 'Template mode: required when the template has a url_button — the villa slug for the "View listing" button (from get_rentals slug, e.g. "villa-saturno").' },
        agent_ids: { type: 'array', items: { type: 'number' }, description: 'Recipient agent ids (build the list with list_agents / search_messages first)' },
        label: { type: 'string', description: 'Short label, e.g. "Villa Saturno price drop"' }
      },
      required: ['agent_ids', 'label']
    }
  }
];

// ── Template helpers ──────────────────────────────────────────────────
async function getWabaId(env) {
  if (process.env.META_WABA_ID) return process.env.META_WABA_ID;
  const r = await fetch(`${GRAPH}/${env.PHONE_ID}?fields=whatsapp_business_account`, {
    headers: { 'Authorization': 'Bearer ' + env.TOKEN }
  });
  const d = await r.json();
  return d.whatsapp_business_account?.id || null;
}

async function fetchApprovedTemplates(env) {
  const wabaId = await getWabaId(env);
  if (!wabaId) return null;
  const r = await fetch(`${GRAPH}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`, {
    headers: { 'Authorization': 'Bearer ' + env.TOKEN }
  });
  const d = await r.json();
  if (!Array.isArray(d.data)) return null;
  return d.data.filter(t => t.status === 'APPROVED').map(t => {
    const body = ((t.components || []).find(c => c.type === 'BODY') || {}).text || '';
    // A dynamic URL button ({{1}} in the url) means this template links to a
    // specific listing — the send must supply that slug.
    const btnComp = (t.components || []).find(c => c.type === 'BUTTONS');
    const urlBtn = (btnComp?.buttons || []).find(b => b.type === 'URL' && /\{\{\d+\}\}/.test(b.url || ''));
    return {
      name: t.name, language: t.language, category: t.category, body,
      placeholderCount: (body.match(/\{\{(\d+)\}\}/g) || []).length,
      url_button: urlBtn ? { text: urlBtn.text, base: (urlBtn.url || '').replace(/\{\{\d+\}\}/, '') } : null
    };
  });
}

function firstName(name) {
  const w = String(name || '').trim().split(/\s+/)[0];
  return w || 'there';
}

// Substitute {{1}}..{{n}} with params; the {name} token is per-recipient.
function renderTemplateBody(body, params, recipientName) {
  const vals = (params || []).map(p => String(p).replaceAll('{name}', firstName(recipientName)));
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => vals[Number(n) - 1] ?? `{{${n}}}`);
}

async function sendWaTemplate(env, rec, tpl) {
  const vals = (tpl.params || []).map(p => String(p).replaceAll('{name}', firstName(rec.name)));
  const components = [];
  if (vals.length) components.push({ type: 'body', parameters: vals.map(v => ({ type: 'text', text: v })) });
  // Dynamic URL button: the slug fills {{1}} in the button's url (same villa
  // for the whole broadcast, so not per-recipient).
  if (tpl.buttonSlug) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tpl.buttonSlug }] });
  }
  const r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: rec.wa_num, type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.language || 'en' },
        components
      }
    })
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
  const waMessageId = data.messages?.[0]?.id;
  if (waMessageId) {
    await fetch(env.SUPABASE_URL + '/rest/v1/wa_messages', {
      method: 'POST', headers: env.headers,
      body: JSON.stringify({
        agent_id: rec.id, wa_num: rec.wa_num, direction: 'outbound',
        content: renderTemplateBody(tpl.body, tpl.params, rec.name),
        wa_message_id: waMessageId, timestamp: new Date().toISOString(),
        source: 'api', category: 'broadcast', status: 'sent'
      })
    }).catch(e => console.warn('broadcast log failed:', e.message));
  }
  return { ok: true, waMessageId };
}

// ── System prompt ─────────────────────────────────────────────────────
function buildSystemPrompt() {
  const wita = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Makassar', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `You are Maya, the listings coordinator at KAYA Developments and Samba Realty in Bali — but this is NOT an agent conversation. You are talking PRIVATELY with Ikiel, your boss, in the command console of the agent CRM. Agents never see this thread.

WHAT YOU DO HERE:
1. Answer his questions about agents, conversations, and outreach using your tools. Never guess or invent data — if a tool result is empty or unclear, say so plainly.
2. Do CRM work he asks for: update notes / engagement tiers / contact frequency, add agents, opt agents in/out, change your own automation mode.
3. Compose and send WhatsApp messages to agents on his behalf. ONE agent → send_message. MORE THAN ONE agent → draft_broadcast only; he confirms in the app before anything goes out. Never loop send_message over a list.

CONSOLE STYLE: concise and direct, like a sharp chief of staff reporting to the founder. Lead with the answer, then supporting numbers. Use **bold** for key names and figures. Short "- " lists are fine; no markdown headers or tables. Rental rates are monthly IDR — write them like 40jt/mo.

WHEN WRITING TEXT THAT AGENTS WILL RECEIVE (send_message text or draft_broadcast message), switch to your outbound voice:
- 1-4 short sentences, warm-professional, specific over vague.
- NO emojis. No em dashes (use -- if needed). Never the word "guaranteed".
- Never invent prices, availability, or property facts — call get_rentals / get_projects first and quote exact figures from the result.
- STANDARD FOR EVERY MESSAGE: when it is about a specific villa, include that villa's own listing link (get_rentals returns listing_url, e.g. https://sambarentals.com/?property=villa-saturno), and close with a light reference to the portal https://sambarentals.com. In template mode the "View listing" button carries the specific link, so the body just needs the general sambarentals.com sign-off.
- Broadcast copy is sent verbatim to everyone — no {{name}} merge fields in free-text, so write it to work without a name.

BROADCAST RULES:
- Default audience for Samba rental announcements: agents from list_agents with enrolled_samba_only=true (that filter already drops opted-out, paused-frequency, numberless and test agents). Narrow further only if Ikiel asks.
- TWO DELIVERY MODES. Free-text ("message") only reaches agents inside the 24h window since their last inbound; everyone else is skipped. Template mode ("template_name" + "template_params") uses a Meta-approved template and reaches EVERYONE. Check the in-window split from draft_broadcast: if a meaningful share of the audience is out of window (or the audience is cold), use a template — check list_templates first. Strategic templates (each: {{1}}=recipient first name via the {name} token, {{2}}=villa, {{3}}=area, {{4}}=one detail line):
  - samba_new_listing_v2 — announce a villa just added to the portfolio
  - samba_price_update_v2 — price drop / rate change ({{4}} like "now 38jt/month, down from 40jt/month")
  - samba_villa_spotlight_v2 — promote/push a specific villa
  Each of these has a "View listing" button — always pass listing_slug.
  A template reply from an agent opens their 24h window, and normal Maya automation handles the conversation from there.
  When a template has a "View listing" button (url_button in list_templates), you MUST pass listing_slug — get the villa's slug from get_rentals (e.g. "villa-saturno") so the button links straight to that listing.
- NEVER present a draft as sent. After draft_broadcast, say it's ready and he must tap the confirm button in the card below your message.
- Price drop / new villa / promotion requests: fetch the villa's live data first and reference real details (name, area, rate, beds).

ANSWER PATTERNS:
- "Most active/responsive agents" → agent_activity (inbound counts + recency), name the top ones with numbers.
- "Who haven't we told about X yet" → search_messages (text=X, direction=outbound, exclude_digests=true) for who got a DIRECT mention, list_agents (enrolled_samba_only) for the audience, then list the difference by name. agents_matched is complete (not capped), so the diff is trustworthy. The automated weekly digests mention every villa — if the digest cut matters, run a second search without exclude_digests and report both numbers ("X got a direct mention, Y only saw it in a digest, Z never heard of it").
- "Who needs my attention" → list_agents and look at unread_count and last_inbound_at; also conversations whose last message is inbound.
- "What did <agent> say about X" → get_thread or search_messages.

If something is outside your tools (deleting data, sending documents/images, messaging outside the 24h window without a template), say what you can't do and suggest the manual path in the app. Current date/time: ${wita} (WITA, Bali).`;
}

// ── Small helpers ─────────────────────────────────────────────────────
function todayWita() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' }); // YYYY-MM-DD
}

async function getSetting(url, headers, key) {
  const r = await fetch(`${url}/rest/v1/settings?key=eq.${key}&select=value`, { headers });
  const row = (await r.json())?.[0];
  return row ? row.value : null;
}

async function setSetting(url, headers, key, value) {
  await fetch(`${url}/rest/v1/settings`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value })
  });
}

async function getAssistantSpendToday(url, headers) {
  try {
    const usage = (await getSetting(url, headers, 'assistant_usage')) || {};
    return usage[todayWita()] || 0;
  } catch (_) { return 0; }
}

async function incrementAssistantSpend(url, headers, usd) {
  try {
    const usage = (await getSetting(url, headers, 'assistant_usage')) || {};
    const today = todayWita();
    usage[today] = (usage[today] || 0) + usd;
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    Object.keys(usage).forEach(k => { if (k < cutoff) delete usage[k]; });
    await setSetting(url, headers, 'assistant_usage', usage);
  } catch (e) { console.warn('assistant spend log failed:', e.message); }
}

async function callClaude(key, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Claude HTTP ${r.status}`);
  return data;
}

// PostgREST ilike patterns: strip characters that break the filter syntax.
function ilikeSafe(s) {
  return String(s).replace(/[%,()"\\*]/g, ' ').trim();
}

function agentWaNum(a) {
  if (a.wa_num) return String(a.wa_num).replace(/\D/g, '');
  if (a.wa_url && a.wa_url.startsWith('https://wa.me/')) return a.wa_url.replace('https://wa.me/', '').replace(/\D/g, '');
  return '';
}

// Latest inbound timestamp per agent for a set of ids → { id: ms }.
async function lastInboundByAgent(url, headers, ids) {
  if (!ids.length) return {};
  const out = {};
  const r = await fetch(`${url}/rest/v1/wa_messages?agent_id=in.(${ids.join(',')})&direction=eq.inbound&select=agent_id,timestamp&order=timestamp.desc&limit=3000`, { headers });
  const rows = await r.json();
  if (Array.isArray(rows)) rows.forEach(m => {
    const t = new Date(m.timestamp).getTime();
    if (!out[m.agent_id] || t > out[m.agent_id]) out[m.agent_id] = t;
  });
  return out;
}

const IN_WINDOW_MS = 24 * 3600 * 1000;

// Raw Meta Graph text send + wa_messages log. category tags broadcast rows.
async function sendWaText(env, agent, text, category) {
  const waNum = agentWaNum(agent);
  if (!waNum) return { ok: false, error: 'no WhatsApp number' };
  const r = await fetch(`${GRAPH}/${env.PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: waNum, type: 'text', text: { body: text } })
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
  const waMessageId = data.messages?.[0]?.id;
  if (waMessageId) {
    await fetch(env.SUPABASE_URL + '/rest/v1/wa_messages', {
      method: 'POST', headers: env.headers,
      body: JSON.stringify({
        agent_id: agent.id, wa_num: waNum, direction: 'outbound', content: text,
        wa_message_id: waMessageId, timestamp: new Date().toISOString(),
        source: 'api', category: category || null, status: 'sent'
      })
    }).catch(e => console.warn('broadcast log failed:', e.message));
  }
  return { ok: true, waMessageId };
}

async function logAudit(url, headers, agentId, field, newValue, reason) {
  await fetch(`${url}/rest/v1/maya_updates`, {
    method: 'POST', headers,
    body: JSON.stringify({
      agent_id: agentId, field, new_value: String(newValue).slice(0, 500),
      reason: (reason || '').slice(0, 300), evidence: 'assistant console', by_maya: true
    })
  }).catch(e => console.warn('maya_updates log failed:', e.message));
}

// ── Tool executor ─────────────────────────────────────────────────────
// ctx: { url, headers, env, activity: [], pendingBroadcast: null }
async function runTool(name, input, ctx) {
  const { url, headers } = ctx;

  if (name === 'list_agents') {
    const limit = Math.min(input.limit || 150, 300);
    let q = `${url}/rest/v1/agents?select=id,name,agency,wa_num,wa_url,engagement_tier,contact_frequency,samba_alerts_opt_out,automation_override,last_inbound_at,unread_count,is_test,campaign_engagement,notes&order=id&limit=${limit}`;
    if (input.search) {
      const s = ilikeSafe(input.search);
      q += `&or=(name.ilike.*${encodeURIComponent(s)}*,agency.ilike.*${encodeURIComponent(s)}*)`;
    }
    const rows = await (await fetch(q, { headers })).json();
    if (!Array.isArray(rows)) return { error: 'agents query failed' };
    let agents = rows.filter(a => input.include_test ? true : !a.is_test);
    if (input.enrolled_samba_only) {
      agents = agents.filter(a =>
        agentWaNum(a) &&
        a.campaign_engagement && a.campaign_engagement.samba &&
        (input.include_opted_out || !a.samba_alerts_opt_out) &&
        a.contact_frequency !== 'paused'
      );
    }
    ctx.activity.push(`Looked up agents${input.search ? ` matching "${input.search}"` : ''}${input.enrolled_samba_only ? ' (Samba audience)' : ''}`);
    return {
      count: agents.length,
      agents: agents.map(a => ({
        id: a.id, name: a.name || null, agency: a.agency || null,
        wa_num: agentWaNum(a) || null,
        samba_enrolled: !!(a.campaign_engagement && a.campaign_engagement.samba),
        opted_out: !!a.samba_alerts_opt_out,
        contact_frequency: a.contact_frequency || 'normal',
        engagement_tier: a.engagement_tier || null,
        maya_mode_override: a.automation_override || null,
        last_inbound_at: a.last_inbound_at || null,
        unread_count: a.unread_count || 0,
        notes: a.notes ? String(a.notes).slice(0, 200) : null
      }))
    };
  }

  if (name === 'agent_activity') {
    const days = Math.min(Math.max(input.days || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [msgRows, agRows] = await Promise.all([
      // order desc: Supabase caps responses at ~1000 rows, so if the window has
      // more traffic than that we still count the newest messages first.
      (await fetch(`${url}/rest/v1/wa_messages?timestamp=gte.${since}&select=agent_id,direction,timestamp&order=timestamp.desc&limit=10000`, { headers })).json(),
      (await fetch(`${url}/rest/v1/agents?select=id,name,agency,is_test`, { headers })).json()
    ]);
    if (!Array.isArray(msgRows) || !Array.isArray(agRows)) return { error: 'activity query failed' };
    const names = {}; const isTest = {};
    agRows.forEach(a => { names[a.id] = a.name || a.agency || ('#' + a.id); isTest[a.id] = !!a.is_test; });
    const stats = {};
    msgRows.forEach(m => {
      if (m.agent_id == null || isTest[m.agent_id]) return;
      const s = stats[m.agent_id] || (stats[m.agent_id] = { inbound: 0, outbound: 0, last_inbound: null, last_outbound: null });
      if (m.direction === 'inbound') {
        s.inbound++;
        if (!s.last_inbound || m.timestamp > s.last_inbound) s.last_inbound = m.timestamp;
      } else {
        s.outbound++;
        if (!s.last_outbound || m.timestamp > s.last_outbound) s.last_outbound = m.timestamp;
      }
    });
    const list = Object.entries(stats)
      .map(([id, s]) => ({ agent_id: Number(id), name: names[id] || ('#' + id), ...s }))
      .sort((a, b) => b.inbound - a.inbound)
      .slice(0, 50);
    ctx.activity.push(`Computed agent activity over ${days} days`);
    return { days, agents_with_activity: list.length, stats: list };
  }

  if (name === 'get_thread') {
    const limit = Math.min(input.limit || 25, 60);
    const rows = await (await fetch(`${url}/rest/v1/wa_messages?agent_id=eq.${Number(input.agent_id)}&order=timestamp.desc&limit=${limit}&select=direction,content,timestamp,source,category`, { headers })).json();
    if (!Array.isArray(rows)) return { error: 'thread query failed' };
    ctx.activity.push(`Read the conversation with agent #${input.agent_id}`);
    return {
      agent_id: input.agent_id,
      messages: rows.slice().reverse().map(m => ({
        at: m.timestamp,
        who: m.direction === 'inbound' ? 'agent' : (m.source === 'manual' ? 'ikiel' : m.source === 'cron' ? 'broadcast' : 'maya'),
        text: (m.content || '').slice(0, 300)
      }))
    };
  }

  if (name === 'search_messages') {
    const days = Math.min(Math.max(input.days || 365, 1), 730);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const sampleLimit = Math.min(input.limit || 40, 100);
    const pat = encodeURIComponent('*' + ilikeSafe(input.text) + '*');
    let filters = `content=ilike.${pat}&timestamp=gte.${since}`;
    if (input.direction) filters += `&direction=eq.${input.direction}`;
    if (input.exclude_digests) {
      // NULL categories (legacy + normal chat) must survive a not.in filter.
      filters += `&or=(category.is.null,category.not.in.(availability_intro,availability_alert,availability_digest))`;
    }

    // Pass 1 — the complete agent set. Supabase caps a response at ~1000 rows,
    // so page an id-only scan (cheap) instead of trusting one capped query.
    // This is what makes "who have we NOT told about X" diffs trustworthy.
    const idSet = new Set();
    let scanned = 0, truncated = false;
    for (let page = 0; page < 5; page++) {
      const rows = await (await fetch(`${url}/rest/v1/wa_messages?${filters}&select=agent_id&order=timestamp.desc&limit=1000&offset=${page * 1000}`, { headers })).json();
      if (!Array.isArray(rows)) return { error: 'search failed' };
      rows.forEach(m => { if (m.agent_id != null) idSet.add(m.agent_id); });
      scanned += rows.length;
      if (rows.length < 1000) break;
      if (page === 4) truncated = true;
    }

    // Pass 2 — a readable sample of the newest matches.
    const sample = await (await fetch(`${url}/rest/v1/wa_messages?${filters}&select=agent_id,direction,content,timestamp,category&order=timestamp.desc&limit=${sampleLimit}`, { headers })).json();
    if (!Array.isArray(sample)) return { error: 'search failed' };

    const ids = [...idSet];
    let names = {};
    if (ids.length) {
      const ag = await (await fetch(`${url}/rest/v1/agents?id=in.(${ids.join(',')})&select=id,name,agency`, { headers })).json();
      if (Array.isArray(ag)) ag.forEach(a => { names[a.id] = a.name || a.agency || ('#' + a.id); });
    }
    ctx.activity.push(`Searched messages for "${input.text}"${input.exclude_digests ? ' (direct mentions only)' : ''}`);
    return {
      total_matching_messages: scanned + (truncated ? ' (scan stopped at 5000 — agents_matched may be missing very old matches)' : ''),
      agents_matched_is_complete: !truncated,
      agents_matched: ids.map(id => ({ id, name: names[id] || ('#' + id) })),
      sample_newest_matches: sample.map(m => ({
        agent_id: m.agent_id, agent: names[m.agent_id] || null,
        direction: m.direction, at: m.timestamp, category: m.category || null,
        text: (m.content || '').slice(0, 200)
      }))
    };
  }

  if (name === 'get_rentals') {
    const rows = await (await fetch(`${url}/rest/v1/rentals?select=*&active=eq.true&order=display_order.asc`, { headers })).json();
    ctx.activity.push('Pulled the Samba rental portfolio');
    if (!Array.isArray(rows)) return { error: 'rentals query failed' };
    return {
      rentals: rows.map(r => ({
        // Use the slug from portal_url (hyphenated, the portal's real deep-link
        // key) — the `slug` column uses underscores and does NOT deep-link.
        id: r.id, name: r.name, slug: slugFromPortalUrl(r.portal_url) || r.slug,
        listing_url: listingUrl(slugFromPortalUrl(r.portal_url) || r.slug),
        area: r.area, type: r.property_type, beds: r.beds,
        baths: r.baths, max_guests: r.max_guests,
        monthly_rate_idr: r.monthly_rate_idr, yearly_rate_idr: r.yearly_rate_idr,
        min_stay_nights: r.min_stay_nights, photos_url: r.photos_url, maps_url: r.maps_url,
        notes: r.maya_notes ? String(r.maya_notes).slice(0, 200) : null
      }))
    };
  }

  if (name === 'get_projects') {
    const rows = await (await fetch(`${url}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers })).json();
    ctx.activity.push('Pulled the KAYA sales portfolio');
    if (!Array.isArray(rows)) return { error: 'projects query failed' };
    return {
      projects: rows.map(p => ({
        id: p.id, name: p.name, area: p.area, status: p.status, tagline: p.tagline,
        commission_pct: p.commission_pct, delivery: p.delivery_date,
        units: (p.units || []).map(u => ({ name: u.name || u.unit || null, price: u.price || null, availability: u.availability || 'Available' }))
      }))
    };
  }

  if (name === 'update_agent') {
    const id = Number(input.agent_id);
    const fields = {};
    for (const k of Object.keys(input.fields || {})) {
      if (PATCHABLE_FIELDS.includes(k)) fields[k] = input.fields[k];
    }
    if (!id || !Object.keys(fields).length) return { error: 'agent_id and at least one allowed field required' };
    const r = await fetch(`${url}/rest/v1/agents?id=eq.${id}`, {
      method: 'PATCH', headers, body: JSON.stringify(fields)
    });
    if (!r.ok) return { error: 'update failed: ' + (await r.text()).slice(0, 200) };
    await logAudit(url, headers, id, Object.keys(fields).join(','), JSON.stringify(fields), input.reason);
    ctx.activity.push(`Updated agent #${id} (${Object.keys(fields).join(', ')})`);
    return { success: true, agent_id: id, updated: fields };
  }

  if (name === 'create_agent') {
    const wa = String(input.wa_num || '').replace(/\D/g, '');
    if (!wa || wa.length < 9) return { error: 'valid wa_num required (digits incl. country code)' };
    const dup = await (await fetch(`${url}/rest/v1/agents?wa_num=eq.${wa}&select=id,name`, { headers })).json();
    if (Array.isArray(dup) && dup.length) return { error: `already exists: #${dup[0].id} ${dup[0].name || ''}`.trim(), existing_agent_id: dup[0].id };
    const r = await fetch(`${url}/rest/v1/agents`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: input.name, wa_num: wa, agency: input.agency || null, notes: input.notes || 'Added via Maya assistant console' })
    });
    if (!r.ok) return { error: 'insert failed: ' + (await r.text()).slice(0, 200) };
    const row = (await r.json())?.[0];
    if (row?.id) await logAudit(url, headers, row.id, 'create_agent', `${input.name} ${wa}`, 'created from assistant console');
    ctx.activity.push(`Added agent ${input.name}`);
    return { success: true, agent_id: row?.id || null };
  }

  if (name === 'set_maya_mode') {
    await setSetting(url, headers, 'automation', { mode: input.mode });
    ctx.activity.push(`Set Maya's global mode to ${input.mode}`);
    return { success: true, mode: input.mode };
  }

  if (name === 'send_message') {
    const id = Number(input.agent_id);
    const text = (input.text || '').trim();
    if (!id || !text) return { error: 'agent_id and text required' };
    const agent = (await (await fetch(`${url}/rest/v1/agents?id=eq.${id}&select=id,name,agency,wa_num,wa_url`, { headers })).json())?.[0];
    if (!agent) return { error: 'agent not found' };
    const last = await lastInboundByAgent(url, headers, [id]);
    if (!last[id] || (Date.now() - last[id]) > IN_WINDOW_MS) {
      return { error: 'outside_24h_window', detail: `${agent.name || 'This agent'} last wrote ${last[id] ? new Date(last[id]).toISOString() : 'never'} — WhatsApp will not deliver free-form text. Suggest Ikiel opens the chat and uses an approved template instead.` };
    }
    const sent = await sendWaText(ctx.env, agent, text, null);
    if (!sent.ok) return { error: 'send failed: ' + sent.error };
    ctx.activity.push(`Sent WhatsApp to ${agent.name || '#' + id}`);
    return { success: true, agent: agent.name || null, sent_text: text };
  }

  if (name === 'list_templates') {
    const tpls = await fetchApprovedTemplates(ctx.env);
    if (!tpls) return { error: 'could not fetch templates from Meta' };
    ctx.activity.push('Checked the approved WhatsApp templates');
    return {
      note: 'Templates deliver outside the 24h window. In template_params, use the token {name} where the recipient’s first name belongs.',
      templates: tpls.map(t => ({ name: t.name, language: t.language, placeholders: t.placeholderCount, body: t.body }))
    };
  }

  if (name === 'draft_broadcast') {
    const message = (input.message || '').trim();
    const ids = [...new Set((input.agent_ids || []).map(Number).filter(Boolean))].slice(0, BROADCAST_MAX_RECIPIENTS);
    if (!ids.length) return { error: 'agent_ids required' };

    // Template mode — validate against Meta's approved list first.
    let template = null;
    if (input.template_name) {
      const tpls = await fetchApprovedTemplates(ctx.env);
      if (!tpls) return { error: 'could not fetch templates from Meta' };
      const t = tpls.find(x => x.name === input.template_name);
      if (!t) return { error: `template "${input.template_name}" is not in the APPROVED list`, approved_templates: tpls.map(x => x.name) };
      const params = Array.isArray(input.template_params) ? input.template_params.map(String) : [];
      if (params.length !== t.placeholderCount) {
        return { error: `template "${t.name}" needs exactly ${t.placeholderCount} params, got ${params.length}`, body: t.body };
      }
      let buttonSlug = null;
      if (t.url_button) {
        buttonSlug = String(input.listing_slug || '').trim().replace(/^.*property=/, '');
        if (!buttonSlug || !/^[a-z0-9-]+$/i.test(buttonSlug)) {
          return { error: `template "${t.name}" has a "View listing" button — pass listing_slug (a villa slug like "villa-saturno", from get_rentals).` };
        }
      }
      template = { name: t.name, language: t.language, body: t.body, params, buttonSlug,
        buttonBase: t.url_button ? t.url_button.base : null, buttonText: t.url_button ? t.url_button.text : null };
    }
    if (!template && !message) return { error: 'either message (free-text) or template_name + template_params required' };
    const agents = await (await fetch(`${url}/rest/v1/agents?id=in.(${ids.join(',')})&select=id,name,agency,wa_num,wa_url,samba_alerts_opt_out,contact_frequency,is_test`, { headers })).json();
    if (!Array.isArray(agents)) return { error: 'agents lookup failed' };
    const excluded = [];
    const eligible = agents.filter(a => {
      if (!agentWaNum(a)) { excluded.push({ id: a.id, name: a.name || a.agency, reason: 'no WhatsApp number' }); return false; }
      if (a.samba_alerts_opt_out) { excluded.push({ id: a.id, name: a.name || a.agency, reason: 'opted out' }); return false; }
      if (a.contact_frequency === 'paused') { excluded.push({ id: a.id, name: a.name || a.agency, reason: 'contact frequency paused' }); return false; }
      return true;
    });
    const lastIn = await lastInboundByAgent(url, headers, eligible.map(a => a.id));
    const recipients = eligible.map(a => ({
      id: a.id, name: a.name || a.agency || ('#' + a.id), wa_num: agentWaNum(a),
      in_window: !!(lastIn[a.id] && (Date.now() - lastIn[a.id]) <= IN_WINDOW_MS)
    }));
    // Template mode delivers to everyone; free-text only to in-window agents.
    const inW = recipients.filter(r => r.in_window).length;
    const deliverable = template ? recipients.length : inW;
    const preview = template
      ? renderTemplateBody(template.body, template.params, '{name}').replaceAll('{name}', '[first name]')
      : message;
    const draft = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      label: (input.label || 'Broadcast').slice(0, 80),
      message: preview,
      template,
      recipients,
      excluded,
      created_at: new Date().toISOString()
    };
    await setSetting(url, headers, 'assistant_pending_broadcast', draft);
    ctx.pendingBroadcast = {
      draft_id: draft.id, label: draft.label, message: preview,
      template: template ? {
        name: template.name,
        button: template.buttonBase ? { text: template.buttonText || 'View listing', url: template.buttonBase + template.buttonSlug } : null
      } : null,
      deliverable,
      recipients, excluded
    };
    ctx.activity.push(`Drafted ${template ? 'template' : 'free-text'} broadcast "${draft.label}" (${deliverable} deliverable)`);
    return {
      draft_id: draft.id,
      mode: template ? `template (${template.name}) — delivers to ALL recipients regardless of 24h window` : 'free-text — only in-window agents receive it',
      status: 'DRAFT ONLY — nothing sent. The user sees a confirmation card and must tap Send.',
      recipients_total: recipients.length,
      deliverable_at_send: deliverable,
      in_window_now: inW,
      ...(template ? {} : { out_of_window_skipped_at_send: recipients.length - inW }),
      excluded
    };
  }

  return { error: 'unknown tool: ' + name };
}

// ── Main handler: the tool-use loop ───────────────────────────────────
export async function handleAssistant(req, res, { SUPABASE_URL, headers }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const raw = Array.isArray(req.body?.payload?.messages) ? req.body.payload.messages : [];
  // Normalize: strings only, cap sizes, merge consecutive same-role turns
  // (Anthropic requires strict user/assistant alternation), drop leading
  // assistant turns.
  const msgs = [];
  for (const m of raw.slice(-30)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content || '').slice(0, 4000);
    if (!content) continue;
    if (msgs.length && msgs[msgs.length - 1].role === m.role) {
      msgs[msgs.length - 1].content += '\n\n' + content;
    } else {
      msgs.push({ role: m.role, content });
    }
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return res.status(400).json({ error: 'messages required' });

  const spend = await getAssistantSpendToday(SUPABASE_URL, headers);
  if (spend >= ASSISTANT_DAILY_CAP_USD) {
    return res.status(200).json({
      reply: `I've hit my daily budget cap for the console ($${ASSISTANT_DAILY_CAP_USD.toFixed(2)}). I'll be back tomorrow -- for anything urgent, use the chat threads directly.`,
      activity: []
    });
  }

  const ctx = { url: SUPABASE_URL, headers, env: {
    SUPABASE_URL, headers,
    TOKEN: process.env.META_WA_TOKEN, PHONE_ID: process.env.META_WA_PHONE_ID
  }, activity: [], pendingBroadcast: null };

  const system = buildSystemPrompt();
  let llmCalls = 0;
  let finalText = '';

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const resp = await callClaude(ANTHROPIC_KEY, {
        model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages: msgs
      });
      llmCalls++;

      const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
      const texts = (resp.content || []).filter(b => b.type === 'text').map(b => b.text);

      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        finalText = texts.join('\n').trim();
        break;
      }

      // Execute each requested tool, feed results back.
      msgs.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try { result = await runTool(tu.name, tu.input || {}, ctx); }
        catch (e) { result = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 12000) });
      }
      msgs.push({ role: 'user', content: results });

      if (i === MAX_ITERATIONS - 1) {
        finalText = (texts.join('\n').trim() || 'I ran out of steps mid-task -- here is where I got to:') +
          '\n\n(Stopped after ' + MAX_ITERATIONS + ' tool rounds. Ask me to continue if needed.)';
      }
    }
  } catch (e) {
    await incrementAssistantSpend(SUPABASE_URL, headers, EST_COST_PER_CALL_USD * llmCalls);
    return res.status(500).json({ error: 'Assistant failed: ' + e.message });
  }

  await incrementAssistantSpend(SUPABASE_URL, headers, EST_COST_PER_CALL_USD * llmCalls);

  return res.status(200).json({
    reply: finalText || 'Done.',
    activity: ctx.activity,
    pending_broadcast: ctx.pendingBroadcast || undefined
  });
}

// ── Confirmed broadcast execution (no LLM involved) ───────────────────
export async function handleExecuteBroadcast(req, res, { SUPABASE_URL, headers }) {
  const TOKEN = process.env.META_WA_TOKEN;
  const PHONE_ID = process.env.META_WA_PHONE_ID;
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'WhatsApp env vars not configured' });

  const draftId = req.body?.payload?.draftId;
  if (!draftId) return res.status(400).json({ error: 'draftId required' });

  const draft = await getSetting(SUPABASE_URL, headers, 'assistant_pending_broadcast');
  if (!draft || draft.id !== draftId) return res.status(410).json({ error: 'This draft is no longer pending (superseded or already sent). Ask Maya to draft it again.' });
  if (Date.now() - new Date(draft.created_at).getTime() > BROADCAST_TTL_MS) {
    await setSetting(SUPABASE_URL, headers, 'assistant_pending_broadcast', null);
    return res.status(410).json({ error: 'Draft expired (30 min limit) -- ask Maya to draft it again so the 24h windows are fresh.' });
  }

  // Recompute windows at send time — a draft can sit for many minutes.
  const env = { SUPABASE_URL, headers, TOKEN, PHONE_ID };
  const ids = (draft.recipients || []).map(r => r.id);
  const lastIn = await lastInboundByAgent(SUPABASE_URL, headers, ids);

  const results = [];
  let sent = 0, skipped = 0, failed = 0;
  for (const rec of draft.recipients || []) {
    let r;
    if (draft.template) {
      // Approved templates deliver regardless of the 24h window.
      r = await sendWaTemplate(env, rec, draft.template);
    } else {
      const inWindow = !!(lastIn[rec.id] && (Date.now() - lastIn[rec.id]) <= IN_WINDOW_MS);
      if (!inWindow) { skipped++; results.push({ id: rec.id, name: rec.name, outcome: 'skipped (outside 24h window)' }); continue; }
      r = await sendWaText(env, { id: rec.id, wa_num: rec.wa_num }, draft.message, 'broadcast');
    }
    if (r.ok) { sent++; results.push({ id: rec.id, name: rec.name, outcome: 'sent' }); }
    else { failed++; results.push({ id: rec.id, name: rec.name, outcome: 'failed: ' + r.error }); }
  }

  await setSetting(SUPABASE_URL, headers, 'assistant_pending_broadcast', null);
  return res.status(200).json({ success: true, label: draft.label, sent, skipped, failed, results });
}
