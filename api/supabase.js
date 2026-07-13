import { MAYA_PERSONA, PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO } from '../lib/kb.js';
import { handleAssistant, handleExecuteBroadcast } from '../lib/assistant.js';
import { syncRental } from '../lib/rental-sync.js';
import webpush from 'web-push';

// Property listings (portal) → card objects for the console listing picker and
// send-as-card flow. Each card: { slug, title, subtitle, image, url, badge }.
const LISTINGS_PORTAL = 'https://sambarentals.com';
function coverPhotoUrl(id) { return id ? `https://lh3.googleusercontent.com/d/${id}=w1600` : null; }
async function fetchPortalCards() {
  const r = await fetch(`${LISTINGS_PORTAL}/api/listings`);
  let listings = await r.json();
  if (!Array.isArray(listings)) listings = listings.listings || [];
  return listings
    .filter(l => l && l.slug && l.coverPhotoId && !l.isHidden)
    .map(l => {
      const rate = l.monthly ? `${l.monthly}/mo` : 'Monthly rental';
      const subtitle = [rate, l.unitType, l.location].filter(Boolean).join(' · ');
      return { slug: l.slug, title: l.name || l.slug, subtitle, image: coverPhotoUrl(l.coverPhotoId), url: `${LISTINGS_PORTAL}/?property=${l.slug}`, badge: l.badge || null };
    });
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
      r = await fetch(SUPABASE_URL + '/rest/v1/agents', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      const data = await r.json();
      return res.status(200).json(data);

    } else if (action === 'patch_agent') {
      const { id, fields } = payload;
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

Generate a single concise WhatsApp reply (1-4 sentences) responding to the agent's most recent message. Output ONLY the reply text — no JSON, no preamble, no quotes. If the agent only said something brief like "Hi sure" or "Yes please", treat that as agreement to the most recent question you asked (look at the thread) and respond accordingly. NEVER invent context, budgets, properties, viewings, or anything not in the thread above.`;

      const system = [
        { type: 'text', text: systemHead, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: systemRest },
      ];

      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system,
            messages: [{ role: 'user', content: 'Generate the reply now.' }]
          })
        });
        const data = await r.json();
        const reply = (data.content?.[0]?.text || '').trim();
        // Real token cost (claude-sonnet-4-6: $3/M in, $15/M out) so the cron
        // charges actual dollars into daily_usage instead of a flat estimate.
        const u = data.usage || {};
        const cost_usd = (u.input_tokens || 0) * 3 / 1e6
          + (u.output_tokens || 0) * 15 / 1e6
          + (u.cache_read_input_tokens || 0) * 0.30 / 1e6
          + (u.cache_creation_input_tokens || 0) * 3.75 / 1e6;
        return res.status(200).json({ reply, cost_usd });
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

    } else if (action === 'list_listings') {
      // Portal listings as card objects, for the console "Send listing" picker.
      try {
        const cards = await fetchPortalCards();
        return res.status(200).json({ listings: cards });
      } catch (e) {
        return res.status(200).json({ listings: [], error: 'portal unreachable' });
      }

    } else if (action === 'send_listing_card') {
      // Send one property to an agent as a rich card: a WhatsApp image (hero
      // photo) + caption (name, detail, link), logged with a [[card]] marker so
      // the console thread renders it as a card rather than a bare URL.
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
      let cards = [];
      try { cards = await fetchPortalCards(); } catch (e) { return res.status(502).json({ ok: false, error: 'portal unreachable' }); }
      const card = cards.find(c => c.slug === slug);
      if (!card) return res.status(404).json({ ok: false, error: 'listing not found' });
      if (!card.image) return res.status(422).json({ ok: false, error: 'listing has no photo' });

      // Send the hero image + caption via WhatsApp.
      const captionLines = [`*${card.title}*`, card.subtitle, '', card.url].filter(v => v !== undefined && v !== null);
      const caption = captionLines.join('\n');
      const wr = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: waNum, type: 'image', image: { link: card.image, caption } })
      });
      const wd = await wr.json().catch(() => ({}));
      if (!wr.ok) return res.status(wr.status).json({ ok: false, error: wd?.error?.message || `WhatsApp HTTP ${wr.status}` });
      const waMessageId = wd.messages?.[0]?.id || null;

      // Log with a [[card]] marker so the console renders the card.
      const marker = '[[card]]' + JSON.stringify({ title: card.title, subtitle: card.subtitle, image: card.image, url: card.url, badge: card.badge });
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ agent_id: agent?.id || null, wa_num: waNum, direction: 'outbound', content: marker, wa_message_id: waMessageId, timestamp: new Date().toISOString(), source: 'manual', status: waMessageId ? 'sent' : null })
      }).catch(() => {});

      return res.status(200).json({ ok: true, waMessageId, card });

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

    } else if (action === 'assistant') {
      // Maya's boss console — agentic tool loop over the CRM (lib/assistant.js)
      return await handleAssistant(req, res, { SUPABASE_URL, headers });

    } else if (action === 'execute_broadcast') {
      // User confirmed a pending assistant broadcast draft — deterministic send
      return await handleExecuteBroadcast(req, res, { SUPABASE_URL, headers });

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
