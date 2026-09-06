// Native WhatsApp controls, so a person taps instead of types.
//
// Three shapes the Cloud API offers without a template:
//   buttons  up to 3 reply buttons under a text (titles ≤ 20 chars)
//   list     a "pick one" sheet: up to 10 rows across sections (row titles
//            ≤ 24 chars, descriptions ≤ 72), opened by one button (≤ 20)
//   text     plain
//
// A tap comes back through the webhook as interactive.button_reply or
// interactive.list_reply carrying our id and the visible title. Ids follow
// <domain>:<verb>:<id> — "mt:undo:17", "villa:pick:haus-1", "team:yes:abc" —
// so a handler matches on its prefix and never on the wording.
//
// Every send falls back to plain text (with a numbered list where a list
// was meant) when the shape would be rejected: the message must never be
// lost to a formatting rule. Returns the message id, or null.

const GRAPH = 'https://graph.facebook.com/v24.0';

export const LIMITS = { buttons: 3, buttonTitle: 20, listRows: 10, rowTitle: 24, rowDesc: 72, body: 1024, listBody: 4096, sectionTitle: 24 };

const clip = (s, n) => { const t = String(s == null ? '' : s).trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function post(wa, payload) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn('wa send refused:', JSON.stringify(d).slice(0, 200)); return null; }
    return d.messages?.[0]?.id || true;
  } catch (e) { console.warn('wa send failed:', e.message); return null; }
}

export async function sendText(wa, to, body, { quoteId = null } = {}) {
  return post(wa, { to, type: 'text', text: { body: String(body || '').slice(0, 4096) }, ...(quoteId ? { context: { message_id: quoteId } } : {}) });
}

// Pure: the shape Meta gets, or null when buttons cannot be used.
export function buttonsPayload(to, body, buttons) {
  const btns = (buttons || []).map(b => typeof b === 'string' ? { id: b, title: b } : b)
    .map(b => ({ id: clip(b.id, 256), title: clip(b.title, LIMITS.buttonTitle) }))
    .filter(b => b.id && b.title).slice(0, LIMITS.buttons);
  const text = String(body || '').trim();
  if (!btns.length || !text || text.length > LIMITS.body) return null;
  return { to, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: btns.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } };
}

export async function sendButtons(wa, to, body, buttons, { quoteId = null } = {}) {
  const payload = buttonsPayload(to, body, buttons);
  if (!payload) return sendText(wa, to, body, { quoteId });
  if (quoteId) payload.context = { message_id: quoteId };
  const mid = await post(wa, payload);
  return mid || sendText(wa, to, body, { quoteId });
}

// Pure: the list shape, or null when it cannot be a list. sections may be
// omitted by passing rows directly.
export function listPayload(to, { body, buttonLabel = 'Pilih', header = null, footer = null, sections = null, rows = null }) {
  const secs = (sections || [{ title: '', rows: rows || [] }]).map(s => ({
    title: clip(s.title || '', LIMITS.sectionTitle),
    rows: (s.rows || []).map(r => ({ id: clip(r.id, 200), title: clip(r.title, LIMITS.rowTitle), description: r.description ? clip(r.description, LIMITS.rowDesc) : undefined })).filter(r => r.id && r.title),
  })).filter(s => s.rows.length);
  const total = secs.reduce((n, s) => n + s.rows.length, 0);
  const text = String(body || '').trim();
  if (!total || total > LIMITS.listRows || !text || text.length > LIMITS.listBody) return null;
  const interactive = {
    type: 'list',
    body: { text },
    action: { button: clip(buttonLabel, LIMITS.buttonTitle) || 'Pilih', sections: secs.map(s => ({ ...(s.title ? { title: s.title } : {}), rows: s.rows.map(r => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) })) },
  };
  if (header) interactive.header = { type: 'text', text: clip(header, 60) };
  if (footer) interactive.footer = { text: clip(footer, 60) };
  return { to, type: 'interactive', interactive };
}

// The fallback when a list cannot be sent: the same choices, numbered.
export function listAsText({ body, sections = null, rows = null }) {
  const all = (sections || [{ rows: rows || [] }]).flatMap(s => s.rows || []);
  return `${String(body || '').trim()}\n\n${all.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n')}\n\nReply with the number.`;
}

export async function sendList(wa, to, opts) {
  const payload = listPayload(to, opts);
  if (!payload) return sendText(wa, to, listAsText(opts));
  const mid = await post(wa, payload);
  return mid || sendText(wa, to, listAsText(opts));
}

// A tapped id, split. "mt:undo:17" → { domain:'mt', verb:'undo', id:'17' }.
export function parseTap(payload) {
  const m = String(payload || '').match(/^([a-z]+):([a-z_]+):(.+)$/);
  return m ? { domain: m[1], verb: m[2], id: m[3] } : null;
}
