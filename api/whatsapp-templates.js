// Fetch the list of approved WhatsApp Business templates from Meta.
// POST with { action: 'create', name, body, example } submits a new
// template for Meta review (used for the strategic broadcast templates).
import { createCarouselDigest, listingCarouselCards, buildCarouselComponents, createMediaTemplate, heroImageForSlug } from '../lib/wa-carousel.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // All mutating branches (create/delete templates, send test messages) are
  // gated behind the shared sync secret — same convention as api/supabase.js
  // sync and the portal's agent_funnel endpoint. The GET template list stays
  // open: it's read-only and the chat/CRM consoles fetch it without headers.
  // Fails closed if the secret is missing so a misconfigured deploy can never
  // expose template management or test sends.
  if (req.method === 'POST') {
    // TEMPLATE_ADMIN_SECRET is an optional second key for one-off admin
    // submissions (LISTING_SYNC_SECRET is Vercel-sensitive, so it can't be
    // retrieved for ad-hoc curl use).
    const secrets = [process.env.LISTING_SYNC_SECRET, process.env.TEMPLATE_ADMIN_SECRET].filter(Boolean);
    if (!secrets.length) return res.status(500).json({ error: 'no template auth secret configured' });
    const auth = req.headers.authorization || '';
    if (!secrets.some(s => auth === `Bearer ${s}`)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

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

    if (req.method === 'POST' && req.body?.action === 'create_media') {
      // Single-image-header strategic template (large hero + body + button).
      const { name, body, example, sampleImageUrl, buttonText } = req.body;
      if (!name || !body || !sampleImageUrl) return res.status(400).json({ error: 'name, body, sampleImageUrl required' });
      try {
        const out = await createMediaTemplate({ TOKEN, PHONE_ID, WABA_ID: wabaId }, { name, body, example, sampleImageUrl, buttonText });
        return res.status(200).json({ success: true, ...out });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'POST' && req.body?.action === 'send_test') {
      // Fire a real template to one number for visual verification. kind:
      // 'carousel' → the 6-card weekly digest; 'template' → a body+button
      // strategic template (params + optional button slug).
      const { waNum, kind, firstName, templateName, params, buttonSlug } = req.body;
      const to = String(waNum || '').replace(/\D/g, '');
      if (!to) return res.status(400).json({ error: 'waNum required' });
      const GRAPH19 = 'https://graph.facebook.com/v19.0';
      let template;
      if (kind === 'carousel') {
        const cards = await listingCarouselCards();
        if (!cards) return res.status(400).json({ error: 'not enough portal listings with cover photos for a full carousel' });
        template = { name: 'samba_weekly_carousel_v1', language: { code: 'en' }, components: buildCarouselComponents(firstName || 'there', cards) };
      } else {
        const comps = [];
        // Image header — resolve the villa's portal cover from its slug (only
        // for templates that actually declare an image header).
        if (req.body.imageHeader && buttonSlug) {
          const hero = await heroImageForSlug(buttonSlug);
          if (hero) comps.push({ type: 'header', parameters: [{ type: 'image', image: { link: hero } }] });
        }
        comps.push({ type: 'body', parameters: (params || []).map(p => ({ type: 'text', text: String(p) })) });
        if (buttonSlug) comps.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonSlug }] });
        template = { name: templateName, language: { code: 'en' }, components: comps };
      }
      const sr = await fetch(`${GRAPH19}/${PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template })
      });
      const sd = await sr.json();
      if (!sr.ok) return res.status(sr.status).json({ error: sd?.error?.message || 'send failed', details: sd?.error });
      return res.status(200).json({ success: true, to, kind: kind || 'template', messageId: sd.messages?.[0]?.id });
    }

    if (req.method === 'POST' && req.body?.action === 'create_carousel') {
      // Submit the weekly carousel digest template (Resumable Upload for the
      // example image handled server-side). sampleImageUrl seeds the example.
      const { name, sampleImageUrl } = req.body;
      if (!name || !sampleImageUrl) return res.status(400).json({ error: 'name and sampleImageUrl required' });
      try {
        const out = await createCarouselDigest({ TOKEN, PHONE_ID, WABA_ID: wabaId }, { name, sampleImageUrl });
        return res.status(200).json({ success: true, ...out });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (req.method === 'POST' && req.body?.action === 'edit') {
      // Edit an APPROVED template's body in place. Meta keeps serving the
      // current version until the edit is re-approved, so this is safe to run
      // live. Requires the template id — look it up by name.
      const { name, body, example, language } = req.body;
      if (!name || !body) return res.status(400).json({ error: 'name and body required' });
      const lookup = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=id,name,language&name=${encodeURIComponent(name)}&limit=20`, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      const found = (await lookup.json())?.data || [];
      const target = found.find(t => !language || t.language === language) || found[0];
      if (!target?.id) return res.status(404).json({ error: `template "${name}" not found` });
      const bodyComponent = { type: 'BODY', text: body };
      if (Array.isArray(example) && example.length) bodyComponent.example = { body_text: [example] };
      const er = await fetch(`https://graph.facebook.com/v19.0/${target.id}`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ components: [bodyComponent] })
      });
      const edited = await er.json();
      if (!er.ok) return res.status(er.status).json({ error: edited.error?.message || 'template edit failed', details: edited });
      return res.status(200).json({ success: true, id: target.id, name });
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
      // Optional quick-reply buttons: array of label strings. Tapping one sends
      // an inbound button event the webhook maps to a preference change.
      if (Array.isArray(req.body.quickReplies) && req.body.quickReplies.length) {
        components.push({
          type: 'BUTTONS',
          buttons: req.body.quickReplies.slice(0, 3).map(text => ({ type: 'QUICK_REPLY', text }))
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

    // One-shot test send of the weekly owner report. Body: { action:'send_report_test',
    // tests:[{ to, slug, name }] }. Fetches each listing's live report, fills the
    // approved samba_owner_weekly_report template (+ signed report-link button),
    // and sends. Fails per-item if the template isn't approved yet — everything
    // else (report fetch, token) still reports so the pipeline is verifiable.
    if (req.method === 'POST' && req.body?.action === 'send_report_test') {
      const tests = Array.isArray(req.body.tests) ? req.body.tests : [];
      if (!tests.length) return res.status(400).json({ error: 'tests[] required' });
      const secret = process.env.LISTING_SYNC_SECRET;
      const results = [];
      for (const t of tests) {
        const to = String(t.to || '').replace(/\D/g, '');
        const slug = String(t.slug || '');
        if (!to || !slug) { results.push({ to: t.to, slug, ok: false, error: 'missing to/slug' }); continue; }
        let d;
        try {
          const rr = await fetch(`https://sambarentals.com/api/portal?action=report&slug=${encodeURIComponent(slug)}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
          if (!rr.ok) { results.push({ to, slug, ok: false, error: `report HTTP ${rr.status}` }); continue; }
          d = await rr.json();
        } catch (e) { results.push({ to, slug, ok: false, error: 'report fetch: ' + e.message }); continue; }
        const name = String(t.name || d.ownerName || 'there').split(/\s+/)[0];
        const week = fmtReportWeek(d.week);
        const views = String(d.metrics?.views?.now ?? 0);
        const enq = String(d.metrics?.enquiries?.now ?? 0);
        const tok = mkReportToken(slug);
        const send = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to, type: 'template',
            template: {
              name: 'samba_owner_weekly_report', language: { code: 'en' },
              components: [
                { type: 'body', parameters: [name, week, views, enq].map(x => ({ type: 'text', text: String(x) })) },
                { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
              ],
            },
          }),
        });
        const sd = await send.json().catch(() => ({}));
        results.push({ to, slug, name, ok: send.ok, id: sd?.messages?.[0]?.id, reportUrl: `https://sambarentals.com/r/${tok}`, error: send.ok ? undefined : (sd?.error?.message || `send HTTP ${send.status}`) });
      }
      return res.status(200).json({ results });
    }

    const r = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=name,status,category,language,components,quality_score&limit=100`,
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
        // Meta's health signal for the template: GREEN (high) / YELLOW / RED,
        // driven by agent blocks + reports. RED risks the template being paused.
        quality: t.quality_score?.score || null,
        components: t.components
      };
    });

    return res.status(200).json({ templates, wabaId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Signed report token — MUST match api/portal.js verifyReportToken (same
// LISTING_SYNC_SECRET, HMAC-SHA256, first 16 hex chars).
function mkReportToken(slug) {
  const sig = crypto.createHmac('sha256', process.env.LISTING_SYNC_SECRET || '').update(String(slug)).digest('hex').slice(0, 16);
  return `${slug}~${sig}`;
}
function fmtReportWeek(week) {
  if (!week?.from || !week?.to) return 'this week';
  const f = new Date(week.from + 'T00:00:00Z'), t = new Date(week.to + 'T00:00:00Z');
  return `${f.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' })}–${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
}
