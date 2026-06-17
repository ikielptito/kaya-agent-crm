import { MAYA_PERSONA, PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO } from '../lib/kb.js';
import webpush from 'web-push';

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

      const system = `${MAYA_PERSONA}

${portfolioCtx}

${rentalsCtx}

This agent's context:
Name: ${agent.name || 'unknown'}
Agency: ${agent.agency || 'independent'}

Recent message thread (oldest → newest):
${thread || '(no prior history)'}

Generate a single concise WhatsApp reply (1-4 sentences) responding to the agent's most recent message. Output ONLY the reply text — no JSON, no preamble, no quotes. If the agent only said something brief like "Hi sure" or "Yes please", treat that as agreement to the most recent question you asked (look at the thread) and respond accordingly. NEVER invent context, budgets, properties, viewings, or anything not in the thread above.`;

      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            system,
            messages: [{ role: 'user', content: 'Generate the reply now.' }]
          })
        });
        const data = await r.json();
        const reply = (data.content?.[0]?.text || '').trim();
        return res.status(200).json({ reply });
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
