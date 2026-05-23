// Fetch the list of approved WhatsApp Business templates from Meta
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

  // DEBUG mode: return env var status
  if (req.query?.debug === '1') {
    return res.status(200).json({
      META_WABA_ID_present: !!WABA_ID,
      META_WABA_ID_length: WABA_ID ? WABA_ID.length : 0,
      META_WABA_ID_value: WABA_ID ? WABA_ID.substring(0, 4) + '...' + WABA_ID.substring(WABA_ID.length - 4) : null,
      META_WA_TOKEN_present: !!TOKEN,
      META_WA_PHONE_ID_present: !!PHONE_ID,
    });
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
// trigger redeploy v3
