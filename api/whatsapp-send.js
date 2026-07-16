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
//   - 'cards'    — rich listing cards (cta_url with native View-listing button)
//   - 'recall'   — attempt to delete a previously-sent message (24h window)
//   - 'edit'     — attempt to edit a previously-sent text message (15min window)
//   - 'fetch_media' — proxy an inbound WhatsApp media id through to a temp signed URL
//
// All sends log to wa_messages. Recall/edit also update the existing wa_messages
// row's deleted_at / edited_at + content as appropriate. If Meta's API rejects
// the recall/edit (e.g. window expired), we STILL update local state — your CRM
// view will reflect the intent even if the agent's chat doesn't.

import { resolveListingCards, sendListingCardMessage, cardMarker } from '../lib/listing-cards.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // fetch_media supports GET too so <img src="/api/whatsapp-send?fetch_media=ID"> works
  if (req.method === 'GET' && req.query?.fetch_media) {
    return await handleFetchMedia(req, res, req.query.fetch_media, process.env.META_WA_TOKEN);
  }
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
    if (action === 'fetch_media') return await handleFetchMedia(req, res, body.mediaId, TOKEN);
    if (action === 'cards')    return await handleCards(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders);
    if (action === 'reaction') return await handleReaction(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders);
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
    agentId, campaignId,
    replyTo,            // wa_message_id this send quotes (reply context), optional
    source,             // 'manual' when a human sends from the chat inbox; defaults to 'api'
  } = body;

  if (!waNum) return res.status(400).json({ error: 'waNum is required' });

  // Reply context — quote a prior message. Templates can't carry context.
  const ctx = replyTo ? { context: { message_id: replyTo } } : {};

  let metaBody;
  let logContent;

  if (type === 'image') {
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required for image send' });
    metaBody = {
      messaging_product: 'whatsapp',
      to: waNum,
      type: 'image',
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
      ...ctx
    };
    logContent = `[Image]${caption ? ' ' + caption : ''}`;
  } else if (type === 'document') {
    if (!docUrl) return res.status(400).json({ error: 'docUrl is required for document send' });
    metaBody = {
      messaging_product: 'whatsapp',
      to: waNum,
      type: 'document',
      document: { link: docUrl, filename: docFilename || 'document.pdf', ...(caption ? { caption } : {}) },
      ...ctx
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
    metaBody = { messaging_product: 'whatsapp', to: waNum, type: 'text', text: { body: message }, ...ctx };
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
        source: source === 'manual' ? 'manual' : 'api',
        campaign_id: campaignId || null,
        reply_to: replyTo || null,
        status: 'sent',
        template_name: type === 'template' ? (templateName || null) : null,
        // Persist the media URL so the inbox renders sent images inline and sent
        // documents (e.g. a signed agreement) as a tappable card, not plain text.
        media_type: (type === 'image' || type === 'document') ? type : null,
        media_id: type === 'image' ? (imageUrl || null) : (type === 'document' ? (docUrl || null) : null)
      })
    }).catch(e => console.warn('Failed to log outbound message:', e.message));
  }

  return res.status(200).json({ success: true, waMessageId });
}

// ── CARDS (rich listing cards, e.g. attached to an approved Maya draft) ──
// body: { waNum, agentId, slugs: ['villa-saturno', ...], source }
// Each slug is sent as an interactive CTA-URL card (hero photo + native
// "View listing" button) and logged with a [[card]] marker for the inbox.
async function handleCards(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders) {
  const { waNum, agentId, slugs, source } = body;
  if (!waNum) return res.status(400).json({ error: 'waNum is required' });
  if (!Array.isArray(slugs) || !slugs.length) return res.status(400).json({ error: 'slugs array is required' });

  let cards = [];
  try { cards = await resolveListingCards(slugs, 4); }
  catch (e) { return res.status(502).json({ error: 'portal unreachable: ' + e.message }); }
  if (!cards.length) return res.status(404).json({ error: 'no listings matched those slugs' });

  const sent = [];
  const failed = [];
  for (const card of cards) {
    const r = await sendListingCardMessage({ PHONE_ID, TOKEN }, waNum, card);
    if (!r.waMessageId) { failed.push({ slug: card.slug, error: r.error }); continue; }
    sent.push({ slug: card.slug, waMessageId: r.waMessageId, format: r.format });
    if (sbHeaders) {
      await fetch(SUPABASE_URL + '/rest/v1/wa_messages', {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          agent_id: agentId || null, wa_num: waNum, direction: 'outbound',
          content: cardMarker(card), wa_message_id: r.waMessageId,
          timestamp: new Date().toISOString(),
          source: source === 'manual' ? 'manual' : 'api', status: 'sent'
        })
      }).catch(e => console.warn('card log failed:', e.message));
    }
  }
  return res.status(200).json({ success: sent.length > 0, sent, failed });
}

// ── FETCH_MEDIA (proxy WhatsApp media id → temp signed URL) ─────────
// WhatsApp Cloud API requires bearer auth to fetch media URLs, and the URLs
// expire in ~5min. The inbox loads images via <img src="...?fetch_media=ID">,
// we resolve the signed URL server-side then stream the bytes back so the
// browser sees a normal image response (cacheable, embeddable, no auth flow).
async function handleFetchMedia(req, res, mediaId, TOKEN) {
  if (!mediaId) return res.status(400).json({ error: 'mediaId is required' });
  if (!TOKEN) return res.status(500).json({ error: 'META_WA_TOKEN not configured' });
  try {
    // Step 1: get the temp signed URL + mime type
    const metaRes = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
      headers: { 'Authorization': 'Bearer ' + TOKEN },
    });
    if (!metaRes.ok) {
      const d = await metaRes.json().catch(() => ({}));
      return res.status(metaRes.status).json({ error: d.error?.message || 'media lookup failed' });
    }
    const meta = await metaRes.json();
    if (!meta.url) return res.status(404).json({ error: 'media url missing' });

    // Step 2: stream the bytes through. Meta requires the same bearer token
    // to fetch the actual file, so we have to proxy rather than redirect.
    const fileRes = await fetch(meta.url, {
      headers: { 'Authorization': 'Bearer ' + TOKEN },
    });
    if (!fileRes.ok) return res.status(fileRes.status).json({ error: 'media fetch failed' });

    res.setHeader('Content-Type', meta.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buf = Buffer.from(await fileRes.arrayBuffer());
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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

// ── REACTION (react to an agent's message with an emoji) ─────────────
// Send empty emoji to remove the reaction. We store it on the target row's
// `reaction` column — the same column the webhook uses for agent reactions,
// since a message carries at most one displayed reaction.
async function handleReaction(req, res, body, TOKEN, PHONE_ID, SUPABASE_URL, sbHeaders) {
  const { waNum, waMessageId, emoji } = body;
  if (!waNum || !waMessageId) return res.status(400).json({ error: 'waNum and waMessageId are required' });

  const waRes = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: waNum, type: 'reaction',
      reaction: { message_id: waMessageId, emoji: emoji || '' }
    })
  });
  const waData = await waRes.json();
  if (!waRes.ok) {
    return res.status(waRes.status).json({ error: waData.error?.message || 'WhatsApp API error', details: waData });
  }

  if (sbHeaders && SUPABASE_URL) {
    await fetch(`${SUPABASE_URL}/rest/v1/wa_messages?wa_message_id=eq.${encodeURIComponent(waMessageId)}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ reaction: emoji || null })
    }).catch(() => {});
  }
  return res.status(200).json({ success: true });
}
