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
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: err });
      }
      return res.status(r.status).end();

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
      const filter = agentId ? `?agent_id=eq.${agentId}&order=timestamp.desc&limit=100` : '?order=timestamp.desc&limit=200';
      r = await fetch(SUPABASE_URL + '/rest/v1/wa_messages' + filter, { headers });
      const data = await r.json();
      return res.status(r.status).json(data);

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

    } else if (action === 'get_settings') {
      r = await fetch(SUPABASE_URL + '/rest/v1/settings?key=eq.' + (payload?.key || 'automation') + '&select=value', { headers });
      const data = await r.json();
      return res.status(r.status).json(data?.[0]?.value || null);

    } else if (action === 'set_settings') {
      r = await fetch(SUPABASE_URL + '/rest/v1/settings', {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: payload.key, value: payload.value })
      });
      return res.status(r.status).end();

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
