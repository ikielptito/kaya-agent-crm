// Telling people what changed.
//
// Ikiel's rule (6 Sep 2026): whenever a feature ships, Maya tells the
// people it affects — owners hear that they can now see housekeeping
// records, Era hears what she can now do in the chat, housekeepers hear
// about a new step. This is the one place that does it, so an announcement
// is a console action and a line in docs/handbook/changelog.md, never a
// hand-typed message that only some people get.
//
//   announce(db, wa, { audience, text, template, params, buttonParam, shown, dryRun })
//
// audience: 'era' | 'ikiel' | 'owners' | 'staff' | 'housekeepers'.
// Era and Ikiel get plain text (their window is always open). Owners get an
// approved template (their windows are shut): `template` names it, `params`
// fills it per owner with {name} and {villa} placeholders, `shown` is the
// rendered text logged on their thread. Staff get plain text when their
// window is open and are otherwise listed as skipped, so nobody is left
// thinking they were told.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { sendText } from './wa-interactive.js';
import { listStaff } from './staff.js';

const LOG_KEY = 'release_notes';
const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}
async function windowOpen(db, num) {
  const since = new Date(Date.now() - 23.5 * 3600e3).toISOString();
  const rows = await sbGet(db, `wa_messages?wa_num=eq.${num}&direction=eq.inbound&timestamp=gte.${encodeURIComponent(since)}&select=id&limit=1`);
  return !!rows.length;
}
async function log(db, entry) {
  const cur = (await getSettingValue(db, LOG_KEY).catch(() => null)) || [];
  await saveSettingValue(db, LOG_KEY, [...(Array.isArray(cur) ? cur : []), entry].slice(-100)).catch(() => {});
}

// Managed owners: every owners row whose number sits on an active statement
// group, with the group's villa name for the template.
export async function managedOwners(db) {
  const groups = await sbGet(db, 'statement_groups?active=is.true&select=key,name,owner_wa_nums,owner_names,listing_slugs');
  const owners = await sbGet(db, 'owners?select=id,name,wa_num,paused&limit=500');
  const out = [];
  for (const o of owners) {
    const n = digits(o.wa_num);
    if (!n) continue;
    const gs = groups.filter(g => (g.owner_wa_nums || []).some(x => digits(x) === n));
    if (!gs.length) continue;
    out.push({ id: o.id, name: o.name || gs[0].owner_names || 'there', wa_num: n, villa: gs.map(g => g.name).join(', '), paused: !!o.paused });
  }
  return out;
}

async function sendTemplate(wa, to, name, params, buttonParam, lang = 'en') {
  const components = [];
  if (params?.length) components.push({ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).replace(/[\r\n\t]+/g, ' ').slice(0, 120) })) });
  if (buttonParam) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonParam).slice(0, 200) }] });
  const r = await fetch(`https://graph.facebook.com/v24.0/${wa.phoneId}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: lang }, components } }),
  });
  const d = await r.json().catch(() => ({}));
  return r.ok ? (d.messages?.[0]?.id || true) : null;
}
async function logOut(db, { waNum, ownerId = null, content, mid, category }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ owner_id: ownerId, wa_num: waNum, direction: 'outbound', content: String(content).slice(0, 4000), wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'console', category, status: 'sent' }),
  }).catch(() => {});
}
const fill = (s, o) => String(s || '').replace(/\{name\}/g, (o.name || 'there').split(' ')[0]).replace(/\{villa\}/g, o.villa || 'your villa');

export async function announce(db, wa, { audience, text, template, params = [], buttonParam = null, shown = null, lang = 'en', only = null, dryRun = false } = {}) {
  const a = String(audience || '').toLowerCase();
  const results = { audience: a, sent: [], skipped: [], failed: [], dryRun };

  if (a === 'era' || a === 'ikiel') {
    const to = a === 'era' ? digits(process.env.ERA_WA_NUM || '6281246357778') : digits(process.env.OWNER_WA_NUM || '');
    if (!to || !text) throw new Error('number and text required');
    if (dryRun) results.sent.push({ to, text });
    else {
      const mid = await sendText(wa, to, text);
      if (mid) { await logOut(db, { waNum: to, content: text, mid, category: 'release_note' }); results.sent.push({ to }); }
      else results.failed.push({ to, why: 'WhatsApp refused' });
    }
  } else if (a === 'owners') {
    if (!template) throw new Error('owners need an approved template');
    const owners = (await managedOwners(db)).filter(o => !only || only.includes(o.id) || only.includes(o.wa_num));
    for (const o of owners) {
      if (o.paused) { results.skipped.push({ id: o.id, name: o.name, why: 'paused' }); continue; }
      const p = params.map(x => fill(x, o));
      const rendered = fill(shown || `[Template — ${template}]`, o);
      if (dryRun) { results.sent.push({ id: o.id, name: o.name, params: p }); continue; }
      const mid = await sendTemplate(wa, o.wa_num, template, p, buttonParam, lang).catch(() => null);
      if (mid) { await logOut(db, { waNum: o.wa_num, ownerId: o.id, content: rendered, mid, category: 'release_note' }); results.sent.push({ id: o.id, name: o.name }); }
      else results.failed.push({ id: o.id, name: o.name, why: 'WhatsApp refused (template approved?)' });
      await new Promise(r => setTimeout(r, 300));
    }
  } else if (a === 'staff' || a === 'housekeepers') {
    if (!text) throw new Error('text required');
    const people = (await listStaff(db, { active_only: true, role: a === 'housekeepers' ? 'housekeeper' : null })) || [];
    for (const p of people) {
      const to = digits(p.wa_num);
      if (!to) continue;
      if (!(await windowOpen(db, to))) { results.skipped.push({ name: p.name, why: 'window shut — tell them in person or via the onboarding template' }); continue; }
      if (dryRun) { results.sent.push({ name: p.name }); continue; }
      const mid = await sendText(wa, to, text);
      if (mid) { await logOut(db, { waNum: to, content: text, mid, category: 'release_note' }); results.sent.push({ name: p.name }); }
      else results.failed.push({ name: p.name, why: 'WhatsApp refused' });
    }
  } else throw new Error('audience must be era, ikiel, owners, staff or housekeepers');

  if (!dryRun) await log(db, { at: nowIso(), audience: a, template: template || null, text: text ? String(text).slice(0, 300) : null, sent: results.sent.length, skipped: results.skipped.length, failed: results.failed.length });
  return results;
}

// ── Send when the template is approved ──────────────────────────────
// An owner notice usually waits a day on Meta review. Queue it and the
// hourly beat sends it the first time the template shows as approved.
const QUEUE_KEY = 'whats_new_queue';
export async function enqueue(db, entry) {
  const q = (await getSettingValue(db, QUEUE_KEY).catch(() => null)) || [];
  const id = Math.random().toString(36).slice(2, 8);
  q.push({ id, at: nowIso(), ...entry });
  await saveSettingValue(db, QUEUE_KEY, q.slice(-20));
  return id;
}
export async function processQueue(db, wa, templatesMap = {}) {
  const q = (await getSettingValue(db, QUEUE_KEY).catch(() => null)) || [];
  if (!q.length) return { pending: 0 };
  const left = [], done = [];
  for (const e of q) {
    if (e.template && !templatesMap[e.template]) { left.push(e); continue; }
    try { const r = await announce(db, wa, { ...e, dryRun: false }); done.push({ id: e.id, audience: e.audience, sent: r.sent.length, failed: r.failed.length, skipped: r.skipped.length }); }
    catch (err) { left.push({ ...e, error: err.message, tries: (e.tries || 0) + 1 }); }
  }
  await saveSettingValue(db, QUEUE_KEY, left.filter(e => (e.tries || 0) < 5));
  return { pending: left.length, sent: done };
}
