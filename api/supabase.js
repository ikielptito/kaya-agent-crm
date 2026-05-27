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
      const resetFields = {
        conversation_summary: '',
        last_inbound_at: null,
        unread_count: 0,
        suggested_reply: '',
        automation_override: null,
        last_campaign_sent: null,
        projects: {},                                     // pipeline statuses + lifecycle stages set by Maya
        samba: { status: 'Not contacted', notes: '' },    // Samba pipeline status
        campaign_engagement: null                         // active template sequence state
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
          campaign_engagement: null
        })
      });
      return res.status(200).json({ success: true, count: testAgents.length, agents: testAgents });

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
