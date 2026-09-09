// One tap to sign in: the samba_owner_login_link template with a one-time
// token in its URL button. The portal (sambarentals.com/portal?wa_login=…)
// routes the tap by the token's prefix: none = owner portal, d8- = the
// management cockpit, tv- = the Tropicana Valley books app.
export async function sendWaLoginLink(db, { to, tok, welcome = null }) {
  const WA_TOKEN = process.env.META_WA_TOKEN;
  const WA_PHONE_ID = process.env.META_WA_PHONE_ID;
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error('WhatsApp env not configured');
  let name = 'samba_owner_login_link', components = [
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
  ];
  if (welcome?.first && welcome?.villa) {
    try {
      const wabaId = process.env.META_WABA_ID;
      const t = await fetch(`https://graph.facebook.com/v24.0/${wabaId}/message_templates?fields=name,status&name=samba_owner_welcome_v1&limit=5`, { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
      const ok = ((await t.json()).data || []).some(x => x.name === 'samba_owner_welcome_v1' && x.status === 'APPROVED');
      if (ok) {
        name = 'samba_owner_welcome_v1';
        components = [
          { type: 'body', parameters: [{ type: 'text', text: String(welcome.first).slice(0, 40) }, { type: 'text', text: String(welcome.villa).replace(/[\r\n\t]+/g, ' ').slice(0, 60) }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
        ];
      }
    } catch { /* fall back to the sign-in template */ }
  }
  const r = await fetch(`https://graph.facebook.com/v24.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: 'en' }, components } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || 'WhatsApp send failed');
  return { message_id: d.messages?.[0]?.id || null, template: name };
}
