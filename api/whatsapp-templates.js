// Fetch the list of approved WhatsApp Business templates from Meta.
// POST with { action: 'create', name, body, example } submits a new
// template for Meta review (used for the strategic broadcast templates).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TOKEN = process.env.META_WA_TOKEN;
  const PHONE_ID = process.env.META_WA_PHONE_ID;
  const WABA_ID = process.env.META_WABA_ID;

  if (!TOKEN || !PHONE_ID) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  try {
    // If WABA_ID is not set, derive it from the phone number
    let wabaId = WABA_ID;
    if (!wabaId) {
      const phoneRes = await fetch(
        `https://graph.facebook.com/v19.0/${PHONE_ID}?fields=whatsapp_business_account`,
        { headers: { 'Authorization': 'Bearer ' + TOKEN } }
      );
      const phoneData = await phoneRes.json();
      wabaId = phoneData.whatsapp_business_account?.id;
      if (!wabaId) {
        return res.status(500).json({ error: 'Could not determine WABA ID', details: phoneData });
      }
    }

    if (req.method === 'POST' && req.body?.action === 'delete') {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const dr = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + TOKEN }
      });
      const deleted = await dr.json();
      if (!dr.ok) return res.status(dr.status).json({ error: deleted.error?.message || 'template delete failed', details: deleted });
      return res.status(200).json({ success: true, name });
    }

    if (req.method === 'POST' && req.body?.action === 'create') {
      const { name, body, example, category, language, button } = req.body;
      if (!name || !body) return res.status(400).json({ error: 'name and body required' });
      if (!/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'name must be lowercase letters, digits, underscores' });
      const bodyComponent = { type: 'BODY', text: body };
      // Meta requires example values for every {{n}} placeholder.
      if (Array.isArray(example) && example.length) bodyComponent.example = { body_text: [example] };
      const components = [bodyComponent];
      // Optional dynamic URL button: fixed urlBase + {{1}} suffix (the listing
      // slug supplied per-send). exampleUrl is the full sample URL Meta reviews.
      if (button && button.urlBase) {
        components.push({
          type: 'BUTTONS',
          buttons: [{
            type: 'URL',
            text: button.text || 'View listing',
            url: button.urlBase + '{{1}}',
            example: [button.exampleUrl || (button.urlBase + 'example')]
          }]
        });
      }
      const cr = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          language: language || 'en',
          category: category || 'MARKETING',
          components
        })
      });
      const created = await cr.json();
      if (!cr.ok) return res.status(cr.status).json({ error: created.error?.message || 'template create failed', details: created });
      return res.status(200).json({ success: true, id: created.id, status: created.status, name });
    }

    const r = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`,
      { headers: { 'Authorization': 'Bearer ' + TOKEN } }
    );
    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: 'Failed to fetch templates', details: data });
    }

    // Filter to approved templates and extract useful info
    const templates = (data.data || []).map(t => {
      const bodyComponent = (t.components || []).find(c => c.type === 'BODY');
      const bodyText = bodyComponent?.text || '';
      // Count placeholders {{1}}, {{2}}, etc.
      const placeholderCount = (bodyText.match(/\{\{(\d+)\}\}/g) || []).length;
      return {
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language,
        body: bodyText,
        placeholderCount,
        components: t.components
      };
    });

    return res.status(200).json({ templates, wabaId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
