// WhatsApp send endpoint — multiple actions on one function to stay under
// Vercel's Hobby 12-function limit. Routes by the `action` field, or falls
// back to legacy shape detection (docUrl / useTemplate / message) for older
// callers that haven't migrated yet.
//
// Actions:
//   - 'text'     — free-form text (default for legacy callers)
//   - 'template' — pre-approved template
//   - 'document' — PDF / brochure
//   - 'image'    — inline photo with optional caption
//   - 'recall'   — attempt to delete a previously-sent message (24h window)
//   - 'edit'     — attempt to edit a previously-sent text message (15min window)
//
// All sends log to wa_messages. Recall/edit also update the existing wa_messages
// row's deleted_at / edited_at + content as appropriate. If Meta's API rejects
// the recall/edit (e.g. window expired), we STILL update local state — your CRM
// view will reflect the intent even if the agent's chat doesn't.

const GRAPH = 'https://graph.facebook.com/v19.0';

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
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'WhatsApp env vars not configured' });

  const sbHeaders = SUPABASE_URL && SUPABASE_KEY ? {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  } : null;

  const body = req.body || {};
  // Determine action — explicit action wins, otherwise infer from legacy shape
  let action = body.action;
  if (!action) {
    if (body.imageUrl) action = 'image';
    else if (body.docUrl) action = 'document';
    else if (body.useTemplate) action = 'template';
    else if (body.message) action = 'text';
  }

  try {
    if (action === 'recall')   return await handleRecall(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders);
    if (action === 'edit')     return await handleEdit(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders);
    if (action === 'image')    return await handleSend(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders, 'image');
    if (action === 'document') return await handleSend(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders, 'document');
    if (action === 'template') return await handleSend(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders, 'template');
    return await handleSend(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders, 'text');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── SEND (text / template / image / document) ────────────────────────
async function handleSend(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders, type) {
  const {
    waNum, message,
    templateName, templateParams, templateLanguage, templateBodyText,
    docUrl, docFilename,
    imageUrl,
    caption,
    agentId, campaignId
  } = body;

  if (!waNum) return res.status(400).json({ error: 'waNum is required' });

  let metaBody;
  let logContent;

  if (type === 'image') {
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required for image send' });
    metaBody = {
      messaging_product: 'whatsapp',
      to: waNum,
      type: 'image',
      image: { link: imageUrl, ...(caption ? { caption } : {}) }
    };
    logContent = `[Image]${caption ? ' ' + caption : ''}`;
  } else if (type === 'document') {
    if (!docUrl) return res.status(400).json({ error: 'docUrl is required for document send' });
    metaBody = {
      messaging_product: 'whatsapp',
      to: waNum,
      type: 'document',
      document: { link: docUrl, filename: docFilename || 'document.pdf', ...(caption ? { caption } : {}) }
    };
    logContent = `[Document: ${docFilename || 'PDF'}]${caption ? ' ' + caption : ''}`;
  } else if (type === 'template') {
    metaBody = {
      messaging_product: 'whatsapp',
      to: waNum,
      type: 'template',
      template: {
        name: templateName || 'hello_world',
        language: { code: templateLanguage || 'en_US' },
        components: templateParams && templateParams.length > 0
          ? [{ type: 'body', parameters: templateParams.map(p => ({ type: 'text', text: p })) }]
          : []
      }
    };
    logContent = templateBodyText || `[Template: ${templateName}]`;
  } else {
    if (!message) return res.status(400).json({ error: 'message is required for free-form send' });
    metaBody = { messaging_product: 'whatsapp', to: waNum, type: 'text', text: { body: message } };
    logContent = message;
  }

  const waRes = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(metaBody)
  });
  const waData = await waRes.json();
  if (!waRes.ok) {
    return res.status(waRes.status).json({ error: waData.error?.message || 'WhatsApp API error', details: waData });
  }
  const waMessageId = waData.messages?.[0]?.id;

  if (sbHeaders && waMessageId) {
    await fetch(SUPABASE_URL + '/rest/v1/wa_messages', {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({
        agent_id: agentId || null,
        wa_num: waNum,
        direction: 'outbound',
        content: logContent,
        wa_message_id: waMessageId,
        timestamp: new Date().toISOString(),
        source: 'api',
        campaign_id: campaignId || null
      })
    }).catch(e => console.warn('Failed to log outbound message:', e.message));
  }

  return res.status(200).json({ success: true, waMessageId });
}

// ── RECALL (delete a sent message) ───────────────────────────────────
// Cloud API support for delete is sparse in docs. Best-effort: attempt the
// most-likely shape; on failure (or no Meta support), still mark locally
// deleted so your CRM view is correct. The agent's chat may or may not
// reflect this — but for our own view + audit log, it's accurate.
async function handleRecall(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders) {
  const { waMessageId } = body;
  if (!waMessageId) return res.status(400).json({ error: 'waMessageId is required for recall' });

  let metaOk = false;
  let metaError = null;
  try {
    // Best-effort attempt at the Cloud API delete. If Meta updates the schema
    // we'll see the success and react; if rejected, local state still updates.
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'delete',
        message_id: waMessageId
      })
    });
    metaOk = r.ok;
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      metaError = d?.error?.message || `HTTP ${r.status}`;
    }
  } catch (e) {
    metaError = e.message;
  }

  // Local update — happens regardless of Meta result
  let localOk = false;
  if (sbHeaders && SUPABASE_URL) {
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ deleted_at: new Date().toISOString() })
    }).catch(() => null);
    localOk = !!(upRes && upRes.ok);
  }

  return res.status(200).json({ success: localOk || metaOk, meta_recalled: metaOk, local_marked: localOk, meta_error: metaError });
}

// ── EDIT (replace the text of a sent message) ────────────────────────
// Cloud API officially added text-message editing in late 2024. Best-effort
// shape based on Meta's docs. Local edit always applies.
async function handleEdit(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders) {
  const { waMessageId, newText } = body;
  if (!waMessageId) return res.status(400).json({ error: 'waMessageId is required for edit' });
  if (!newText) return res.status(400).json({ error: 'newText is required for edit' });

  let metaOk = false;
  let metaError = null;
  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'text',
        text: { body: newText },
        context: { message_id: waMessageId, is_edit: true }
      })
    });
    metaOk = r.ok;
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      metaError = d?.error?.message || `HTTP ${r.status}`;
    }
  } catch (e) {
    metaError = e.message;
  }

  let localOk = false;
  if (sbHeaders && SUPABASE_URL) {
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ content: newText, edited_at: new Date().toISOString() })
    }).catch(() => null);
    localOk = !!(upRes && upRes.ok);
  }

  return res.status(200).json({ success: localOk || metaOk, meta_edited: metaOk, local_updated: localOk, meta_error: metaError });
}
