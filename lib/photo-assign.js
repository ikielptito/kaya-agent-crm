// Which photo belongs to which ticket — never guessed onto the record.
//
// On 5 Sep 2026 Ita's inspection photos were matched to her tickets by a
// vision model, and the owner's "leak" ticket ended up carrying photos of
// pool cushions. A guess that is wrong on a ticket page is worse than no
// photo. So from 6 Sep there are exactly three ways a photo reaches a
// ticket, and only the first two are automatic:
//
//   1. CERTAIN: the photo came WITH the words (a WhatsApp caption), or the
//      words were sent as a reply that quotes the photo. That photo is the
//      evidence and is attached at once.
//   2. CONFIRMED: everything else a model matches is a SUGGESTION. It is
//      kept beside the ticket, never shown to owners, and Era is sent the
//      photo with buttons — this ticket, that ticket, not a fault — or ✓/✕
//      on the Maintenance page. Her tap attaches it.
//   3. BY HAND: the cockpit's + Add photo.
//
// Quoted replies work because every stored photo is remembered by the
// WhatsApp message id it arrived in (settings.photo_by_wamid).

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { attachPhotoPaths, signPhotoUrl } from './maintenance.js';
import { sendImage, sendButtons, sendList, sendText, parseTap } from './wa-interactive.js';

const SUGG_KEY = 'maint_photo_suggestions';
const WAMID_KEY = 'photo_by_wamid';
const PENDING_KEY = 'maint_photo_pending';
const nowIso = () => new Date().toISOString();
const ERA = () => String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : [];
}

// ── Photos by the message they arrived in ───────────────────────────
export async function rememberPhoto(db, wamid, path) {
  if (!wamid || !path) return path;
  const all = (await getSettingValue(db, WAMID_KEY).catch(() => null)) || {};
  all[String(wamid)] = { path, at: nowIso() };
  const keys = Object.keys(all);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete all[k];
  await saveSettingValue(db, WAMID_KEY, all).catch(() => {});
  return path;
}
export async function photoForWamid(db, wamid) {
  if (!wamid) return null;
  const all = (await getSettingValue(db, WAMID_KEY).catch(() => null)) || {};
  return all[String(wamid)]?.path || null;
}

// ── Suggestions ─────────────────────────────────────────────────────
export async function suggestions(db, itemId = null) {
  const all = (await getSettingValue(db, SUGG_KEY).catch(() => null)) || {};
  return itemId == null ? all : (all[String(itemId)] || []);
}
export async function suggest(db, itemId, paths, { why = null, from = null } = {}) {
  const all = (await getSettingValue(db, SUGG_KEY).catch(() => null)) || {};
  const list = all[String(itemId)] || [];
  for (const p of paths) if (p && !list.some(x => x.path === p)) list.push({ path: p, at: nowIso(), why, from });
  all[String(itemId)] = list.slice(-20);
  await saveSettingValue(db, SUGG_KEY, all);
  return list.length;
}
async function dropSuggestion(db, path, { onlyItem = null } = {}) {
  const all = (await getSettingValue(db, SUGG_KEY).catch(() => null)) || {};
  for (const k of Object.keys(all)) {
    if (onlyItem != null && String(onlyItem) !== k) continue;
    all[k] = (all[k] || []).filter(x => x.path !== path);
    if (!all[k].length) delete all[k];
  }
  await saveSettingValue(db, SUGG_KEY, all);
}
// Era's yes: the photo goes on that ticket and stops being a suggestion
// anywhere else.
export async function confirmPhoto(db, itemId, path) {
  await attachPhotoPaths(db, Number(itemId), [path]);
  await dropSuggestion(db, path);
  return { ok: true };
}
export async function rejectPhoto(db, path, { itemId = null } = {}) {
  await dropSuggestion(db, path, { onlyItem: itemId });
  return { ok: true };
}
export async function suggestionUrls(db, itemId) {
  const list = await suggestions(db, itemId);
  const out = [];
  for (const s of list) { const url = await signPhotoUrl(db, s.path, 3600).catch(() => null); if (url) out.push({ path: s.path, url, why: s.why || null }); }
  return out;
}

// ── Asking the person who took the photo, one photo at a time ───────
// The housekeeper knows what she photographed; she says which report it
// belongs to. The photo itself, then buttons: up to two tickets and "not a
// fault". More than two candidates become a list. Indonesian for staff,
// English for the team. Each pending photo has a short id.
const T = {
  id: { which: (v) => `${v ? `${v} — ` : ''}foto ini untuk laporan yang mana?`, tap: (n) => `Foto ${n}: tekan laporan yang sesuai, atau "Bukan kerusakan".`, none: 'Bukan kerusakan', pick: 'Pilih laporan', keep: 'tetap di catatan pemeriksaan saja', expired: 'Pertanyaan foto itu sudah kedaluwarsa; fotonya tetap ada di catatan pemeriksaan.', rejected: 'Baik — tidak dimasukkan ke laporan mana pun.', nomatch: 'Saya tidak bisa mencocokkan pilihan itu.', attached: (id, t) => `Terima kasih, foto masuk ke laporan #${id} (${t}).` },
  en: { which: (v) => `${v ? `${v} — ` : ''}which ticket is this photo for?`, tap: (n) => `Photo ${n}: tap the ticket it shows, or "Not a fault".`, none: 'Not a fault', pick: 'Pick the ticket', keep: 'keep it on the round only', expired: 'That photo question has expired; the photos are still on the round in Records.', rejected: 'Okay — not attached to any ticket. It stays on the round.', nomatch: 'I could not match that tap to a ticket.', attached: (id, t) => `Attached to #${id} ${t}. The owner sees it on the ticket now.` },
};
export async function askReporter(db, wa, { to, lang = 'id', items, photos, villa = null }) {
  const era = String(to || ERA()).replace(/\D/g, '');
  const L = T[lang] || T.id;
  if (!wa || !items?.length || !photos?.length) return { asked: 0 };
  const pending = (await getSettingValue(db, PENDING_KEY).catch(() => null)) || {};
  let asked = 0;
  for (const path of photos.slice(0, 8)) {
    const url = await signPhotoUrl(db, path, 3600).catch(() => null);
    if (!url) continue;
    const sid = Math.random().toString(36).slice(2, 8);
    pending[sid] = { path, lang, items: items.map(i => ({ id: i.id, title: String(i.title).slice(0, 60) })), at: nowIso() };
    await sendImage(wa, era, url, L.which(villa));
    const label = (i) => `#${i.id} ${String(i.title).replace(/^(maintenance|inspection)\s*[-–:]?\s*/i, '')}`.slice(0, 20);
    if (items.length <= 2) {
      await sendButtons(wa, era, L.tap(asked + 1), [...items.map(i => ({ id: `pa:pick:${sid}.${i.id}`, title: label(i) })), { id: `pa:none:${sid}`, title: L.none }]);
    } else {
      await sendList(wa, era, { body: L.tap(asked + 1), buttonLabel: L.pick, rows: [...items.slice(0, 9).map(i => ({ id: `pa:pick:${sid}.${i.id}`, title: `#${i.id}`, description: String(i.title).slice(0, 72) })), { id: `pa:none:${sid}`, title: L.none, description: L.keep }] });
    }
    asked++;
    // On her thread in the console too, so the question is visible there.
    await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, { method: 'POST', headers: { ...db.sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ wa_num: era, direction: 'outbound', content: `[Photo ${asked} of ${Math.min(photos.length, 8)} — which report? ${items.map(i => `#${i.id}`).join(' / ')} / none]`, timestamp: nowIso(), source: 'cron', category: 'photo_assign', status: 'sent' }) }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  }
  const keys = Object.keys(pending);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete pending[k];
  await saveSettingValue(db, PENDING_KEY, pending);
  return { asked, to: era };
}
export const askEra = (db, wa, o) => askReporter(db, wa, { ...o, to: ERA(), lang: 'en' });
export async function clearPending(db) { await saveSettingValue(db, PENDING_KEY, {}); }

// Era's tap. Claims only pa:* payloads.
export async function handlePhotoTap({ db, wa, fromNum, buttonPayload }) {
  const tap = parseTap(buttonPayload);
  if (!tap || tap.domain !== 'pa') return false;
  const pending = (await getSettingValue(db, PENDING_KEY).catch(() => null)) || {};
  const [sid, itemId] = String(tap.id).split('.');
  const p = pending[sid];
  const L = T[p?.lang] || (String(fromNum).replace(/\D/g, '') === ERA() ? T.en : T.id);
  if (!p) { await sendText(wa, fromNum, L.expired); return true; }
  delete pending[sid];
  await saveSettingValue(db, PENDING_KEY, pending);
  if (tap.verb === 'none') {
    await rejectPhoto(db, p.path);
    await sendText(wa, fromNum, L.rejected);
    return true;
  }
  const it = p.items.find(i => String(i.id) === String(itemId));
  if (!it) { await sendText(wa, fromNum, L.nomatch); return true; }
  await confirmPhoto(db, it.id, p.path);
  await sendText(wa, fromNum, L.attached(it.id, it.title));
  return true;
}
