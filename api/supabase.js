import { MAYA_PERSONA, PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, pickWelcomeTemplate, isWithinWitaHours } from '../lib/kb.js';
import { handleAssistant, handleExecuteBroadcast } from '../lib/assistant.js';
import { syncRental } from '../lib/rental-sync.js';
import { baseAgentFields, createAgentRow } from '../lib/agents.js';
import { getPlaybook, renderPlaybookBlock, applyDecisions } from '../lib/maya-review.js';
import { applyCrmUpdates, applyCrmActions, CRM_SIGNALS_INSTRUCTIONS } from '../lib/crm-apply.js';
// Portal listings → card objects { slug, title, subtitle, image, url, badge }
// plus the send/log machinery — shared with Maya's autoresponder and the
// whatsapp-send 'cards' action.
import { fetchPortalCards, resolveListingCards, sendListingCardMessage, cardMarker } from '../lib/listing-cards.js';
import webpush from 'web-push';

// Normalise a raw number string to an Indonesian mobile in 628… form, or null.
// Filters out prices/landlines/garbage (must be a 62 8xx mobile, 10–15 digits).
function normIndoMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  else if (!d.startsWith('62')) return null;
  if (d.length < 10 || d.length > 15) return null;
  if (!d.startsWith('628')) return null; // Indonesian mobiles only
  return d;
}
// True when a wa_num value carries no actual digits (empty / whitespace / junk).
const isBlankNum = (v) => !String(v || '').replace(/\D/g, '');

// Guard against silent number loss: a stale browser tab saves the whole agent
// row, and if its cached copy had an empty wa_num it would blank a real number
// on the server. For every incoming row that has an id but a blank wa_num,
// look up the stored row and, if it still holds a number, keep it (wa_num +
// wa_url). New rows (no id) and rows that actually change the number are left
// alone. `rows` is mutated in place; returns the list of preserved ids.
async function preserveExistingNumbers(SUPABASE_URL, headers, rows) {
  const needCheck = rows.filter((a) => a && a.id != null && 'wa_num' in a && isBlankNum(a.wa_num));
  if (!needCheck.length) return [];
  const ids = [...new Set(needCheck.map((a) => a.id))];
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/agents?id=in.(${ids.join(',')})&select=id,wa_num,wa_url`,
    { headers }
  ).then((r) => r.json()).catch(() => []);
  const byId = new Map((Array.isArray(existing) ? existing : []).map((e) => [String(e.id), e]));
  const preserved = [];
  for (const a of needCheck) {
    const cur = byId.get(String(a.id));
    if (cur && !isBlankNum(cur.wa_num)) {
      a.wa_num = cur.wa_num;
      a.wa_url = cur.wa_url || `https://wa.me/${String(cur.wa_num).replace(/\D/g, '')}`;
      preserved.push(a.id);
    }
  }
  return preserved;
}

// Pull phone-shaped substrings out of a message body.
function extractPhoneCandidates(text) {
  const out = [];
  const re = /(\+?\d[\d\s().\-]{7,20}\d)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) out.push(m[1]);
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const { action, payload } = req.body || {};

  // ── Portal → CRM listing sync (event-driven) ─────────────────────────
  // sambarentals.com fires this on every admin listing save (notifyCrmSync in
  // the portal's api/listings.js): { slug, action: 'upsert'|'delete' } with a
  // shared bearer secret. Handled before the action router because the payload
  // shape is the portal's, not ours. Keeps rentals prices/badges in lockstep
  // with what agents actually see — no drift window.
  const syncSecret = process.env.LISTING_SYNC_SECRET;
  if (syncSecret && req.headers.authorization === `Bearer ${syncSecret}`
      && req.body?.slug && (action === 'upsert' || action === 'delete')) {
    try {
      const out = await syncRental({ SUPABASE_URL, headers }, req.body.slug, action);
      return res.status(out.error ? 500 : 200).json(out);
    } catch (e) {
      return res.status(500).json({ error: 'rental sync failed: ' + e.message });
    }
  }

  try {
    let r;

    if (action === 'get_agents') {
      r = await fetch(SUPABASE_URL + '/rest/v1/agents?select=*&order=id', { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'upsert_agent') {
      // Never let a stale-tab save blank an existing number (see helper above).
      const rows = Array.isArray(payload) ? payload : [payload];
      await preserveExistingNumbers(SUPABASE_URL, headers, rows);
      r = await fetch(SUPABASE_URL + '/rest/v1/agents', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(Array.isArray(payload) ? rows : rows[0])
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'patch_agent') {
      const { id, fields } = payload;
      // Don't let a patch that carries a blank wa_num wipe a stored number.
      if (fields && 'wa_num' in fields && isBlankNum(fields.wa_num) && id != null) {
        const cur = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${id}&select=wa_num`, { headers })
          .then((rr) => rr.json()).catch(() => []);
        if (Array.isArray(cur) && cur[0] && !isBlankNum(cur[0].wa_num)) {
          delete fields.wa_num;
          delete fields.wa_url;
        }
      }
      r = await fetch(SUPABASE_URL + '/rest/v1/agents?id=eq.' + id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(fields)
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      return res.status(r.status).end();

    } else if (action === 'delete_agent') {
      const { id } = payload || {};
      if (id == null) return res.status(400).json({ error: 'id required' });
      // Refuse if the contact has WhatsApp history: deleting would orphan the
      // messages, and relink_orphan_messages would then resurrect the contact.
      const msgs = await (await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?agent_id=eq.${id}&select=id&limit=1`, { headers })).json().catch(() => []);
      if (Array.isArray(msgs) && msgs.length) {
        return res.status(409).json({ error: 'This contact has WhatsApp message history and cannot be deleted. If it is a duplicate, keep this card and delete the other one.' });
      }
      // maya_updates audit rows hold a FK to agents(id); remove them first.
      await fetch(`${SUPABASE_URL}/rest/v1/maya_updates?agent_id=eq.${id}`, { method: 'DELETE', headers });
      r = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${id}`, { method: 'DELETE', headers });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      return res.status(200).json({ success: true, deleted: id });

    } else if (action === 'get_messages') {
      const { agentId } = payload || {};
      const filter = agentId ? `?agent_id=eq.${agentId}&order=timestamp.desc&limit=100` : '?order=timestamp.desc&limit=500';
      r = await fetch(SUPABASE_URL + '/rest/v1/wa_messages' + filter, { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'get_last_inbound') {
      // For each agent_id in payload.agentIds, return the timestamp of their most recent inbound message
      const { agentIds } = payload || {};
      if (!Array.isArray(agentIds) || agentIds.length === 0) {
        return res.status(200).json({});
      }
      const idsFilter = 'agent_id=in.(' + agentIds.join(',') + ')';
      r = await fetch(
        SUPABASE_URL + '/rest/v1/wa_messages?' + idsFilter + '&direction=eq.inbound&select=agent_id,timestamp&order=timestamp.desc&limit=1000',
        { headers }
      );
      const data = await r.json();
      const result = {};
      if (Array.isArray(data)) {
        data.forEach(m => {
          if (!result[m.agent_id] || new Date(m.timestamp) > new Date(result[m.agent_id])) {
            result[m.agent_id] = m.timestamp;
          }
        });
      }
      return res.status(200).json(result);

    } else if (action === 'insert_message') {
      r = await fetch(SUPABASE_URL + '/rest/v1/wa_messages', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'upsert_campaign') {
      r = await fetch(SUPABASE_URL + '/rest/v1/campaigns', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'get_campaigns') {
      r = await fetch(SUPABASE_URL + '/rest/v1/campaigns?select=*&order=created_at.desc', { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'patch_campaign') {
      const { id, fields } = payload;
      r = await fetch(SUPABASE_URL + '/rest/v1/campaigns?id=eq.' + id, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() })
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'get_settings') {
      r = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.' + (payload?.key || 'automation') + '&select=value', { headers });
      const data = await r.json();
      return res.status(r.status).json(data?.[0]?.value || null);

    } else if (action === 'upload_file') {
      const { path, contentType, fileBase64 } = payload;
      // Upload file to Supabase Storage (brochures bucket)
      const uploadUrl = SUPABASE_URL + '/storage/v1/object/brochures/' + path;
      const publicUrl = SUPABASE_URL + '/storage/v1/object/public/brochures/' + path;

      if (fileBase64) {
        // Direct upload via proxy (file sent as base64)
        const fileBuffer = Buffer.from(fileBase64, 'base64');
        r = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': contentType || 'application/octet-stream',
            'x-upsert': 'true'
          },
          body: fileBuffer
        });
        if (!r.ok) {
          const err = await r.text();
          return res.status(r.status).json({ error: err });
        }
        return res.status(200).json({ publicUrl });
      }
      // Legacy: return URLs for client-side upload (won't work without auth)
      return res.status(200).json({ uploadUrl, publicUrl });

    } else if (action === 'set_settings') {
      r = await fetch(SUPABASE_URL + '/rest/v1/settings', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: payload.key, value: payload.value })
      });
      return res.status(r.status).end();

    } else if (action === 'get_projects') {
      // Returns all projects ordered by display_order then name
      r = await fetch(SUPABASE_URL + '/rest/v1/projects?select=*&order=display_order.asc,name.asc', { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'upsert_project') {
      // Insert a new project or update existing. payload = { project object }
      const project = { ...payload, updated_at: new Date().toISOString() };
      r = await fetch(SUPABASE_URL + '/rest/v1/projects', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(project)
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'delete_project') {
      // Soft delete via active=false. payload = { id }
      const { id } = payload;
      r = await fetch(SUPABASE_URL + '/rest/v1/projects?id=eq.' + id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ active: false, updated_at: new Date().toISOString() })
      });
      return res.status(r.status).end();

    } else if (action === 'get_rentals') {
      r = await fetch(SUPABASE_URL + '/rest/v1/rentals?select=*&order=display_order.asc,name.asc', { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'upsert_rental') {
      const rental = { ...payload, updated_at: new Date().toISOString() };
      r = await fetch(SUPABASE_URL + '/rest/v1/rentals?on_conflict=slug', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rental)
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'delete_rental') {
      const { id } = payload;
      r = await fetch(SUPABASE_URL + '/rest/v1/rentals?id=eq.' + id, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ active: false, updated_at: new Date().toISOString() })
      });
      return res.status(r.status).end();

    } else if (action === 'reset_agent_conversation') {
      // Test-mode reset: wipe all conversation state for one agent so the next
      // iteration starts from scratch (no Maya context, no template-sent flag,
      // no 24h window inheritance).
      const { agentId } = payload || {};
      if (!agentId) return res.status(400).json({ error: 'agentId required' });

      await fetch(SUPABASE_URL + '/rest/v1/wa_messages?agent_id=eq.' + agentId, {
        method: 'DELETE', headers
      });
      await fetch(SUPABASE_URL + '/rest/v1/maya_updates?agent_id=eq.' + agentId, {
        method: 'DELETE', headers
      }).catch(() => {});
      // For TEST contacts, also clear notes (which accumulate autopilot send logs).
      // For real agents, preserve notes since they may contain genuine business context.
      let isTest = false;
      try {
        const probe = await fetch(SUPABASE_URL + '/rest/v1/agents?id=eq.' + agentId + '&select=is_test', { headers });
        const probeData = await probe.json();
        isTest = probeData?.[0]?.is_test === true;
      } catch (e) { /* default false */ }

      const resetFields = {
        conversation_summary: '',
        last_inbound_at: null,
        unread_count: 0,
        suggested_reply: '',
        automation_override: null,
        last_campaign_sent: null,
        projects: {},                                     // pipeline statuses + lifecycle stages set by Maya
        samba: { status: 'Not contacted', notes: '' },    // Samba pipeline status
        campaign_engagement: null,                        // active template sequence state
        ...(isTest ? { notes: '' } : {})                  // test contacts get a fully clean slate
      };
      const r2 = await fetch(SUPABASE_URL + '/rest/v1/agents?id=eq.' + agentId, {
        method: 'PATCH', headers, body: JSON.stringify(resetFields)
      });
      if (!r2.ok) {
        const err = await r2.text();
        return res.status(r2.status).json({ error: err });
      }
      return res.status(200).json({ success: true, agentId });

    } else if (action === 'reset_all_test_conversations') {
      // Wipe every agent flagged is_test=true
      const r1 = await fetch(SUPABASE_URL + '/rest/v1/agents?is_test=eq.true&select=id,name,agency', { headers });
      const testAgents = await r1.json();
      if (!Array.isArray(testAgents) || testAgents.length === 0) {
        return res.status(200).json({ success: true, count: 0, agents: [] });
      }
      const idList = testAgents.map(a => a.id).join(',');
      await fetch(SUPABASE_URL + '/rest/v1/wa_messages?agent_id=in.(' + idList + ')', {
        method: 'DELETE', headers
      });
      await fetch(SUPABASE_URL + '/rest/v1/maya_updates?agent_id=in.(' + idList + ')', {
        method: 'DELETE', headers
      }).catch(() => {});
      await fetch(SUPABASE_URL + '/rest/v1/agents?id=in.(' + idList + ')', {
        method: 'PATCH', headers,
        body: JSON.stringify({
          conversation_summary: '',
          last_inbound_at: null,
          unread_count: 0,
          suggested_reply: '',
          automation_override: null,
          last_campaign_sent: null,
          projects: {},
          samba: { status: 'Not contacted', notes: '' },
          campaign_engagement: null,
          notes: ''                              // is_test=true agents → clear notes too
        })
      });
      return res.status(200).json({ success: true, count: testAgents.length, agents: testAgents });

    } else if (action === 'suggest_reply') {
      // Server-side reply generation that mirrors the webhook's Maya — uses live
      // projects + rentals DB, MAYA_PERSONA, anti-hallucination rules, recent
      // wa_messages thread. Replaces the old client-side suggestReply which
      // hallucinated badly (pretended to be Ikiel, used hardcoded fallback data).
      const { agentId } = payload || {};
      if (!agentId) return res.status(400).json({ error: 'agentId required' });
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

      // Load agent
      const aRes = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=*`, { headers });
      const agent = (await aRes.json())?.[0];
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Load projects + rentals
      const [pRes, rRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/rentals?select=*&active=eq.true&order=display_order.asc`, { headers })
      ]);
      const projects = await pRes.json();
      const rentals = await rRes.json();

      // Load recent thread (both directions, oldest→newest)
      const tRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?agent_id=eq.${agentId}&order=timestamp.desc&limit=30`, { headers });
      const rows = await tRes.json();
      const thread = Array.isArray(rows) ? rows.slice().reverse().map(m => {
        const t = new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });
        const sender = m.direction === 'outbound' ? 'KAYA Listings (Maya)' : 'Agent';
        return `[${t}] ${sender}: ${(m.content || '').slice(0, 200)}`;
      }).join('\n') : '';

      // Build portfolio + rentals context (simplified versions, just what's needed)
      const portfolioCtx = projects?.length > 0
        ? `KAYA SALES PORTFOLIO (live):\n${projects.map((p,i) => `${i+1}. ${p.name} -- ${p.area || ''} -- ${p.tagline || ''} -- units: ${(p.units||[]).filter(u => !u.availability || u.availability === 'Available').length} available -- commission ${p.commission_pct || 5}%`).join('\n')}`
        : FALLBACK_PORTFOLIO;
      const rentalsCtx = rentals?.length > 0
        ? `SAMBA RENTAL PORTFOLIO (live, monthly IDR only):\n${rentals.map((r,i) => {
            const rate = r.monthly_rate_idr ? `IDR ${(r.monthly_rate_idr/1e6).toFixed(0)}M/month` : 'rate TBC';
            const cap = [r.beds && `${r.beds}BR`, r.max_guests && `sleeps ${r.max_guests}`].filter(Boolean).join(', ');
            const links = [r.photos_url && `photos: ${r.photos_url}`, r.maps_url && `map: ${r.maps_url}`].filter(Boolean).join(' · ');
            return `${i+1}. ${r.name} (${r.area || '?'}) -- ${r.property_type || 'Property'}${cap ? ', ' + cap : ''} -- ${rate}${links ? ' -- ' + links : ''}`;
          }).join('\n')}\n\nSAMBA HARD RULES: Quote MONTHLY IDR only. Never nightly USD. Never invent prices, beds, locations, types. Missing field → "let me check with Ikiel". Photos → share photos_url. Location → share maps_url.`
        : '';

      // Live availability summary from the Samba portal digest (best-effort).
      let availabilityCtx = '';
      try {
        const secret = process.env.DIGEST_SHARED_SECRET;
        if (secret) {
          const dRes = await fetch('https://sambarentals.vercel.app/api/digest', { headers: { Authorization: `Bearer ${secret}` } });
          if (dRes.ok) {
            const digest = await dRes.json();
            if (digest && Array.isArray(digest.properties) && digest.properties.length) {
              const lines = digest.properties.map(p => {
                const a = p.availability || {};
                const nowState = a.availableToday ? 'available now' : 'occupied now';
                const next = a.nextAvailableFrom ? `next free ${a.nextAvailableFrom}` : 'no free day in horizon';
                const longw = a.nextLongWindowFrom ? `long-term stay window from ${a.nextLongWindowFrom}` : 'no long-term stay window';
                return `- ${p.name} — ${nowState}; ${next}; ${longw}`;
              });
              availabilityCtx = `SAMBA LIVE AVAILABILITY (real calendar data):\n${lines.join('\n')}\n\nUse this to answer availability questions directly. For a specific date range you cannot resolve from this summary, say you'll confirm the exact dates and check the portal calendar.`;
            }
          }
        }
      } catch (e) { /* availability is best-effort */ }

      // Cache the stable head (persona + portfolio + rentals + availability);
      // the volatile per-agent tail stays uncached after the breakpoint.
      const systemHead = `${MAYA_PERSONA}

${portfolioCtx}

${rentalsCtx}

${availabilityCtx}`;

      const systemRest = `This agent's context:
Name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}

Recent message thread (oldest → newest):
${thread || '(no prior history)'}

${CRM_SIGNALS_INSTRUCTIONS}

Respond with ONLY a JSON object (no markdown, no prose):
{
  "reply": "the WhatsApp reply to send (1-4 sentences typical), responding to the agent's most recent message",
  "crm_updates": [
    { "field": "contact_frequency", "value": "weekly", "reason": "agent asked for fewer messages" }
  ],
  "crm_actions": [
    { "type": "create_agent", "name": "Hikam", "wa_num": "6281234567890", "reason": "referred by this agent", "service_type": "rental", "replace": false }
  ]
}
Set "crm_updates" to an empty array if no clear pipeline / frequency / service-classification signals are present. Set "crm_actions" to an empty array unless the TEAM HANDOFF rules above apply. If the agent only said something brief like "Hi sure" or "Yes please", treat that as agreement to the most recent question you asked (look at the thread) and respond accordingly. NEVER invent context, budgets, properties, viewings, or anything not in the thread above.`;

      const system = [
        { type: 'text', text: systemHead, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemRest },
      ];

      // Evidence for the maya_updates audit log = the agent's most recent
      // inbound message (rows are newest-first from the timestamp.desc query).
      const lastInbound = Array.isArray(rows) ? rows.find(m => m.direction === 'inbound') : null;
      const evidenceQuote = (lastInbound?.content || '').slice(0, 500);

      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 700,
            system,
            messages: [{ role: 'user', content: 'Generate the reply now.' }]
          })
        });
        const data = await r.json();
        const raw = (data.content?.[0]?.text || '').trim();

        // Parse Maya's JSON contract (reply + crm_updates + crm_actions). Fall
        // back to treating the raw text as the reply if she didn't emit JSON,
        // so the console/catch-up never break on a malformed response.
        let reply = '', crmUpdates = [], crmActions = [];
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            reply = (parsed.reply || '').trim();
            if (Array.isArray(parsed.crm_updates)) crmUpdates = parsed.crm_updates;
            if (Array.isArray(parsed.crm_actions)) crmActions = parsed.crm_actions;
          } catch (_) { reply = raw; }
        } else {
          reply = raw;
        }

        // Apply the CRM changes Maya recognised — SAME helpers the webhook uses.
        // Before this, suggest_reply dropped them, so catch-up (resume_unanswered)
        // and console-drafted replies could promise "I'll stop the daily updates"
        // without ever recording the opt-out / frequency change (21 Jul 2026).
        if (crmUpdates.length) await applyCrmUpdates(SUPABASE_URL, headers, agent, crmUpdates, evidenceQuote);
        if (crmActions.length) await applyCrmActions(SUPABASE_URL, headers, agent, crmActions, evidenceQuote);

        // Real token cost (claude-sonnet-4-6: $3/M in, $15/M out) so the cron
        // charges actual dollars into daily_usage instead of a flat estimate.
        const u = data.usage || {};
        const cost_usd = (u.input_tokens || 0) * 3 / 1e6
          + (u.output_tokens || 0) * 15 / 1e6
          + (u.cache_read_input_tokens || 0) * 0.30 / 1e6
          + (u.cache_creation_input_tokens || 0) * 3.75 / 1e6;
        return res.status(200).json({ reply, cost_usd, crm_updates: crmUpdates.length, crm_actions: crmActions.length });
      } catch (e) {
        return res.status(500).json({ error: 'Claude call failed: ' + e.message });
      }

    } else if (action === 'translate') {
      // Translate one or more messages with Claude Haiku (cheap + fast). Used by
      // the chat inbox to show inbound Bahasa Indonesia in English, and to
      // translate a drafted reply. Detects source language; flags messages that
      // are already in the target so the UI can skip showing a translation.
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      const texts = Array.isArray(payload?.texts) ? payload.texts : (payload?.text != null ? [payload.text] : []);
      const target = payload?.target || 'English';
      if (!texts.length) return res.status(400).json({ error: 'text or texts required' });
      const numbered = texts.map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').slice(0, 1000)}`).join('\n');
      const system = `You are a translator. Translate each numbered message into ${target}, preserving tone and any emoji. Detect the source language. If a message is already written in ${target}, set "same" to true and return it unchanged. Respond with ONLY a JSON array — one object per input, in the same order: {"detected":"<language name>","translated":"<text>","same":<true|false>}. No commentary, no code fences.`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system, messages: [{ role: 'user', content: numbered }] })
        });
        const data = await r.json();
        let txt = (data.content?.[0]?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        let arr; try { arr = JSON.parse(txt); } catch (_) { arr = null; }
        if (!Array.isArray(arr)) arr = texts.map(t => ({ detected: 'unknown', translated: t, same: true }));
        return res.status(200).json({ results: arr });
      } catch (e) {
        return res.status(500).json({ error: 'Translate failed: ' + e.message });
      }

    } else if (action === 'push_status') {
      // Diagnostic: is push wired up? Reports (no secrets) whether the server
      // has VAPID keys, the public key's tail (to compare against the app's),
      // and how many device subscriptions are saved.
      const pub = process.env.VAPID_PUBLIC_KEY || '';
      const priv = process.env.VAPID_PRIVATE_KEY || '';
      let count = 0;
      try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.push_subscriptions&select=value', { headers });
        const row = await r.json();
        count = Array.isArray(row?.[0]?.value) ? row[0].value.length : 0;
      } catch (_) {}
      return res.status(200).json({
        vapidConfigured: !!(pub && priv),
        vapidPublicKeyTail: pub ? pub.slice(-12) : null,
        subscriptionCount: count
      });

    } else if (action === 'send_test_push') {
      // Send a test notification to every saved subscription and report the
      // per-device result (status codes surface VAPID mismatch / expiry).
      const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
      if (!pub || !priv) return res.status(400).json({ error: 'Server is missing VAPID keys (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Vercel)' });
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:ikielptito@gmail.com', pub, priv);
      let list = [];
      try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.push_subscriptions&select=value', { headers });
        const row = await r.json();
        list = Array.isArray(row?.[0]?.value) ? row[0].value : [];
      } catch (_) {}
      if (!list.length) return res.status(400).json({ error: 'No subscriptions saved yet — tap the bell to subscribe this device first' });
      const payload = JSON.stringify({ title: 'Maya', body: 'Test notification ✅', url: '/chat.html', badge_count: 1 });
      const results = await Promise.all(list.map(async s => {
        try { await webpush.sendNotification(s, payload); return { ok: true }; }
        catch (e) { return { ok: false, status: e.statusCode, error: (e.body || e.message || '').toString().slice(0, 200) }; }
      }));
      return res.status(200).json({ sent: results.filter(r => r.ok).length, total: results.length, results });

    } else if (action === 'save_push_subscription') {
      // Store a Web Push subscription for the Maya chat PWA. Subscriptions
      // live in settings.push_subscriptions (an array), deduped by endpoint so
      // re-subscribing the same device doesn't pile up. The webhook reads this
      // list to fan out push notifications on inbound agent messages.
      const sub = payload?.subscription;
      if (!sub?.endpoint) return res.status(400).json({ error: 'subscription with endpoint required' });
      const cur = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.push_subscriptions&select=value', { headers });
      const curRow = await cur.json();
      const list = Array.isArray(curRow?.[0]?.value) ? curRow[0].value : [];
      const next = list.filter(s => s.endpoint !== sub.endpoint);
      next.push(sub);
      await fetch(SUPABASE_URL + '/rest/v1/settings', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'push_subscriptions', value: next })
      });
      return res.status(200).json({ success: true, count: next.length });

    } else if (action === 'analytics') {
      // Powers the console's Analytics view: the agent-level funnel
      // (enrolled → messaged → read → replied → clicked → enquired), per-format
      // read rates, tier split, channels, opt-out, and a hot/cold agent list.
      const days = Math.min(Math.max(payload?.days || 30, 1), 90);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [outRows, inRows, agRows, statsRow] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/wa_messages?timestamp=gte.${since}&direction=eq.outbound&select=agent_id,status,category,template_name&limit=20000`, { headers }).then(r => r.json()),
        fetch(`${SUPABASE_URL}/rest/v1/wa_messages?timestamp=gte.${since}&direction=eq.inbound&select=agent_id,timestamp&limit=20000`, { headers }).then(r => r.json()),
        fetch(`${SUPABASE_URL}/rest/v1/agents?select=id,name,agency,engagement_tier,samba_alerts_opt_out,contact_frequency,last_inbound_at,is_test,campaign_engagement`, { headers }).then(r => r.json()),
        fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.agent_portal_stats&select=value`, { headers }).then(r => r.json()),
      ]);
      const out = Array.isArray(outRows) ? outRows : [];
      const inb = Array.isArray(inRows) ? inRows : [];
      const ags = Array.isArray(agRows) ? agRows : [];
      const portal = statsRow?.[0]?.value || { agents: {}, channels: {} };
      const pStats = portal.agents || {};

      const enrolled = ags.filter(a => !a.is_test && a.campaign_engagement && a.campaign_engagement.samba);
      const enrolledIds = new Set(enrolled.map(a => a.id));
      const nameOf = {}; ags.forEach(a => { nameOf[a.id] = a.name || a.agency || `#${a.id}`; });

      // Agent-level funnel (restricted to enrolled agents)
      const messaged = new Set(), readSet = new Set(), replied = new Set();
      out.forEach(m => { if (enrolledIds.has(m.agent_id)) { messaged.add(m.agent_id); if (m.status === 'read') readSet.add(m.agent_id); } });
      inb.forEach(m => { if (enrolledIds.has(m.agent_id)) replied.add(m.agent_id); });
      const clicked = Object.entries(pStats).filter(([id, v]) => v.clicks > 0 && enrolledIds.has(Number(id))).map(([id]) => Number(id));
      const enquired = Object.entries(pStats).filter(([id, v]) => v.enquiries > 0 && enrolledIds.has(Number(id))).map(([id]) => Number(id));

      // Per-format read rate
      const fmt = {};
      out.forEach(m => { const k = m.template_name || m.category || 'free-text'; const f = fmt[k] || (fmt[k] = { sent: 0, tracked: 0, read: 0 }); f.sent++; if (m.status) { f.tracked++; if (m.status === 'read') f.read++; } });
      const by_format = Object.entries(fmt).sort((a, b) => b[1].sent - a[1].sent)
        .map(([k, v]) => ({ format: k, sent: v.sent, tracked: v.tracked, read_rate: v.tracked ? Math.round(v.read / v.tracked * 100) : null }));

      const tiers = {}; let optedOut = 0;
      enrolled.forEach(a => { const t = a.engagement_tier || 'unset'; tiers[t] = (tiers[t] || 0) + 1; if (a.samba_alerts_opt_out) optedOut++; });

      // Hot/cold: enrolled agents ranked by engagement (reply recency + clicks)
      const agentRows = enrolled.map(a => {
        const p = pStats[a.id] || {};
        const daysSinceReply = a.last_inbound_at ? Math.floor((Date.now() - new Date(a.last_inbound_at).getTime()) / 86400000) : null;
        return { id: a.id, name: nameOf[a.id], tier: a.engagement_tier || 'unset', last_reply_days: daysSinceReply, clicks: p.clicks || 0, enquiries: p.enquiries || 0, read: readSet.has(a.id) };
      }).sort((x, y) => (y.clicks + y.enquiries * 3) - (x.clicks + x.enquiries * 3) || ((x.last_reply_days ?? 999) - (y.last_reply_days ?? 999)));

      return res.status(200).json({
        window_days: days,
        funnel: { enrolled: enrolled.length, messaged: messaged.size, read: readSet.size, replied: replied.size, clicked: clicked.length, enquired: enquired.length },
        by_format,
        tiers,
        opt_out: { count: optedOut, rate: enrolled.length ? +(optedOut / enrolled.length * 100).toFixed(1) : 0 },
        channels: portal.channels || {},
        portal_updated_at: portal.updated_at || null,
        top_agents: agentRows.slice(0, 25),
        outbound_total: out.length,
      });

    } else if (action === 'backfill_contacts') {
      // Scan past inbound chat history for phone numbers agents shared, and add
      // the genuine agent/partner numbers to the CRM (Maya classifies each to
      // skip clients / own numbers / noise). Dedupes by number, so it's safe to
      // run repeatedly. Pass since_days to limit the window (the cron uses this
      // as an ongoing safety-net; the console button omits it for full history).
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      const maxCandidates = Math.min(Number(payload?.limit) || 80, 120);
      const sinceDays = Number(payload?.since_days) || 0;

      // Existing agents: dedupe set + id→name + each agent's own number.
      const agRes = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id,name,agency,wa_num,wa_url&limit=5000`, { headers });
      const agents = (await agRes.json().catch(() => [])) || [];
      const existingNums = new Set();
      const nameById = {}, ownNumById = {};
      for (const a of agents) {
        nameById[a.id] = a.name || a.agency || `#${a.id}`;
        const n = normIndoMobile(a.wa_num || (a.wa_url || '').replace(/\D/g, ''));
        if (n) { existingNums.add(n); ownNumById[a.id] = n; }
      }

      // Inbound messages (optionally limited to a recent window).
      let mq = `${SUPABASE_URL}/rest/v1/wa_messages?direction=eq.inbound&select=agent_id,content,timestamp&order=timestamp.desc&limit=5000`;
      if (sinceDays > 0) mq += `&timestamp=gte.${new Date(Date.now() - sinceDays * 86400000).toISOString()}`;
      const msgs = (await (await fetch(mq, { headers })).json().catch(() => [])) || [];

      // Extract unique candidate numbers not already in the CRM.
      const candidates = new Map();
      for (const m of msgs) {
        for (const raw of extractPhoneCandidates(m.content || '')) {
          const n = normIndoMobile(raw);
          if (!n || existingNums.has(n) || ownNumById[m.agent_id] === n || candidates.has(n)) continue;
          candidates.set(n, { wa_num: n, fromAgentId: m.agent_id, fromName: nameById[m.agent_id] || 'an agent', snippet: String(m.content || '').replace(/\s+/g, ' ').slice(0, 240) });
          if (candidates.size >= maxCandidates) break;
        }
        if (candidates.size >= maxCandidates) break;
      }
      const cand = [...candidates.values()];
      if (!cand.length) return res.status(200).json({ created: 0, skipped: 0, candidates: 0, results: [] });

      // Maya classifies all candidates in one batched call.
      const list = cand.map((c, i) => `${i + 1}. number ${c.wa_num} — shared by ${c.fromName} — message: "${c.snippet}"`).join('\n');
      const system = `You are Maya, a CRM assistant for a Bali property company (Samba = monthly RENTALS; KAYA = leasehold/freehold SALES). You are reviewing phone numbers that agents shared in past WhatsApp chats, to decide which to add to the CRM as NEW agent/partner contacts we can send property listings to.
For each numbered item, decide:
- "add": true ONLY if the number belongs to a real-estate AGENT, colleague, teammate, agency, or a division/team we should contact about listings (rentals or sales). Set false for a client/guest/tenant, the sender's own number, or a random/unclear/non-property number.
- "name": a sensible contact name (person or team, e.g. "Oniriq — Long Term Rentals"); if unknown, use the sharer's agency + role.
- "service_type": "rental", "leasehold", or "both" from context; null if unclear.
Respond with ONLY a JSON array, one object per item in order: [{"i":1,"add":true,"name":"...","service_type":"rental"}]. No prose.`;
      let decisions = [];
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, system, messages: [{ role: 'user', content: `Items:\n${list}\n\nReturn the JSON array now.` }] })
        });
        const d = await r.json();
        const txt = d.content?.[0]?.text || '';
        const mm = txt.match(/\[[\s\S]*\]/);
        decisions = mm ? JSON.parse(mm[0]) : [];
      } catch (e) { return res.status(502).json({ error: 'classification failed: ' + e.message }); }
      const byI = {}; decisions.forEach(x => { if (x && x.i) byI[x.i] = x; });

      let created = 0, skipped = 0;
      const results = [];
      for (let i = 0; i < cand.length; i++) {
        const c = cand[i];
        const dec = byI[i + 1];
        if (!dec || !dec.add) { skipped++; results.push({ wa_num: c.wa_num, add: false }); continue; }
        // Final dedupe guard (numbers can repeat across messages).
        const chk = await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${c.wa_num}&select=id`, { headers }).then(r => r.json()).catch(() => []);
        if (Array.isArray(chk) && chk.length) { skipped++; results.push({ wa_num: c.wa_num, add: false, reason: 'exists' }); continue; }
        const fields = baseAgentFields({
          name: dec.name || `${c.fromName} contact`, waNum: c.wa_num,
          referrerId: c.fromAgentId, referrerName: c.fromName,
          source: 'history_backfill', reason: 'number shared in past chat',
          serviceType: ['rental', 'leasehold', 'both'].includes(dec.service_type) ? dec.service_type : null,
        });
        const cr = await createAgentRow(SUPABASE_URL, headers, fields);
        if (cr.ok) { created++; existingNums.add(c.wa_num); results.push({ wa_num: c.wa_num, add: true, id: cr.row?.id, name: dec.name }); }
        else { results.push({ wa_num: c.wa_num, add: true, error: cr.error }); }
      }
      return res.status(200).json({ created, skipped, candidates: cand.length, results });

    } else if (action === 'relink_orphan_messages') {
      // Repair for the two bugs that left inbound messages with agent_id = null
      // (invisible in the inbox even though a push fired):
      //   1. `agent?.id || null` mapped agent id 0 ("Oniriq") to null.
      //   2. A raw agent-create that failed silently for brand-new senders.
      // For every orphaned inbound message, attach it to the existing contact
      // for that number, or create the contact (self-healing) if none exists.
      // Idempotent: re-running finds nothing to do. dry_run reports without writing.
      const dryRun = !!payload?.dry_run;
      const orphRes = await fetch(
        `${SUPABASE_URL}/rest/v1/wa_messages?direction=eq.inbound&agent_id=is.null&deleted_at=is.null&select=id,wa_num,content,timestamp&order=timestamp.asc&limit=5000`,
        { headers }
      );
      const orphans = (await orphRes.json().catch(() => [])) || [];
      // Group by sender number (skip rows with no number — unrecoverable).
      const byNum = {};
      for (const m of orphans) {
        const num = String(m.wa_num || '').replace(/[^\d]/g, '');
        if (!num) continue;
        (byNum[num] = byNum[num] || []).push(m);
      }
      const report = [];
      let relinked = 0, createdContacts = 0;
      for (const [num, msgs] of Object.entries(byNum)) {
        // Existing contact for this number?
        const exRes = await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${num}&select=id,name,unread_count,last_inbound_at,conversation_history&limit=1`, { headers });
        let agentRow = (await exRes.json().catch(() => []))?.[0] || null;
        let didCreate = false;
        if (!agentRow) {
          const latest = msgs[msgs.length - 1];
          const dateStr = new Date(latest.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
          if (dryRun) {
            report.push({ wa_num: num, messages: msgs.length, action: 'would_create_and_link' });
            continue;
          }
          const cr = await createAgentRow(SUPABASE_URL, headers, {
            name: '+' + num, wa_num: num,
            unread_count: msgs.length, last_inbound_at: latest.timestamp,
            conversation_summary: `[${dateStr}] Contact recovered by orphan-message backfill: ${String(latest.content || '').slice(0, 120)}`,
            conversation_history: { first_contact: dateStr, last_contact: dateStr, total_messages: msgs.length },
          });
          if (!cr.ok) { report.push({ wa_num: num, messages: msgs.length, error: cr.error }); continue; }
          agentRow = cr.row; didCreate = true; createdContacts++;
        }
        if (!agentRow || agentRow.id == null) { report.push({ wa_num: num, messages: msgs.length, error: 'no agent id' }); continue; }
        if (dryRun) { report.push({ wa_num: num, messages: msgs.length, action: 'would_link', agent_id: agentRow.id, agent_name: agentRow.name }); continue; }
        // Attach every orphaned inbound from this number to the contact.
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_num=eq.${num}&agent_id=is.null&direction=eq.inbound`, {
          method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ agent_id: agentRow.id }),
        });
        if (!patchRes.ok) { report.push({ wa_num: num, messages: msgs.length, error: 'link failed: ' + (await patchRes.text().catch(() => '')).slice(0, 120) }); continue; }
        relinked += msgs.length;
        // For an existing contact, bump unread + last_inbound so the thread
        // resurfaces (a freshly created contact already carries these).
        if (!didCreate) {
          const latest = msgs[msgs.length - 1];
          const newUnread = (agentRow.unread_count || 0) + msgs.length;
          const lastAt = (!agentRow.last_inbound_at || new Date(latest.timestamp) > new Date(agentRow.last_inbound_at)) ? latest.timestamp : agentRow.last_inbound_at;
          await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agentRow.id}`, {
            method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ unread_count: newUnread, last_inbound_at: lastAt }),
          }).catch(() => {});
        }
        report.push({ wa_num: num, messages: msgs.length, action: didCreate ? 'created_and_linked' : 'linked', agent_id: agentRow.id, agent_name: agentRow.name });
      }
      return res.status(200).json({ dry_run: dryRun, orphans_found: orphans.length, numbers: Object.keys(byNum).length, relinked, contacts_created: createdContacts, report });

    } else if (action === 'list_listings') {
      // Portal listings as card objects, for the console "Send listing" picker.
      try {
        const cards = await fetchPortalCards();
        return res.status(200).json({ listings: cards });
      } catch (e) {
        return res.status(200).json({ listings: [], error: 'portal unreachable' });
      }

    } else if (action === 'send_listing_card') {
      // Send one property to an agent as a rich card — interactive CTA-URL
      // (hero photo + native "View listing" button, image+caption fallback),
      // logged with a [[card]] marker so the console thread renders it richly.
      const WA_TOKEN = process.env.META_WA_TOKEN;
      const WA_PHONE_ID = process.env.META_WA_PHONE_ID;
      if (!WA_TOKEN || !WA_PHONE_ID) return res.status(500).json({ ok: false, error: 'WhatsApp env not configured' });
      const { agentId, slug } = payload || {};
      if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });

      // Resolve the agent's number.
      const aRes = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=id,wa_num,wa_url`, { headers });
      const agent = (await aRes.json())?.[0];
      const waNum = String(agent?.wa_num || (agent?.wa_url || '').replace(/\D/g, '')).replace(/\D/g, '');
      if (!waNum) return res.status(400).json({ ok: false, error: 'agent has no WhatsApp number' });

      // Resolve the card.
      let card = null;
      try { card = (await resolveListingCards([slug], 1))[0] || null; }
      catch (e) { return res.status(502).json({ ok: false, error: 'portal unreachable' }); }
      if (!card) return res.status(404).json({ ok: false, error: 'listing not found' });

      const sent = await sendListingCardMessage({ PHONE_ID: WA_PHONE_ID, TOKEN: WA_TOKEN }, waNum, card);
      if (!sent.waMessageId) return res.status(502).json({ ok: false, error: sent.error || 'WhatsApp send failed' });

      // Log with a [[card]] marker so the console renders the card.
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ agent_id: agent ? agent.id : null, wa_num: waNum, direction: 'outbound', content: cardMarker(card), wa_message_id: sent.waMessageId, timestamp: new Date().toISOString(), category: 'listing_card', source: 'manual', status: 'sent' })
      }).catch(() => {});

      return res.status(200).json({ ok: true, waMessageId: sent.waMessageId, format: sent.format, card });

    } else if (action === 'resume_unanswered') {
      // Catch up on agents whose latest message is still unanswered — e.g. replies
      // that arrived while Maya was paused on the spend cap. Behaviour follows the
      // Maya automation mode, resolved per agent (automation_override, else the
      // global mode): 'autopilot'/'hybrid' → generate + SEND; 'draft' → generate
      // and save a draft for review (no send); 'off'/'paused' → skip. Respects the
      // $2 daily spend cap and skips opted-out / already-answered agents.
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      const WA_TOKEN = process.env.META_WA_TOKEN;
      const WA_PHONE_ID = process.env.META_WA_PHONE_ID;
      if (!ANTHROPIC_KEY || !WA_TOKEN || !WA_PHONE_ID) return res.status(500).json({ error: 'Maya messaging env not configured' });

      const CAP_USD = 2.00;
      const maxAgents = Math.min(Number(payload?.limit) || 60, 120);
      const sinceDays = Number(payload?.since_days) || 4;
      const sinceIso = new Date(Date.now() - sinceDays * 86400000).toISOString();
      const witaDay = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

      // Self-origin so we can reuse the suggest_reply action (same trick the cron uses).
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const selfOrigin = req.headers.host ? `${proto}://${req.headers.host}` : null;
      if (!selfOrigin) return res.status(500).json({ error: 'cannot resolve self origin' });

      // Global Maya automation mode (per-agent override wins when set).
      const mRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.automation&select=value`, { headers });
      const globalMode = (await mRes.json())?.[0]?.value?.mode || 'draft';

      // Candidates: real agents with a recent inbound still unread.
      const aRes = await fetch(`${SUPABASE_URL}/rest/v1/agents?is_test=eq.false&unread_count=gt.0&last_inbound_at=gte.${sinceIso}&select=id,name,wa_num,wa_url,automation_override,samba_alerts_opt_out&order=last_inbound_at.desc&limit=${maxAgents}`, { headers });
      let candidates = await aRes.json();
      if (!Array.isArray(candidates)) candidates = [];

      // Current spend today (shared daily_usage counter, WITA day).
      const uRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers });
      const usage = (await uRes.json())?.[0]?.value || {};
      let todaySpend = usage[witaDay] || 0;

      const results = [];
      for (const a of candidates) {
        // Resolve effective mode: per-agent override (when set) else the global mode.
        const effMode = (a.automation_override && a.automation_override !== '') ? a.automation_override : globalMode;
        if (effMode === 'off' || effMode === 'paused') { results.push({ agent: a.name || a.id, skipped: `mode_${effMode}` }); continue; }
        if (a.samba_alerts_opt_out === true) { results.push({ agent: a.name || a.id, skipped: 'opted_out' }); continue; }
        const waNum = String(a.wa_num || (a.wa_url || '').replace(/\D/g, '')).replace(/\D/g, '');
        if (!waNum) { results.push({ agent: a.name || a.id, skipped: 'no_number' }); continue; }
        if (todaySpend >= CAP_USD) { results.push({ agent: a.name || a.id, skipped: 'spend_cap' }); continue; }

        // Only answer if the LAST message is inbound (i.e. still genuinely unanswered).
        const lastRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?agent_id=eq.${a.id}&order=timestamp.desc&limit=1&select=direction`, { headers });
        const last = (await lastRes.json())?.[0];
        if (!last || last.direction !== 'inbound') {
          await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${a.id}`, { method: 'PATCH', headers, body: JSON.stringify({ unread_count: 0 }) }).catch(() => {});
          results.push({ agent: a.name || a.id, skipped: 'already_answered' });
          continue;
        }

        // Generate a fresh reply with the canonical Maya prompt.
        let reply = '', cost = 0.02;
        try {
          const sg = await fetch(`${selfOrigin}/api/supabase`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'suggest_reply', payload: { agentId: a.id } })
          });
          if (sg.ok) { const d = await sg.json(); reply = (d?.reply || '').trim(); if (typeof d?.cost_usd === 'number') cost = d.cost_usd; }
        } catch (e) { /* skip below */ }
        if (!reply || reply.startsWith('[')) { results.push({ agent: a.name || a.id, skipped: 'no_reply' }); continue; }
        todaySpend += cost;

        // Draft mode: save the reply for review, leave the thread unread. No send.
        if (effMode === 'draft') {
          await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${a.id}`, { method: 'PATCH', headers, body: JSON.stringify({ suggested_reply: reply }) }).catch(() => {});
          results.push({ agent: a.name || a.id, drafted: true });
          continue;
        }

        // Hybrid / autopilot: send via WhatsApp, clear unread + any stale draft.
        const sr = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: waNum, type: 'text', text: { body: reply } })
        });
        const sd = await sr.json().catch(() => ({}));
        if (!sr.ok) { results.push({ agent: a.name || a.id, error: sd?.error?.message || ('HTTP ' + sr.status) }); continue; }
        const waMessageId = sd.messages?.[0]?.id || null;
        await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
          method: 'POST', headers,
          body: JSON.stringify({ agent_id: a.id, wa_num: waNum, direction: 'outbound', content: reply, wa_message_id: waMessageId, timestamp: new Date().toISOString(), source: 'catchup', status: waMessageId ? 'sent' : null })
        }).catch(() => {});
        await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${a.id}`, { method: 'PATCH', headers, body: JSON.stringify({ unread_count: 0, suggested_reply: '' }) }).catch(() => {});
        results.push({ agent: a.name || a.id, sent: true });
      }

      // Persist updated spend (mirror the webhook's daily_usage upsert).
      usage[witaDay] = +todaySpend.toFixed(4);
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      Object.keys(usage).forEach(k => { if (k < cutoff) delete usage[k]; });
      await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'daily_usage', value: usage })
      }).catch(() => {});

      return res.status(200).json({
        mode: globalMode,
        sent: results.filter(r => r.sent).length,
        drafted: results.filter(r => r.drafted).length,
        considered: candidates.length,
        spend_today_usd: +todaySpend.toFixed(2),
        results,
      });

    } else if (action === 'quick_add_agent') {
      const { name, wa_num, agency, notes, service_type } = payload || {};
      if (!name || !wa_num) return res.status(400).json({ error: 'name and wa_num required' });
      const wa = String(wa_num).replace(/\D/g, '');
      if (!wa || wa.length < 9) return res.status(400).json({ error: 'valid wa_num required (digits incl. country code)' });
      const dup = await (await fetch(`${SUPABASE_URL}/rest/v1/agents?wa_num=eq.${wa}&select=id,name`, { headers })).json();
      if (Array.isArray(dup) && dup.length) return res.status(409).json({ error: `Already exists: #${dup[0].id} ${dup[0].name || ''}`.trim(), existing_agent_id: dup[0].id });
      const fields = baseAgentFields({
        name, waNum: wa, agency: agency || null, notes: notes || null,
        source: 'quick_add', reason: 'recruited via quick-add form',
        serviceType: service_type || 'rental',
      });
      // Quiet-hours guard: outside 9am-9pm WITA, hold the welcome and let the 9am
      // cron send it, so a late-night add doesn't ping the agent at 2am. Flag it
      // on the row before insert; cron-followups drains welcome_pending.
      const deferWelcome = !isWithinWitaHours();
      if (deferWelcome) {
        fields.campaign_engagement = fields.campaign_engagement || {};
        fields.campaign_engagement.samba = { ...(fields.campaign_engagement.samba || {}), welcome_pending: true };
      }
      const created = await createAgentRow(SUPABASE_URL, headers, fields);
      if (!created.ok) return res.status(500).json({ error: 'insert failed: ' + created.error });
      const row = created.row;
      let welcome_sent = false;
      const TOKEN = process.env.META_WA_TOKEN;
      const PHONE_ID = process.env.META_WA_PHONE_ID;
      if (!deferWelcome && row?.id && TOKEN && PHONE_ID) {
        try {
          const WABA_ID = process.env.META_WABA_ID;
          if (WABA_ID) {
            const tr = await fetch(`https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?fields=name,status,language,components&limit=100`, {
              headers: { 'Authorization': 'Bearer ' + TOKEN }
            });
            const td = await tr.json();
            const welcomeTpl = pickWelcomeTemplate(td.data);
            if (welcomeTpl) {
              const bodyComp = (welcomeTpl.components || []).find(c => c.type === 'BODY');
              const fName = String(name).trim().split(/\s+/)[0] || 'there';
              const components = [{ type: 'body', parameters: [{ type: 'text', text: fName }] }];
              const btnComp = (welcomeTpl.components || []).find(c => c.type === 'BUTTONS');
              const urlBtn = (btnComp?.buttons || []).find(b => b.type === 'URL' && /\{\{\d+\}\}/.test(b.url || ''));
              if (urlBtn) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '' }] });
              const sr = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messaging_product: 'whatsapp', to: wa, type: 'template',
                  template: { name: welcomeTpl.name, language: { code: welcomeTpl.language || 'en' }, components }
                })
              });
              const sd = await sr.json();
              if (sr.ok) {
                welcome_sent = true;
                const rendered = (bodyComp?.text || '').replace(/\{\{1\}\}/g, fName);
                await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
                  method: 'POST', headers,
                  body: JSON.stringify({
                    agent_id: row.id, wa_num: wa, direction: 'outbound',
                    content: rendered, wa_message_id: sd.messages?.[0]?.id,
                    timestamp: new Date().toISOString(), source: 'api',
                    category: 'onboarding', status: 'sent', template_name: welcomeTpl.name
                  })
                }).catch(() => {});
              }
            }
          }
        } catch (e) { console.warn('welcome template send failed:', e.message); }
      }
      return res.status(200).json({ success: true, agent: row, welcome_sent, welcome_deferred: deferWelcome });

    } else if (action === 'assistant') {
      // Maya's boss console — agentic tool loop over the CRM (lib/assistant.js)
      return await handleAssistant(req, res, { SUPABASE_URL, headers });

    } else if (action === 'execute_broadcast') {
      // User confirmed a pending assistant broadcast draft — deterministic send
      return await handleExecuteBroadcast(req, res, { SUPABASE_URL, headers });

    } else if (action === 'get_maya_review') {
      // Console: the weekly self-review card. Returns the pending review (if not
      // yet decided), the current approved playbook, and the metrics log.
      const env = { SUPABASE_URL, headers };
      const get = async (key) => {
        const rr = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value`, { headers });
        return (await rr.json())?.[0]?.value ?? null;
      };
      const [pending, log] = await Promise.all([get('maya_review_pending'), get('maya_review_log')]);
      const playbook = await getPlaybook(env);
      return res.status(200).json({
        pending: (pending && !pending.decided) ? pending : null,
        last_decided: (pending && pending.decided) ? { week_of: pending.week_of, decided_at: pending.decided_at } : null,
        playbook: { version: playbook.version, updated_at: playbook.updated_at,
          lessons: playbook.lessons, facts: playbook.facts },
        playbook_preview: renderPlaybookBlock(playbook),
        log: Array.isArray(log) ? log : [],
      });

    } else if (action === 'apply_maya_review') {
      // Console: Ikiel approved/rejected lessons + answered questions. This is
      // the ONLY path that changes Maya's live behaviour (merges the playbook).
      const { approve = [], reject = [], answers = {} } = payload || {};
      const out = await applyDecisions(
        { SUPABASE_URL, headers, ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY },
        { approve, reject, answers }
      );
      if (out?.error) return res.status(400).json(out);
      return res.status(200).json(out);

    } else if (action === 'remove_push_subscription') {
      const endpoint = payload?.endpoint;
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      const cur = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.push_subscriptions&select=value', { headers });
      const curRow = await cur.json();
      const list = Array.isArray(curRow?.[0]?.value) ? curRow[0].value : [];
      const next = list.filter(s => s.endpoint !== endpoint);
      await fetch(SUPABASE_URL + '/rest/v1/settings', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'push_subscriptions', value: next })
      });
      return res.status(200).json({ success: true, count: next.length });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
