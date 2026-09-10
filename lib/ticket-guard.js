// The one door a chat message passes before it can become a ticket.
//
// On 10 Sep 2026 Era wrote "Tropicana-a4 sofa zipper has been repaired" and
// Maya filed it as a NEW ticket (#29) next to the open one she meant (#28).
// Nothing was wrong with any single handler: the status lane only listened
// for a day after a nudge, and the report parser had never been told that
// finished work is not a report. The same shape of mistake was waiting in
// every place a staff message can create a record — Era's thread, the
// housekeepers' dispatcher, an owner who reports on their own unit, the
// inspection round.
//
// So the rule now lives in one place and every creator calls it:
//
//   NO TICKET IS CREATED FROM A MESSAGE UNTIL THE MESSAGE HAS BEEN RESOLVED
//   AGAINST THE OPEN TICKETS AT THAT VILLA.
//
// Three layers, cheapest first, each one enough on its own:
//   1. words   — a message that says the work is already done never creates.
//   2. overlap — a new title that shares its subject with an open ticket at
//                the same villa is treated as that ticket, not a new one.
//   3. model   — one call with the open tickets as the only vocabulary:
//                done / update / same / new. It cannot name a ticket that
//                does not exist.
//
// And one authority rule: Era and Ikiel close tickets from chat (with Undo);
// everyone else's "sudah diperbaiki" becomes a note on the ticket and a
// question to Era with buttons. A housekeeper can never close or duplicate.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { sendButtons, sendText, parseTap } from './wa-interactive.js';
import { appendThread, completeItem } from './maintenance.js';

const STRONG = process.env.MAINTENANCE_LLM_MODEL_STRONG || 'claude-sonnet-4-6';
const nowIso = () => new Date().toISOString();
const ERA = () => String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
const OWNER = () => String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
export const isTeamNumber = (num) => { const n = String(num || '').replace(/\D/g, ''); return n === ERA() || (!!OWNER() && n === OWNER()); };

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}
async function logOut(db, { waNum, content, mid }) {
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ wa_num: String(waNum).replace(/\D/g, ''), direction: 'outbound', content, wa_message_id: typeof mid === 'string' ? mid : null, timestamp: nowIso(), source: 'webhook', category: 'maintenance_staff', status: mid ? 'sent' : 'failed' }),
  }).catch(() => {});
}
async function say(db, wa, to, body, buttons = null) {
  const mid = buttons ? await sendButtons(wa, to, body, buttons) : await sendText(wa, to, body);
  await logOut(db, { waNum: to, content: body, mid });
  return mid;
}

export const placeOf = (i) => i.unit_label ? `${i.statement_groups?.name || i.group_key} (${i.unit_label})` : (i.statement_groups?.name || i.slug || i.group_key);

// ── Layer 1: words ──────────────────────────────────────────────────
// "has been repaired", "already fixed", "sudah diperbaiki", "selesai
// diganti", "this has been followed up". Past-tense completion about a
// subject — a bare "sudah"/"done" is a visit reply, claimed elsewhere, and
// "needs to be fixed" / "belum diperbaiki" is a report. Kept as a whole-
// message reading: the words must be about the thing named, not a clause.
const DONE_VERB = 'repaired|fixed|replaced|resolved|solved|completed|finished|done|installed|cleaned|sorted|handled|followed\\s+up|taken\\s+care\\s+of|dealt\\s+with|painted|serviced|unblocked|cleared|reinstalled|mended|patched';
// The Indonesian list has two kinds of word: a finished verb (diperbaiki,
// diganti) that stands on its own, and a state (nyala, dingin, jalan) that
// only counts after "sudah"/"udah"/"telah" — "lampu sudah nyala" is done,
// "lampu nyala" alone is a description.
const DONE_VERB_ID = 'diperbaiki|dibetulkan|dibenerin|diganti|dipasang|dibersihkan|dicat|diservis|dilas|dijahit|ditambal|dirapikan|selesai|beres|kelar';
const DONE_STATE_ID = 'bagus|baik|ok|oke|jalan|nyala|hidup|dingin|panas|normal|bisa|aman|lancar|berfungsi|rapi|kering|bersih';
const COMPLETION_EN = new RegExp(`\\b(has|have|had|is|are|was|were|got|been|already|now|all)\\b[^.!?\\n]{0,40}\\b(${DONE_VERB})\\b|\\b(${DONE_VERB})\\s+(already|now|yesterday|today|this\\s+morning|last\\s+night)\\b|\\b(bought|purchased|ordered)\\b[^.!?\\n]{0,30}\\b(${DONE_VERB})\\b|^\\s*(fixed|repaired|replaced|done|sorted)\\s*[:\\-–]`, 'i');
const COMPLETION_ID = new RegExp(`\\b(sudah|udah|telah|barusan|tadi|kemarin)\\b[^.!?\\n]{0,40}\\b(${DONE_VERB_ID}|${DONE_VERB})\\b|\\b(sudah|udah|telah)\\s+(${DONE_STATE_ID})\\b|\\b(${DONE_STATE_ID})\\s+lagi\\b|\\b(${DONE_VERB_ID})\\b[^.!?\\n]{0,20}\\b(sudah|udah|telah|kemarin|tadi)\\b`, 'i');
// The negations that turn a completion into a report, and the questions
// that make it a question ("has the sofa been repaired?").
const NOT_DONE = /\b(not|hasn'?t|haven'?t|isn'?t|wasn'?t|never|still\s+not|yet\s+to|belum|tidak|tdk|gak|ga|nggak|engga|blm)\b[^.!?\n]{0,25}\b(repaired|fixed|replaced|done|finished|resolved|working|diperbaiki|dibetulkan|diganti|selesai|beres|bisa|jalan|nyala|dingin)\b|\b(need|needs|perlu|harus|mesti|tolong|minta|please)\b[^.!?\n]{0,25}\b(repair|fix|replace|diperbaiki|dibetulkan|diganti|ganti|perbaiki)\b|\bnot\s+yet\b|\bbelum\b/i;
const IS_QUESTION = /\?|^\s*(has|have|had|is|are|was|were|did|does|do|can|could|will|would|apakah|apa|sudahkah|kapan|when|why|kenapa)\b/i;
export function looksLikeCompletion(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return false;
  if (NOT_DONE.test(t) || IS_QUESTION.test(t)) return false;
  return COMPLETION_EN.test(t) || COMPLETION_ID.test(t);
}

// ── Layer 2: overlap ────────────────────────────────────────────────
// The subject words of a title, with the villa names, the verbs of
// repair and the small words taken out. What remains is the thing itself:
// "sofa zipper", "shower head", "kran wastafel".
const STOP = new Set(('a an the this that these those it its is are was were be been being has have had do does did will would can could should may might ' +
  'to of at in on for from with by as and or but not no yes so if then than too very just also still already now yet please ' +
  'need needs needed repair repairs repaired fix fixed fixing fixes replace replaced replacement install installed broken damaged issue problem work done finished complete completed ' +
  'unit villa room kamar house haus canggu tropicana valley lanehaus lane saturno palem kembar clay bali samba maintenance ' +
  'di ke dari yang dan atau untuk dengan ini itu ada sudah udah telah belum tidak tdk gak ga nggak perlu harus tolong minta mohon kak bu pak mbak bli maya ' +
  'rusak perbaiki diperbaiki perbaikan ganti diganti pasang dipasang bocor lagi saja aja ya nya').split(/\s+/));
export function subjectTokens(text) {
  return new Set(String(text || '').toLowerCase()
    .replace(/[\d.,]+\s*(jt|juta|rb|ribu|k)\b/g, ' ')
    .replace(/#\s?\d+/g, ' ')
    .replace(/\b[a-z]\d{1,2}\b/g, ' ')            // a4, b3
    .replace(/[^a-zÀ-ɏ]+/g, ' ')
    .split(' ').filter(w => w.length > 2 && !STOP.has(w)));
}
// Best open ticket that shares its subject with the candidate, or null.
// Score is the overlap over the smaller subject (never below two words),
// so "sofa" against "sofa zipper" asks, and "sofa zipper" against "sofa
// zipper repair" is certain.
export function similarOpen(open, { title = '', text = '', slug = null, group_key = null } = {}, { threshold = 0.5 } = {}) {
  const mine = new Set([...subjectTokens(title), ...subjectTokens(text)]);
  if (!mine.size) return null;
  let best = null;
  for (const it of open || []) {
    if (slug && it.slug && it.slug !== slug) continue;
    if (!slug && group_key && it.group_key !== group_key) continue;
    const theirs = new Set([...subjectTokens(it.title), ...subjectTokens(it.description || '')]);
    if (!theirs.size) continue;
    const overlap = [...mine].filter(w => theirs.has(w)).length;
    if (!overlap) continue;
    const score = overlap / Math.max(Math.min(mine.size, theirs.size), 2);
    if (score >= threshold && (!best || score > best.score)) best = { item: it, score, overlap };
  }
  return best;
}

// ── The open tickets at a villa ─────────────────────────────────────
export async function openTicketsFor(db, { slug = null, group_key = null, slugs = null } = {}) {
  const where = slug ? `&slug=eq.${encodeURIComponent(slug)}`
    : slugs?.length ? `&slug=in.(${slugs.map(s => encodeURIComponent(s)).join(',')})`
    : group_key ? `&group_key=eq.${encodeURIComponent(group_key)}` : '';
  return (await sbGet(db, `maintenance_items?status=in.(new,pending_approval,approved,scheduled)${where}&select=*,statement_groups(key,name,owner_names)&order=created_at.asc&limit=50`)) || [];
}

// ── Layer 3: the model, with the open tickets as its only vocabulary ─
export async function resolveAgainstOpen({ text, open, who = 'a team member', apiKey = process.env.ANTHROPIC_API_KEY }) {
  if (!apiKey || !open?.length || !String(text || '').trim()) return null;
  const list = open.map(i => `#${i.id} | ${placeOf(i)} | ${i.status} | ${i.title}${i.description ? ` — ${String(i.description).slice(0, 120)}` : ''}`).join('\n');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: STRONG, max_tokens: 300,
        system: 'You decide whether a WhatsApp message from villa staff is about a repair ticket that already exists. You never invent tickets. Reply with ONLY JSON.',
        messages: [{ role: 'user', content:
`Open repair tickets:
${list}

Message from ${who} (English or Indonesian):
"""${String(text).slice(0, 1200)}"""

Which is it?
- "done": the message says the work on one of these tickets is finished, repaired, replaced, handled or followed up (has been repaired, sudah diperbaiki, selesai diganti).
- "update": news about one of these tickets that is not completion — a price, a date, a part on order, a detail, partly done.
- "same": it reports the same problem as one of these tickets again (a repeat or a re-send), without saying it is finished.
- "new": a different problem at the villa, not covered by any ticket.
- "none": not about a repair or fault at all.

{"relation":"done|update|same|new|none","id":<ticket number or null>,"note":"<the substance of the message, short, as written>","estimated_cost":<IDR number if a price is given, else null>,"confidence":"high|low"}` }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const out = JSON.parse(m[0]);
    const ids = new Set(open.map(i => i.id));
    const id = Number.isInteger(+out.id) && ids.has(+out.id) ? +out.id : null;
    const relation = ['done', 'update', 'same', 'new', 'none'].includes(out.relation) ? out.relation : 'new';
    return { relation: id ? relation : (relation === 'new' || relation === 'none' ? relation : 'new'), id, note: String(out.note || '').slice(0, 300), estimated_cost: out.estimated_cost != null ? Number(out.estimated_cost) || null : null, confidence: out.confidence === 'low' ? 'low' : 'high' };
  } catch { return null; }
}

// One reading of a message against the open tickets at a villa. Pure of
// side effects; the preview action calls this too.
export async function readAgainstOpen({ db, text, matched, who, apiKey, open = null }) {
  const tickets = open || await openTicketsFor(db, { slug: matched?.slug || null, group_key: matched?.slug ? null : matched?.group_key || null });
  const completion = looksLikeCompletion(text);
  if (!tickets.length) return { completion, open: [], target: null, relation: completion ? 'done' : 'new', model: null, similar: null };
  const similar = similarOpen(tickets, { text, slug: matched?.slug || null, group_key: matched?.group_key || null });
  const model = await resolveAgainstOpen({ text, open: tickets, who, apiKey }).catch(() => null);
  // Who decides: a confident model answer naming a ticket; then a confident
  // "different problem" unless the subject overlap is total (the words are
  // the ticket's own words) or the message says the work is done; then the
  // overlap; then a hesitant model answer; then the words alone.
  let target = null, relation = 'new';
  const modelNames = model?.id && model.relation !== 'new' && model.relation !== 'none';
  const modelDenies = model?.confidence === 'high' && (model.relation === 'new' || model.relation === 'none');
  if (modelNames && model.confidence === 'high') { target = tickets.find(i => i.id === model.id); relation = model.relation; }
  else if (modelDenies && !completion && !(similar && similar.score >= 1)) { relation = model.relation; }
  else if (similar) { target = similar.item; relation = completion ? 'done' : (model?.id === similar.item.id ? model.relation : 'same'); }
  else if (modelNames) { target = tickets.find(i => i.id === model.id); relation = model.relation; }
  else if (completion) relation = 'done';
  return { completion, open: tickets, target, relation, model, similar };
}

// ── Parked messages (30 min) for the team's tap answers ─────────────
const PARK_KEY = 'maint_guard_parked';
const PARK_MS = 30 * 60e3;
const sid = () => Math.random().toString(36).slice(2, 8);
async function park(db, num, entry) {
  const all = (await getSettingValue(db, PARK_KEY)) || {};
  const id = sid();
  all[num] = { ...entry, sid: id, at: Date.now() };
  await saveSettingValue(db, PARK_KEY, all);
  return id;
}
async function takePark(db, num, id) {
  const all = (await getSettingValue(db, PARK_KEY)) || {};
  const mine = all[num];
  if (!mine || mine.sid !== id || Date.now() - (mine.at || 0) > PARK_MS) return null;
  delete all[num];
  await saveSettingValue(db, PARK_KEY, all);
  return mine;
}

// Close a ticket from chat the way "#28 done" does: routine-publish a
// `new` one so the owner hears "finished", refuse one still waiting on
// the owner. Returns the read-back lines.
async function closeFromChat(db, item, { who, note }) {
  const { applyStatusActions } = await import('./maintenance-backlog-reply.js');
  return applyStatusActions(db, [{ id: item.id, action: 'done', note: note || 'done', estimated_cost: null, until: null }], [item], { who });
}
async function updateFromChat(db, item, { who, text, apiKey }) {
  const { parseStatusReply, applyStatusActions } = await import('./maintenance-backlog-reply.js');
  const parsed = await parseStatusReply(text, [item], { apiKey }).catch(() => null);
  const acts = (parsed?.actions || []).filter(a => a.id === item.id && a.action !== 'done');
  if (acts.length) return applyStatusActions(db, acts, [item], { who });
  await appendThread(db, item.id, { who, text });
  return [`📝 #${item.id} ${item.title.slice(0, 40)} → noted: ${text.slice(0, 80)}`];
}

/**
 * The guard. Called by every creator with the villa already matched and
 * the message read into candidate items. Returns { proceed: true } when a
 * new ticket is the right thing, or { proceed: false } after it has
 * answered the sender (and Era, when the sender is not the team) itself.
 */
export async function guardTicketCreate({ db, wa, fromNum, who, lang = 'en', body, matched, parsedItems = [], apiKey = process.env.ANTHROPIC_API_KEY, pre = null }) {
  const num = String(fromNum || '').replace(/\D/g, '');
  const team = isTeamNumber(num);
  const id = lang === 'id';
  const read = pre || await readAgainstOpen({ db, text: body, matched, who, apiKey });
  const { completion, target, relation, open } = read;
  const villa = matched?.unit_label ? `${matched.group?.name || matched.group_key} (${matched.unit_label})` : (matched?.group?.name || matched?.slug || matched?.group_key || 'that villa');

  // Nothing open there, and the words say the work is finished: never a
  // ticket. The team can still file it deliberately with one tap.
  if (!target && completion) {
    if (team) {
      const s = await park(db, num, { text: body, matched: { group_key: matched.group_key, slug: matched.slug || null, unit_label: matched.unit_label || null, name: matched.group?.name || null } });
      await say(db, wa, num, `That reads as finished work, and I have no open ticket for it at *${villa}*${open.length ? ` (open there: ${open.map(i => `#${i.id} ${i.title.slice(0, 30)}`).join(', ')})` : ''}. Nothing logged.\n\nIf it is a new problem, tap *File as new*; if it is work the owner should hear about as done, tap *Log as done*.`,
        [{ id: `mt:file:${s}`, title: 'File as new' }, { id: `mt:filedone:${s}`, title: 'Log as done' }, { id: `mt:drop:${s}`, title: 'Ignore' }]);
    } else {
      await say(db, wa, num, id ? `Terima kasih 🙏 Saya catat dan sampaikan ke Era.` : `Thanks, noted — I have passed it to Era.`);
      await say(db, wa, ERA(), `${who} says finished work at ${villa}, but there is no open ticket for it: "${body.slice(0, 200)}". Nothing logged.`);
    }
    return { proceed: false, read };
  }
  if (!target) return { proceed: true, read };

  // A ticket exists for it.
  const label = `#${target.id} ${target.title.slice(0, 45)}`;
  if (team) {
    if (relation === 'done') {
      const lines = await closeFromChat(db, target, { who, note: body });
      await say(db, wa, num, `Got it, ${who}. That is ${label} — ${placeOf(target)}.\n${lines.join('\n')}${lines.some(l => l.startsWith('✅')) ? '\n\nThe owner will be told it is finished. Add the final cost on the page if there is one.' : ''}`,
        lines.some(l => l.startsWith('✅')) ? [{ id: `mt:undo:${target.id}`, title: `Undo #${target.id}` }] : null);
      return { proceed: false, read };
    }
    if (relation === 'update') {
      const lines = await updateFromChat(db, target, { who, text: body, apiKey });
      await say(db, wa, num, `Applied to ${label} — ${placeOf(target)}:\n${lines.join('\n')}`);
      return { proceed: false, read };
    }
    // same / low confidence: ask, never guess a second ticket into being.
    const s = await park(db, num, { text: body, itemId: target.id, matched: { group_key: matched.group_key, slug: matched.slug || null, unit_label: matched.unit_label || null, name: matched.group?.name || null } });
    await say(db, wa, num, `There is already an open ticket for this at *${placeOf(target)}*: ${label} (${target.status.replace('_', ' ')}). I have not filed a new one.\n\nIs this news about ${label}, or a different problem?`,
      [{ id: `mt:upd:${s}`, title: `Update #${target.id}` }, { id: `mt:file:${s}`, title: 'New ticket' }, { id: `mt:drop:${s}`, title: 'Ignore' }]);
    return { proceed: false, read };
  }

  // Not the team: a note on the ticket and Era decides. Nobody but Era and
  // Ikiel closes a ticket or files a second one for the same fault.
  const verb = relation === 'done' ? 'reports it done' : relation === 'update' ? 'has news' : 'reported it again';
  await appendThread(db, target.id, { who, text: `${relation === 'done' ? 'Reported done' : relation === 'update' ? 'Update' : 'Reported again'}: ${body.slice(0, 300)}` });
  try { const { maintEvent } = await import('./events.js'); await maintEvent(db, target.id, relation === 'done' ? 'reported_done' : 'reported_again', { actor: who, payload: { text: body.slice(0, 300) } }); } catch { /* optional */ }
  await say(db, wa, num, id
    ? (relation === 'done' ? `Terima kasih 🙏 Sudah saya catat di laporan ${label} dan sampaikan ke Era untuk ditutup.` : `Terima kasih 🙏 Laporan untuk ini sudah ada (${label}); catatan Anda saya tambahkan dan Era saya ingatkan.`)
    : (relation === 'done' ? `Thanks — noted on ${label}; Era will close it.` : `Thanks — there is already a ticket for this (${label}); your note is on it and Era has been told.`));
  await say(db, wa, ERA(), `${who} ${verb} — ${label} at ${placeOf(target)}: "${body.slice(0, 200)}"${relation === 'done' ? '\n\nMark it done? The owner will be told.' : ''}`,
    relation === 'done' ? [{ id: `mt:done:${target.id}`, title: `Mark #${target.id} done` }, { id: `mt:keep:${target.id}`, title: 'Keep open' }] : null);
  return { proceed: false, read };
}

// ── Taps from the team (mt:file / mt:filedone / mt:upd / mt:drop / mt:done / mt:keep)
export async function handleTicketTap({ db, wa, fromNum, buttonPayload, who = 'Era', apiKey = process.env.ANTHROPIC_API_KEY }) {
  const tap = parseTap(buttonPayload);
  if (!tap || tap.domain !== 'mt' || tap.verb === 'undo') return false;
  const num = String(fromNum || '').replace(/\D/g, '');
  if (tap.verb === 'done' || tap.verb === 'keep') {
    const item = (await sbGet(db, `maintenance_items?id=eq.${Number(tap.id)}&select=*,statement_groups(key,name)&limit=1`))?.[0];
    if (!item) { await say(db, wa, num, `I cannot find ticket #${tap.id} any more.`); return true; }
    if (tap.verb === 'keep') { await appendThread(db, item.id, { who, text: 'Kept open after a staff "done" report' }); await say(db, wa, num, `Ok — #${item.id} stays ${item.status.replace('_', ' ')}.`); return true; }
    const lines = await closeFromChat(db, item, { who, note: 'Confirmed done after the staff report' });
    await say(db, wa, num, lines.join('\n'), lines.some(l => l.startsWith('✅')) ? [{ id: `mt:undo:${item.id}`, title: `Undo #${item.id}` }] : null);
    return true;
  }
  const parked = await takePark(db, num, tap.id);
  if (!parked) { await say(db, wa, num, 'That question has expired — send the message again and I will ask afresh.'); return true; }
  if (tap.verb === 'drop') { await say(db, wa, num, 'Ok, ignored. Nothing logged.'); return true; }
  if (tap.verb === 'upd' && parked.itemId) {
    const item = (await sbGet(db, `maintenance_items?id=eq.${Number(parked.itemId)}&select=*,statement_groups(key,name)&limit=1`))?.[0];
    if (!item) { await say(db, wa, num, `Ticket #${parked.itemId} is gone; nothing applied.`); return true; }
    const lines = looksLikeCompletion(parked.text) ? await closeFromChat(db, item, { who, note: parked.text }) : await updateFromChat(db, item, { who, text: parked.text, apiKey });
    await say(db, wa, num, lines.join('\n'), lines.some(l => l.startsWith('✅')) ? [{ id: `mt:undo:${item.id}`, title: `Undo #${item.id}` }] : null);
    return true;
  }
  if (tap.verb === 'file' || tap.verb === 'filedone') {
    const { handleStaffMaintenance } = await import('./maintenance-staff.js');
    const text = parked.matched?.slug ? `${parked.matched.slug}: ${parked.text}` : parked.text;
    const took = await handleStaffMaintenance({ db, wa, fromNum: num, text, force: true, skipGuard: true, mediaType: null, mediaId: null, waToken: process.env.META_WA_TOKEN });
    if (!took) { await say(db, wa, num, 'I could not turn that into a ticket — send it again with the villa and what is broken.'); return true; }
    if (tap.verb === 'filedone') {
      // The ticket she just filed is the newest one from her number.
      const mine = (await sbGet(db, `maintenance_items?reported_by_wa=eq.${num}&status=eq.new&select=*,statement_groups(key,name)&order=created_at.desc&limit=1`))?.[0];
      if (mine) {
        const lines = await closeFromChat(db, mine, { who, note: parked.text });
        await say(db, wa, num, lines.join('\n'), lines.some(l => l.startsWith('✅')) ? [{ id: `mt:undo:${mine.id}`, title: `Undo #${mine.id}` }] : null);
      }
    }
    return true;
  }
  return false;
}

// A roster housekeeper's or tukang's message that reads as completion, before
// the classifier: resolved against the tickets at her villas. Claims only
// when a ticket matched; otherwise the dispatcher goes on as before.
export async function handleStaffCompletion({ db, wa, fromNum, person, body, apiKey = process.env.ANTHROPIC_API_KEY }) {
  if (!looksLikeCompletion(body)) return false;
  const open = await openTicketsFor(db, { slugs: person?.slugs || [] });
  if (!open.length) return false;
  const read = await readAgainstOpen({ db, text: body, matched: null, who: person?.name || 'a housekeeper', apiKey, open });
  if (!read.target) return false;
  const matched = { group_key: read.target.group_key, slug: read.target.slug, unit_label: read.target.unit_label, group: { name: read.target.statement_groups?.name } };
  await guardTicketCreate({ db, wa, fromNum, who: person?.name || 'a housekeeper', lang: 'id', body, matched, apiKey, pre: read });
  return true;
}
