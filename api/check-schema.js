// Quick schema sanity check. Hits every table/column the app expects and
// reports which (if any) are missing. The frontend can use this to show a
// banner if the user hasn't run SCHEMA.sql yet.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
  }
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  // Probes: { name, url, missingHint }
  const probes = [
    { name: 'agents table',            url: '/rest/v1/agents?select=id&limit=1' },
    { name: 'wa_messages table',       url: '/rest/v1/wa_messages?select=id&limit=1' },
    { name: 'settings table',          url: '/rest/v1/settings?select=key&limit=1' },
    { name: 'projects table',          url: '/rest/v1/projects?select=id&limit=1' },
    { name: 'maya_updates table',      url: '/rest/v1/maya_updates?select=id&limit=1' },
    { name: 'agents.is_test column',   url: '/rest/v1/agents?select=is_test&limit=1' },
    { name: 'agents.last_inbound_at',  url: '/rest/v1/agents?select=last_inbound_at&limit=1' },
    { name: 'agents.unread_count',     url: '/rest/v1/agents?select=unread_count&limit=1' },
    { name: 'agents.suggested_reply',  url: '/rest/v1/agents?select=suggested_reply&limit=1' },
    { name: 'agents.automation_override', url: '/rest/v1/agents?select=automation_override&limit=1' },
    { name: 'projects.extended_info',  url: '/rest/v1/projects?select=extended_info&limit=1' },
    { name: 'agents.campaign_engagement',  url: '/rest/v1/agents?select=campaign_engagement&limit=1' },
    { name: 'campaigns.template_sequence', url: '/rest/v1/campaigns?select=template_sequence&limit=1' },
    { name: 'rentals table',           url: '/rest/v1/rentals?select=id&limit=1' }
  ];

  const results = [];
  const missing = [];
  for (const p of probes) {
    try {
      const r = await fetch(SUPABASE_URL + p.url, { headers });
      const ok = r.ok;
      results.push({ name: p.name, ok, status: r.status });
      if (!ok) missing.push(p.name);
    } catch (e) {
      results.push({ name: p.name, ok: false, error: e.message });
      missing.push(p.name);
    }
  }

  return res.status(200).json({
    ok: missing.length === 0,
    missing,
    results,
    fix: missing.length === 0 ? null : 'Open SCHEMA.sql in your repo, copy the entire file, and paste it into Supabase → SQL Editor → Run.'
  });
}
