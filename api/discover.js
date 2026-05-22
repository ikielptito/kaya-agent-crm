export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return res.status(500).json({ error: 'APIFY_TOKEN env var not configured' });
  }

  const { action, payload } = req.body || {};

  try {
    let r, data;

    if (action === 'start_gmaps') {
      r = await fetch(
        `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'start_facebook') {
      r = await fetch(
        `https://api.apify.com/v2/acts/apify~facebook-groups-scraper/runs?token=${APIFY_TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'poll') {
      r = await fetch(`https://api.apify.com/v2/actor-runs/${payload.runId}?token=${APIFY_TOKEN}`);
      data = await r.json();
      return res.status(r.status).json(data);

    } else if (action === 'results') {
      const limit = payload.limit || 400;
      r = await fetch(
        `https://api.apify.com/v2/actor-runs/${payload.runId}/dataset/items?token=${APIFY_TOKEN}&limit=${limit}`
      );
      data = await r.json();
      return res.status(r.status).json(data);

    } else {
      return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
