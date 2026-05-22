export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.META_WA_TOKEN;
  const PHONE_ID = process.env.META_WA_PHONE_ID;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!TOKEN || !PHONE_ID) {
    return res.status(500).json({ error: 'WhatsApp env vars not configured' });
  }

  const { waNum, message, useTemplate, templateName, templateParams, agentId, campaignId, docUrl, docFilename, caption } = req.body || {};

  if (!waNum) return res.status(400).json({ error: 'waNum is required' });

  try {
    let body;

    if (docUrl) {
      // Send a document (PDF brochure)
      body = {
        messaging_product: 'whatsapp',
        to: waNum,
        type: 'document',
        document: {
          link: docUrl,
          filename: docFilename || 'document.pdf',
          ...(caption ? { caption } : {})
        }
      };
    } else if (useTemplate) {
      // Send a pre-approved template message
      body = {
        messaging_product: 'whatsapp',
        to: waNum,
        type: 'template',
        template: {
          name: templateName || 'hello_world',
          language: { code: 'en_US' },
          components: templateParams && templateParams.length > 0 ? [{
            type: 'body',
            parameters: templateParams.map(p => ({ type: 'text', text: p }))
          }] : []
        }
      };
    } else {
      // Send a free-form text message (only works within 24h of last agent reply)
      if (!message) return res.status(400).json({ error: 'message is required for free-form send' });
      body = {
        messaging_product: 'whatsapp',
        to: waNum,
        type: 'text',
        text: { body: message }
      };
    }

    const waRes = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    const waData = await waRes.json();

    if (!waRes.ok) {
      return res.status(waRes.status).json({ error: waData.error?.message || 'WhatsApp API error', details: waData });
    }

    const waMessageId = waData.messages?.[0]?.id;

    // Log outbound message to Supabase
    if (SUPABASE_URL && SUPABASE_KEY && waMessageId) {
      const sbHeaders = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      };
      await fetch(SUPABASE_URL + '/rest/v1/wa_messages', {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agentId || null,
          wa_num: waNum,
          direction: 'outbound',
          content: docUrl ? `[Document: ${docFilename || 'PDF'}]${caption ? ' ' + caption : ''}` : (useTemplate ? `[Template: ${templateName}]` : message),
          wa_message_id: waMessageId,
          timestamp: new Date().toISOString(),
          source: 'api',
          campaign_id: campaignId || null
        })
      }).catch(e => console.warn('Failed to log outbound message:', e.message));
    }

    return res.status(200).json({ success: true, waMessageId });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
