import { PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, BROCHURES as FALLBACK_BROCHURES, MAYA_PERSONA } from '../lib/kb.js';
import { forwardInbound, forwardMayaReply } from '../lib/telegram.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

// In-memory cache for projects (warm container only). 60s TTL.
let _projectsCache = null;
let _projectsCacheAt = 0;
const PROJECTS_CACHE_TTL_MS = 60 * 1000;
let _rentalsCache = null;
let _rentalsCacheAt = 0;

async function loadRentals(supabaseUrl, sbHeaders) {
  const now = Date.now();
  if (_rentalsCache && (now - _rentalsCacheAt) < PROJECTS_CACHE_TTL_MS) {
    return _rentalsCache;
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rentals?select=*&active=eq.true&order=display_order.asc`, { headers: sbHeaders });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      _rentalsCache = data;
      _rentalsCacheAt = now;
      return data;
    }
  } catch (e) {
    console.warn('loadRentals failed:', e.message);
  }
  return null;
}

function buildRentalsContext(rentals) {
  if (!rentals || rentals.length === 0) {
    return `SAMBA REALTY RENTAL PORTFOLIO:
Samba Realty manages a portfolio of rental properties across Canggu, Pererenan, and Seminyak. Commission is 10% per booking. Live availability is at sambarentals.vercel.app. For specific properties or live calendars, refer agents to the portal.`;
  }
  const blocks = rentals.map((p, i) => {
    // Build rate string covering both long-term (monthly/yearly) and short-term (nightly)
    const rateParts = [];
    if (p.monthly_rate_idr) rateParts.push(`IDR ${(p.monthly_rate_idr / 1e6).toFixed(0)}M/mo`);
    if (p.yearly_rate_idr) rateParts.push(`IDR ${(p.yearly_rate_idr / 1e6).toFixed(0)}M/yr`);
    if (p.nightly_rate_usd) rateParts.push(`$${p.nightly_rate_usd}/night`);
    else if (p.nightly_rate_idr) rateParts.push(`IDR ${(p.nightly_rate_idr / 1e3).toFixed(0)}K/night`);
    const rate = rateParts.length ? rateParts.join(' / ') : 'rate TBC';

    const capacity = [p.beds && `${p.beds} bed`, p.baths && `${p.baths} bath`, p.max_guests && `sleeps ${p.max_guests}`].filter(Boolean).join(', ');
    const occ = p.occupancy_pct ? `${p.occupancy_pct}% recent occupancy` : null;
    const monthly = p.monthly_revenue_idr ? `~IDR ${(p.monthly_revenue_idr / 1e6).toFixed(1)}M/mo actual revenue` : null;
    const links = [p.portal_url && `portal: ${p.portal_url}`, p.airbnb_url && `airbnb: ${p.airbnb_url}`, p.booking_url && `booking: ${p.booking_url}`].filter(Boolean).join(' · ');
    const lines = [
      `${i + 1}. ${p.name.toUpperCase()}${p.area ? ' -- ' + p.area : ''}${p.full_location ? ' (' + p.full_location + ')' : ''}`,
      p.property_type ? `   Type: ${p.property_type}${capacity ? ', ' + capacity : ''}${p.sqm ? ', ' + p.sqm + ' sqm' : ''}` : null,
      `   Rate: ${rate}${p.min_stay_nights > 1 ? `, min ${p.min_stay_nights} nights` : ''}`,
      occ || monthly ? `   Performance: ${[occ, monthly].filter(Boolean).join(', ')}` : null,
      p.amenities ? `   Amenities: ${p.amenities}` : null,
      p.features ? `   Features: ${p.features}` : null,
      p.extended_info ? `   Details:\n${p.extended_info.split('\n').map(l => '     ' + l).join('\n')}` : null,
      links ? `   Links: ${links}` : null,
      p.maya_notes ? `   Notes for Maya: ${p.maya_notes}` : null,
      p.commission_pct ? `   Commission: ${p.commission_pct}% per booking` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
  return `SAMBA REALTY RENTAL PORTFOLIO (current, live from DB):\n\n${blocks.join('\n\n')}\n\nFor live nightly availability, direct agents to the portal: sambarentals.vercel.app`;
}

async function loadProjects(supabaseUrl, sbHeaders) {
  const now = Date.now();
  if (_projectsCache && (now - _projectsCacheAt) < PROJECTS_CACHE_TTL_MS) {
    return _projectsCache;
  }
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers: sbHeaders });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      _projectsCache = data;
      _projectsCacheAt = now;
      return data;
    }
  } catch (e) {
    console.warn('loadProjects failed:', e.message);
  }
  return null;
}

// Build PORTFOLIO_CONTEXT string dynamically from the projects DB rows.
// Falls back to the hardcoded version if DB is empty/unavailable.
function buildPortfolioContext(projects) {
  if (!projects || projects.length === 0) return FALLBACK_PORTFOLIO;
  const blocks = projects.map((p, i) => {
    const unitLines = (p.units || []).map(u => {
      const price = u.price_usd ? `$${(u.price_usd / 1000).toFixed(0)}K USD` : (u.price_idr ? `IDR ${(u.price_idr / 1e9).toFixed(2)}B` : 'TBC');
      const sqm = u.sqm ? `${u.sqm} sqm` : '';
      const layout = [u.beds && `${u.beds} bed`, u.baths && `${u.baths} bath`].filter(Boolean).join(', ');
      const status = u.availability && u.availability !== 'Available' ? ` -- ${u.availability.toUpperCase()}` : '';
      const notes = u.notes ? ` (${u.notes})` : '';
      return `   - ${u.code}: ${layout}${sqm ? ', ' + sqm : ''}${u.floor ? ', ' + u.floor : ''} -- ${price}${status}${notes}`;
    }).join('\n');
    const lines = [
      `${i + 1}. ${p.name.toUpperCase()}${p.area ? ' -- ' + p.area : ''}${p.full_location ? ' (' + p.full_location + ')' : ''}`,
      p.tagline ? `   ${p.tagline}` : null,
      p.property_type || p.tenure ? `   Type: ${[p.property_type, p.tenure_details || p.tenure, p.furnished].filter(Boolean).join(', ')}` : null,
      unitLines ? `   Units:\n${unitLines}` : null,
      p.construction_status || p.delivery_date ? `   Status: ${[p.construction_status, p.delivery_date].filter(Boolean).join(' -- ')}` : null,
      p.payment_plan ? `   Payment plan: ${p.payment_plan}` : null,
      p.features ? `   Features: ${p.features}` : null,
      p.roi_projections ? `   ROI: ${p.roi_projections}` : null,
      p.rental_performance ? `   Rental performance: ${p.rental_performance}` : null,
      p.distances ? `   Location: ${p.distances}` : null,
      p.maya_notes ? `   Notes for Maya: ${p.maya_notes}` : null,
      p.commission_pct ? `   Commission: ${p.commission_pct}%` : null,
      p.extended_info ? `   Extended details (from brochure):\n${p.extended_info.split('\n').map(l => '     ' + l).join('\n')}` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
  return `KAYA portfolio (current, live from DB):\n\n${blocks.join('\n\n')}`;
}

// Build brochure map from projects: { slug: { url, filename, label } }
function buildBrochures(projects) {
  if (!projects || projects.length === 0) return FALLBACK_BROCHURES;
  const map = {};
  for (const p of projects) {
    if (p.brochure_url) {
      map[p.slug] = {
        url: p.brochure_url,
        filename: p.brochure_filename || `${p.name}.pdf`,
        label: p.name
      };
    }
  }
  return Object.keys(map).length > 0 ? map : FALLBACK_BROCHURES;
}

// Maya operational windows (WITA = UTC+8)
const ACTIVE_HOUR_START = 9;  // 9am WITA
const ACTIVE_HOUR_END = 21;   // 9pm WITA (inclusive of 9:xx, exclusive of 10pm)
const DAILY_SPEND_CAP_USD = 2.00;

// Rough estimate: Claude Sonnet 4 with system prompt ~5k input + ~500 output tokens per reply
// $3/M input, $15/M output → ~$0.022 per reply. We'll round up for safety to $0.03.
const ESTIMATED_COST_PER_REPLY_USD = 0.03;

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const WA_TOKEN = process.env.META_WA_TOKEN;
  const WA_PHONE_ID = process.env.META_WA_PHONE_ID;

  // GET — Meta webhook verification handshake
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.status(200).end();

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).end(); // status update, not a message

    const fromNum = msg.from;
    const text = msg.text?.body || '';
    const waMessageId = msg.id;
    const timestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).end();

    const sbHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };

    // Find matching agent
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${fromNum}&select=*`,
      { headers: sbHeaders }
    );
    const agent = (await agentRes.json())?.[0];

    // Store inbound message
    await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agent?.id || null, wa_num: fromNum, direction: 'inbound',
        content: text, wa_message_id: waMessageId, timestamp, source: 'webhook'
      })
    });

    if (!agent) return res.status(200).end(); // unknown sender — logged, nothing else

    // Update conversation summary, history, inbox state
    const dateStr = new Date(timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const newLine = `\n[${dateStr}] ${agent.name || 'Agent'}: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
    const updatedSummary = ((agent.conversation_summary || '') + newLine).slice(-4000);
    const updatedHistory = {
      ...(agent.conversation_history || {}),
      last_contact: dateStr,
      total_messages: ((agent.conversation_history || {}).total_messages || 0) + 1,
      first_contact: (agent.conversation_history || {}).first_contact || dateStr
    };

    // Determine automation mode (per-agent override beats global)
    // Special override value 'paused' = Ikiel is handling this thread manually, Maya stays silent.
    let globalMode = 'draft';
    try {
      const sRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers: sbHeaders });
      const sRow = (await sRes.json())?.[0];
      if (sRow?.value?.mode) globalMode = sRow.value.mode;
    } catch (e) { /* default */ }

    const override = agent.automation_override;
    const mode = override === 'paused' ? 'paused' : (override || globalMode);

    // Forward to Telegram (fire and forget — never block the webhook on it)
    forwardInbound(agent, text, mode).catch(() => {});

    const patch = {
      conversation_summary: updatedSummary,
      conversation_history: updatedHistory,
      last_inbound_at: timestamp,
      unread_count: (agent.unread_count || 0) + 1
    };

    // STOP CAMPAIGN SEQUENCE — any inbound message stops the active campaign
    // template sequence for this agent. Their conversation is now live.
    if (agent.campaign_engagement && agent.campaign_engagement.status === 'pending') {
      patch.campaign_engagement = {
        ...agent.campaign_engagement,
        status: 'responded',
        responded_at: timestamp,
        next_template_at: null
      };
    }

    // PAUSED — Ikiel is handling this thread, Maya stays silent. Just log + mark unread.
    if (mode === 'paused') {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // OFF — log only
    if (mode === 'off' || !ANTHROPIC_KEY) {
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // TEST CONTACTS — bypass hours gate and spend cap so iteration works any time.
    // Real agents still get the production guardrails.
    const isTestContact = agent.is_test === true;

    // HOURS OF OPERATION CHECK — Maya only auto-replies between 9am-9pm WITA
    if (!isTestContact && !isWithinOperationalHours()) {
      // Outside hours: still draft a suggestion so Ikiel can review in the morning
      const aiResultOffHours = await generateReply(ANTHROPIC_KEY, agent, text, 'draft');
      patch.suggested_reply = aiResultOffHours.reply || '';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // SPEND CAP CHECK — pause Maya for the day if over $2 daily Claude spend
    if (!isTestContact) {
      const todaySpend = await getTodaySpend(SUPABASE_URL, sbHeaders);
      if (todaySpend >= DAILY_SPEND_CAP_USD) {
        // Over cap: log + escalate as draft (no Claude call)
        patch.suggested_reply = '[Maya is paused: daily spend cap reached. Please reply manually.]';
        await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
        return res.status(200).end();
      }
    }

    // Generate a reply with Claude — load live project + rental data from DB first
    const projects = await loadProjects(SUPABASE_URL, sbHeaders);
    const rentals = await loadRentals(SUPABASE_URL, sbHeaders);
    const liveContext = buildPortfolioContext(projects);
    const rentalsContext = buildRentalsContext(rentals);
    const liveBrochures = buildBrochures(projects);
    // Fetch the full recent thread (both inbound + outbound) so Maya has context of what she sent
    const recentThread = await fetchRecentThread(SUPABASE_URL, sbHeaders, agent.id);
    // If this agent is engaged in an active campaign, fetch the campaign's context
    // so Maya knows the specific focus / promo / framing for this batch.
    let campaignContext = null;
    if (agent.campaign_engagement?.campaign_id) {
      try {
        const cRes = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?id=eq.${agent.campaign_engagement.campaign_id}&select=name,context,purpose`, { headers: sbHeaders });
        const cRow = (await cRes.json())?.[0];
        if (cRow?.context) campaignContext = { name: cRow.name, context: cRow.context, purpose: cRow.purpose };
      } catch (e) { /* non-fatal */ }
    }
    const aiResult = await generateReply(ANTHROPIC_KEY, agent, text, mode, liveContext, liveBrochures, recentThread, rentalsContext, campaignContext);

    // Increment today's spend by the estimated cost of this Claude call
    await incrementTodaySpend(SUPABASE_URL, sbHeaders, ESTIMATED_COST_PER_REPLY_USD);

    // Apply any CRM updates Maya suggested (status changes, tags)
    // Each update is logged with evidence and a "by_maya: true" flag
    if (Array.isArray(aiResult.crm_updates) && aiResult.crm_updates.length > 0) {
      await applyCrmUpdates(SUPABASE_URL, sbHeaders, agent, aiResult.crm_updates, text);
    }

    if (mode === 'draft') {
      patch.suggested_reply = aiResult.reply || '';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID — auto-send only confident FAQ answers, else escalate
    if (mode === 'hybrid' && aiResult.action === 'escalate') {
      patch.suggested_reply = aiResult.reply || '';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    // HYBRID(auto) or AUTOPILOT — send the reply
    // Edge case: if Claude returned action: "escalate" with an empty reply (e.g. spam/harassment),
    // skip the send entirely.
    if (aiResult.action === 'escalate' && !aiResult.reply) {
      patch.suggested_reply = '[Maya escalated silently. Likely spam/harassment.]';
      await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
      return res.status(200).end();
    }

    if (aiResult.reply && WA_TOKEN && WA_PHONE_ID) {
      await sendText(WA_PHONE_ID, WA_TOKEN, fromNum, aiResult.reply);
      await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, aiResult.reply);
      // Mirror Maya's reply to Telegram so Ikiel sees the full conversation
      forwardMayaReply(agent, aiResult.reply).catch(() => {});

      // Send brochure if Claude requested one (use live brochure map from DB)
      // Dedup: skip if the same filename was sent in the last 14 days (e.g. via campaign attachment).
      const doc = aiResult.send_doc && liveBrochures[aiResult.send_doc];
      if (doc && doc.url) {
        const recentlySent = await wasDocRecentlySent(SUPABASE_URL, sbHeaders, agent.id, doc.filename, 14);
        if (!recentlySent) {
          await sendDocument(WA_PHONE_ID, WA_TOKEN, fromNum, doc.url, doc.filename);
          await logOutbound(SUPABASE_URL, sbHeaders, agent.id, fromNum, `[Document: ${doc.filename}]`);
        } else {
          console.log(`Skipping ${doc.filename} — already sent in last 14 days`);
        }
      }
      // Auto-sent: clear suggestion, don't mark unread
      patch.suggested_reply = '';
      patch.unread_count = 0;
    } else {
      patch.suggested_reply = aiResult.reply || '';
    }

    await patchAgent(SUPABASE_URL, sbHeaders, agent.id, patch);
    return res.status(200).end();

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).end();
  }
}

// ── Helpers ──────────────────────────────────────────────

// Returns true if current time is between 9am and 9pm WITA (UTC+8).
function isWithinOperationalHours() {
  const nowUtc = new Date();
  // WITA = UTC+8. Convert hour by adding 8.
  const witaHour = (nowUtc.getUTCHours() + 8) % 24;
  return witaHour >= ACTIVE_HOUR_START && witaHour < ACTIVE_HOUR_END;
}

// Returns the YYYY-MM-DD date string in WITA time zone (for daily spend tracking).
function getTodayWitaDateStr() {
  const nowUtc = new Date();
  const witaTime = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
  return witaTime.toISOString().slice(0, 10);
}

async function getTodaySpend(url, headers) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    const today = getTodayWitaDateStr();
    return usage[today] || 0;
  } catch (e) {
    return 0;
  }
}

async function incrementTodaySpend(url, headers, costUsd) {
  try {
    const r = await fetch(`${url}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
    const row = (await r.json())?.[0];
    const usage = row?.value || {};
    const today = getTodayWitaDateStr();
    usage[today] = (usage[today] || 0) + costUsd;
    // Trim old days (keep last 30)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    Object.keys(usage).forEach(k => { if (k < cutoff) delete usage[k]; });
    await fetch(`${url}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'daily_usage', value: usage })
    });
  } catch (e) {
    console.warn('incrementTodaySpend failed:', e.message);
  }
}

async function applyCrmUpdates(url, headers, agent, updates, evidenceQuote) {
  // updates: [{ field: 'projects.Clay House.status', value: 'Listed', reason: '...' }]
  // Apply each update to the agent, log to maya_updates for review.
  // CRITICAL: when multiple updates target the same root (e.g. projects.X.status and
  // projects.X.stage), they must accumulate into the SAME patch[root] object, not
  // each overwrite the previous with a fresh clone of agent[root].
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
      patch[parts[0]] = u.value;
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
      evidence: evidenceQuote.slice(0, 500),
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

async function patchAgent(url, headers, id, fields) {
  await fetch(`${url}/rest/v1/agents?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify(fields)
  }).catch(e => console.warn('patchAgent failed:', e.message));
}

async function logOutbound(url, headers, agentId, waNum, content) {
  const ts = new Date().toISOString();
  await fetch(`${url}/rest/v1/wa_messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      agent_id: agentId, wa_num: waNum, direction: 'outbound',
      content, timestamp: ts, source: 'api'
    })
  }).catch(e => console.warn('logOutbound failed:', e.message));

  // Also append outbound to the agent's conversation_summary so it's visible as context
  if (agentId) {
    try {
      const agentRes = await fetch(`${url}/rest/v1/agents?id=eq.${agentId}&select=conversation_summary`, { headers });
      const agentRow = (await agentRes.json())?.[0];
      const dateStr = new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      const snippet = content.slice(0, 120) + (content.length > 120 ? '...' : '');
      const newLine = `\n[${dateStr}] Maya: ${snippet}`;
      const updatedSummary = ((agentRow?.conversation_summary || '') + newLine).slice(-4000);
      await fetch(`${url}/rest/v1/agents?id=eq.${agentId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ conversation_summary: updatedSummary })
      });
    } catch (e) {
      console.warn('logOutbound summary update failed:', e.message);
    }
  }
}

async function sendText(phoneId, token, to, text) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

// Returns true if a document with this filename was sent to this agent within
// the last `days` days. Used to prevent Maya re-sending a brochure that the
// campaign already attached.
async function wasDocRecentlySent(url, headers, agentId, filename, days) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${url}/rest/v1/wa_messages?agent_id=eq.${agentId}&direction=eq.outbound&timestamp=gte.${cutoff}&select=content&limit=200`,
      { headers }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    if (!Array.isArray(rows)) return false;
    return rows.some(m => (m.content || '').includes(`[Document: ${filename}]`));
  } catch (e) {
    return false;
  }
}

async function sendDocument(phoneId, token, to, link, filename) {
  return fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'document', document: { link, filename } })
  });
}

// Fetch the last 30 messages (both directions) for an agent, ordered oldest→newest.
// Returns a formatted string like:
//   [09:44] KAYA: Hi jules, I'm reaching out from KAYA Developments...
//   [09:45] Agent: Yes please
async function fetchRecentThread(url, headers, agentId) {
  try {
    const r = await fetch(
      `${url}/rest/v1/wa_messages?agent_id=eq.${agentId}&order=timestamp.desc&limit=30`,
      { headers }
    );
    if (!r.ok) return '';
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return '';
    // Reverse so oldest first
    rows.reverse();
    return rows.map(m => {
      const t = new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
      const sender = m.direction === 'outbound' ? 'KAYA Listings (Maya)' : 'Agent';
      const content = m.content?.slice(0, 200) || '';
      return `[${t}] ${sender}: ${content}`;
    }).join('\n');
  } catch (e) {
    return '';
  }
}

async function generateReply(apiKey, agent, inbound, mode, portfolioContext, brochures, recentThread, rentalsContext, campaignContext) {
  const brochureMap = brochures || FALLBACK_BROCHURES;
  const portfolio = portfolioContext || FALLBACK_PORTFOLIO;
  const brochureKeys = Object.keys(brochureMap).join(', ');
  const isHybrid = mode === 'hybrid';

  const threadBlock = recentThread
    ? `Recent message thread (oldest → newest, both sides):\n${recentThread}`
    : `Prior notes:\n${(agent.conversation_summary || '(no prior history)').slice(-2500)}`;

  const system = `${MAYA_PERSONA}

KAYA SALES PORTFOLIO (the single source of truth — Ikiel keeps this current via the Projects admin page):
${portfolio}

${rentalsContext || ''}

WHICH PORTFOLIO TO REFERENCE:
KAYA Sales = freehold/leasehold property SALES (Clay House, Tropical Townhouses, Palem Kembar, Sabit House, LaneHAUS). For agents looking to LIST properties for sale.
Samba Realty = short-term RENTALS. For agents whose clients are looking for vacation/longer-stay accommodation, OR for agents who want to refer rental clients for a 10% commission per booking.
Pick the right portfolio based on what the agent is asking about. If they're ambiguous, ask which side they're focused on (sales listings or rental referrals). Some agents do both.

NAME-DROPPING IKIEL (important for cold rental agents):
Many rental agents know Ikiel personally but may not recognize "Samba Realty" or "KAYA Developments" as brand names. To bridge that gap, mention Ikiel by name naturally in your first or second message when context permits:
- Samba flow (more important): "I'm Maya, working with Ikiel on the Samba Realty side..." or "Ikiel asked me to make sure our agent partners have the latest..." — make it sound like a normal introduction, not a name-drop. The goal is to trigger their "oh, Ikiel's bot" recognition.
- KAYA flow: less critical since KAYA Developments is more established as a brand. Still natural to mention Ikiel when appropriate (e.g. "I'll loop Ikiel in" for escalations).
- Don't overdo it — mention Ikiel ONCE per conversation, not in every message. After the agent has placed the context, drop back to "we" / "the team".
- Never claim to be Ikiel. You're Maya, who works WITH Ikiel.

DATA PRIORITY RULES (critical — read carefully):
1. The structured "Units:" list under each project is the AUTHORITATIVE record of what is available, sold, reserved, or coming soon. Trust the per-unit availability tag (-- SOLD, -- RESERVED, -- COMING SOON) over any other text.
2. When quoting prices: only quote prices from units that are NOT marked SOLD/RESERVED. Never quote a sold unit's price as if it's available.
3. When counting availability: count units WITHOUT a SOLD/RESERVED/COMING SOON tag. Do not parrot a number from "Notes for Maya" if it conflicts with the actual unit count.
4. The "Notes for Maya" line is supplementary context (tone, positioning, edge-case framing). It is NOT the source of truth for prices, availability counts, or unit specs. If notes conflict with structured fields, the structured fields win.
5. Brochure URLs, commission %, status, delivery date, payment plan — also authoritative as written in the structured fields.
6. The "Extended details (from brochure)" block is supplementary information pulled from the project's sales brochure. Use it for questions that aren't covered by structured fields (architects, builder/contractor, design philosophy, materials, construction methodology, amenity rationale, etc.). Quote it freely when relevant.
7. If a field is empty AND there's nothing in extended_info that covers the question, do not guess or fill in from memory. Say "Let me check with Ikiel and come back to you."

TEMPLATE CONTEXT (what the approved outbound templates say, so you understand replies to them):
- [Template: kaya_intro] = "Hi {name}, I'm reaching out from KAYA Developments Listings Team to make sure agents have up-to-date info on our current projects and properties. Can I send you the latest info?"
- [Template: samba_intro] = "Hi {name}, I'm reaching out from Samba Realty Listings to make sure agents have up-to-date info on our current rentals. Can I send you the latest info?"

When an agent replies with a short affirmative (Yes / Yes please / Sure / Please / Go ahead / Ok) after one of these templates, they are saying yes to receiving the info. Respond IMMEDIATELY with the info — do NOT ask "which project?" or "what area?" first.

If they said yes to kaya_intro: send a concise overview of all active KAYA SALES projects — one short line each (name, location, price range, headline feature). Then invite them to go deeper on whichever interests them.

If they said yes to samba_intro: send a concise overview of all SAMBA RENTAL property groups (HAUS Canggu, LaneHAUS, Villa Saturno, Tropicana Valley) — one short line each (location, type, headline rate). Then in a SECOND short paragraph, surface the agent portal:

  "All availability, listing photos, and rental details are live at https://sambarentals.vercel.app — agents can download photos to share with clients directly, see real-time calendar availability, and use the WhatsApp shortcut to send the listing straight to a client. Happy to answer questions about any specific property too."

Always include the portal link with that explanation on the FIRST Samba response after samba_intro. On subsequent Samba responses you don't need to repeat the explanation — just refer to "the portal" if relevant.

This conversation's context:
Agent name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}
${threadBlock}
${campaignContext ? `

CAMPAIGN-SPECIFIC FOCUS (this agent was reached via the "${campaignContext.name}" campaign — use this as your North Star for the current conversation; weave it in naturally rather than reciting it):
${campaignContext.context}${campaignContext.purpose ? `\nCampaign purpose: ${campaignContext.purpose}` : ''}` : ''}

You can attach a project brochure PDF for KAYA SALES projects only. Available brochure keys: ${brochureKeys}.

IMPORTANT — SAMBA RENTALS HAVE NO PDF BROCHURES.
For Samba rental properties (HAUS Canggu, LaneHAUS rental units, Villa Saturno, Tropicana Valley monthly rentals) there are NO PDF brochures to send. All photos, availability calendars, and listing details live in the portal at https://sambarentals.vercel.app.
- If an agent asks for rental photos, the brochure, or "info to share with a client," direct them to the portal — agents can download photos there directly.
- Never offer to send a rental brochure. Never list "which property would you like a brochure for" for Samba rentals.
- For KAYA sales projects (Clay House, Sabit House, Palem Kembar, Tropical Townhouses-as-sales, LaneHAUS-as-sales), PDF brochures DO exist and can be attached via send_doc.

You can suggest CRM updates when the agent's message clearly indicates a pipeline change. The structured lifecycle is:

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

For timestamp fields (stage_updated_at, next_followup_at), use these special marker strings — the system will substitute the actual ISO timestamp:
- For "right now" → use the literal string "__NOW__"
- For "3 days from now" → use the literal string "__NOW+3D__"
- For "null / no follow-up needed" → use null

When updating .stage, ALSO set projects.<Name>.stage_updated_at = "__NOW__" so we can audit.

Respond with ONLY a JSON object (no markdown, no prose):
{
  "action": "auto" | "escalate",
  "reply": "the message to send to the agent (1-4 sentences typical)",
  "send_doc": null | one of [${brochureKeys}],
  "crm_updates": [
    { "field": "projects.Sabit House.status", "value": "Listed", "reason": "agent confirmed listing" }
  ]
}
${isHybrid
  ? `Set "action" to "auto" ONLY if the message is a simple, factual question you can answer with full confidence from the portfolio knowledge (e.g. commission %, price, availability, sending a brochure). For anything involving negotiation, scheduling, complaints, commitments, or ambiguity, set "action" to "escalate" (Ikiel will review your draft before it sends).`
  : `Set "action" to "auto" by default. Use "escalate" only when one of your escalation triggers fires (negotiation, complaint, legal questions, request to speak to Ikiel, low confidence, etc).`}
Set "send_doc" ONLY when the agent EXPLICITLY requests the brochure/PDF/document for a specific project. Examples that trigger send_doc: "send me the brochure", "do you have a PDF for Clay House", "can you share the documents", "send over the info pack". Do NOT set send_doc just because the agent mentioned a project name or asked a general question about it — describe the project in text first and let them ask for the brochure if they want it. The system also auto-dedupes: if a brochure was already sent in the last 14 days (e.g. via a campaign attachment), it will silently skip the re-send.
Set "crm_updates" to an empty array if no clear pipeline signals are present.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: `The agent just sent: "${inbound}"` }]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action === 'auto' ? 'auto' : 'escalate',
        reply: parsed.reply || '',
        send_doc: parsed.send_doc || null,
        crm_updates: Array.isArray(parsed.crm_updates) ? parsed.crm_updates : []
      };
    }
    return { action: 'escalate', reply: raw.trim(), send_doc: null, crm_updates: [] };
  } catch (err) {
    console.warn('generateReply failed:', err.message);
    return { action: 'escalate', reply: '', send_doc: null, crm_updates: [] };
  }
}
