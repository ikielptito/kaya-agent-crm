// What a template send actually looks like on the recipient's phone.
//
// The sweeps used to log a bracket label ("[Housekeeping — Tropicana Valley
// - Unit B3: Regular clean]") for every template they sent, because the
// message body lives in Meta's template, not in our code. Ikiel and Era then
// saw a row that told them a template went out, not what the housekeeper
// read. Meta's template list carries the body and the buttons, so the sweep
// can fill the placeholders exactly as Meta does and log that instead.
//
// Buttons ride along as a trailing marker line the inbox knows how to draw:
//   [buttons: Sudah selesai | Besok saja | Tidak bisa]     quick replies
//   [button: Lihat detail → https://…/j/12~abc]             URL button
// One marker per message, always the last line, so a snippet that cuts the
// text short never shows half a marker.

// Meta rejects any parameter containing a newline, a tab, or four spaces;
// the sweeps flatten before sending, so the render must flatten the same
// way or the log would show a message that could not have been delivered.
export const flattenParam = (s) => String(s == null ? '' : s)
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/ {4,}/g, '   ')
  .trim();

// A compact definition from Meta's template object (or from an already
// compact {body, buttons} map entry — both shapes are accepted).
export function templateDef(t) {
  if (!t) return null;
  if (t.body != null && !t.components) {
    return { name: t.name, language: t.language, body: t.body, buttons: Array.isArray(t.buttons) ? t.buttons : [] };
  }
  const comps = Array.isArray(t.components) ? t.components : [];
  const body = comps.find(c => c.type === 'BODY')?.text || t.body || '';
  const buttons = (comps.find(c => c.type === 'BUTTONS')?.buttons || []).map(b => ({
    type: b.type === 'URL' ? 'url' : b.type === 'QUICK_REPLY' ? 'quick_reply' : String(b.type || '').toLowerCase(),
    text: b.text || '',
    url: b.url || null,
  }));
  return { name: t.name, language: t.language, body, buttons };
}

export function renderTemplate(def, params = [], { buttonSuffix = null } = {}) {
  const d = templateDef(def);
  if (!d || !d.body) return null;
  const text = d.body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v == null ? '' : flattenParam(v);
  });
  const buttons = (d.buttons || []).map(b => b.type === 'url'
    ? { ...b, url: String(b.url || '').replace(/\{\{1\}\}/, buttonSuffix || '') }
    : b);
  return { text, buttons };
}

export function buttonsMarker(buttons = []) {
  const quick = buttons.filter(b => b.type === 'quick_reply' && b.text);
  const url = buttons.find(b => b.type === 'url' && b.text);
  if (quick.length) return `[buttons: ${quick.map(b => b.text).join(' | ')}]`;
  if (url) return `[button: ${url.text} → ${url.url || ''}]`;
  return '';
}

// The wa_messages.content for a template send: the rendered body plus the
// buttons marker, or the caller's label when the template is unknown (a
// preview run, or a template Meta has not returned yet).
export function renderTemplateContent(def, params, { buttonSuffix = null, fallback = '' } = {}) {
  const r = renderTemplate(def, params, { buttonSuffix });
  if (!r) return fallback;
  const marker = buttonsMarker(r.buttons);
  return marker ? `${r.text}\n${marker}` : r.text;
}

// The inverse, for the inbox: split content into the text and its buttons.
export function parseButtonsMarker(content) {
  const s = String(content || '');
  const m = s.match(/\n?\[buttons: ([^\]]+)\]\s*$/);
  if (m) return { text: s.slice(0, m.index), buttons: m[1].split(' | ').map(t => ({ type: 'quick_reply', text: t.trim() })).filter(b => b.text) };
  const u = s.match(/\n?\[button: ([^\]→]+?) → ([^\]]*)\]\s*$/);
  if (u) return { text: s.slice(0, u.index), buttons: [{ type: 'url', text: u[1].trim(), url: u[2].trim() }] };
  return { text: s, buttons: [] };
}
