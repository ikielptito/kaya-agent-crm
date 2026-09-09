// ── PRODUCT FEEDBACK OVER WHATSAPP ───────────────────────────────────
// Oli (Double 8) helps shape the payroll feature. He sends Maya a
// screenshot and a few words about what he'd change; this lane catches
// it before ordinary owner handling, keeps the image, and puts it on
// Ikiel's Telegram with the picture attached. Nothing here answers the
// substance — Maya acknowledges, Ikiel decides.
//
// Who: numbers in settings.product_feedback.numbers (default: Oli).
// What counts: any image from them; text that reads like a change request
// (or arrives within 15 minutes of an earlier feedback message, so the
// "screenshot first, explanation next" pattern stays together). Balance
// questions and ordinary chat fall through untouched.
// Record: settings.product_feedback_log (last 60), wa_messages category
// 'feedback', photos in the maintenance bucket under feedback/.

import { getSettingValue, saveSettingValue } from './campaigns.js';
import { postToTelegram, postTelegramPhoto } from './telegram.js';
import { uploadPhoto, signPhotoUrl } from './maintenance.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const DEFAULT_NUMBERS = ['6287832988120'];   // Oli
const DEFAULT_NAMES = { '6287832988120': 'Oli' };
const CONTINUATION_MS = 15 * 60e3;
const ACK_THROTTLE_MS = 3 * 60e3;

const CUE_RE = /\b(change|changes|feature|suggest|suggestion|idea|would be (nice|better|great|good)|could (you|we)|can (you|we)|should|instead|add|remove|improve|bug|not working|doesn'?t work|broken|confusing|hard to|easier|payroll|tab|page|button|column|table|screen|dashboard|report|layout|design|ui)\b/i;
const SUBSTANCE_RE = /balance|payout|statement|owe|paid|transfer|invoice|how much|berapa/i;

export async function feedbackConfig(db) {
  const v = (await getSettingValue(db, 'product_feedback')) || {};
  const numbers = (Array.isArray(v.numbers) && v.numbers.length ? v.numbers : DEFAULT_NUMBERS).map(n => String(n).replace(/\D/g, ''));
  return { numbers, names: { ...DEFAULT_NAMES, ...(v.names || {}) } };
}

export function looksLikeFeedback(text, { hasImage = false, continuation = false } = {}) {
  if (hasImage) return true;
  const t = String(text || '').trim();
  if (!t) return false;
  if (continuation) return !SUBSTANCE_RE.test(t) || CUE_RE.test(t);
  return CUE_RE.test(t) && !/^(what|when|how much|berapa)\b.*\?$/i.test(t);
}

async function sendText(wa, to, body) {
  if (!wa?.phoneId || !wa?.token) return null;
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    return r.ok ? ((await r.json().catch(() => ({})))?.messages?.[0]?.id || true) : null;
  } catch { return null; }
}

// Returns true when the message was consumed as feedback.
export async function handleProductFeedback({ db, wa, fromNum, text, mediaType, mediaId, caption, fetchImage, waMessageId }) {
  const num = String(fromNum || '').replace(/\D/g, '');
  const cfg = await feedbackConfig(db);
  if (!cfg.numbers.includes(num)) return false;

  const log = (await getSettingValue(db, 'product_feedback_log')) || [];
  const last = [...log].reverse().find(x => x.from_num === num);
  const continuation = !!(last && Date.now() - Date.parse(last.at) < CONTINUATION_MS);
  const hasImage = mediaType === 'image' && !!mediaId;
  const body = String(text || caption || '').trim();
  if (!looksLikeFeedback(body, { hasImage, continuation })) return false;

  const who = cfg.names[num] || `+${num}`;
  let photoPath = null, photoUrl = null;
  if (hasImage && fetchImage) {
    try {
      const img = await fetchImage(mediaId);   // { base64, contentType } or null
      if (img?.base64) {
        photoPath = await uploadPhoto(db, 'feedback', { base64: img.base64, contentType: img.contentType || 'image/jpeg' });
        photoUrl = await signPhotoUrl(db, photoPath, 7 * 86400);
      }
    } catch { /* the words still go through */ }
  }

  const entry = { at: new Date().toISOString(), from: who, from_num: num, text: body || null, photo_path: photoPath, wa_message_id: waMessageId || null };
  await saveSettingValue(db, 'product_feedback_log', [...log, entry].slice(-60));

  const head = `💡 <b>Feedback from ${who}</b>${continuation ? ' (continued)' : ''}`;
  const tail = body ? `\n${body}` : '\n(screenshot only)';
  if (photoUrl) await postTelegramPhoto(photoUrl, `${head}${tail}`).catch(() => null);
  else await postToTelegram(`${head}${tail}${photoPath ? '\n(photo saved, preview unavailable)' : ''}`).catch(() => null);

  // Log the inbound as feedback so the thread shows what happened.
  await fetch(`${db.SUPABASE_URL}/rest/v1/wa_messages`, {
    method: 'POST', headers: db.sbHeaders,
    body: JSON.stringify({ agent_id: null, wa_num: num, direction: 'inbound', content: body || (hasImage ? '[screenshot]' : ''), wa_message_id: waMessageId || null, timestamp: new Date().toISOString(), source: 'webhook', category: 'feedback', media_type: mediaType || null, media_id: mediaId || null }),
  }).catch(() => {});

  // One acknowledgement per burst, not one per screenshot.
  const lastAck = (await getSettingValue(db, 'product_feedback_ack')) || {};
  if (!lastAck[num] || Date.now() - Date.parse(lastAck[num]) > ACK_THROTTLE_MS) {
    await sendText(wa, num, hasImage && !body
      ? `Got the screenshot, ${who}. Add a line on what you'd change and I'll pass both to Ikiel together.`
      : `Got it, ${who}. Passed to Ikiel${photoPath ? ' with the screenshot' : ''}. Keep them coming.`);
    await saveSettingValue(db, 'product_feedback_ack', { ...lastAck, [num]: new Date().toISOString() });
  }
  return true;
}

// ── Feedback from an app, not a chat ─────────────────────────────────
// The Tropicana Valley Books app has a "Send feedback to Maya" button: a few
// words and up to four screenshots, already downscaled by the page. Same
// record and the same Telegram delivery as the WhatsApp lane, so Ikiel sees
// every piece of feedback in one place whichever way it came.
export async function recordAppFeedback(db, { who, text, images = [], page = null, app = 'app' } = {}) {
  const body = String(text || '').trim().slice(0, 2000);
  const pics = (Array.isArray(images) ? images : []).slice(0, 4);
  if (!body && !pics.length) throw new Error('say what you would change, or attach a screenshot');
  const paths = [], urls = [];
  for (const img of pics) {
    try {
      const path = await uploadPhoto(db, 'feedback', { base64: img.base64, contentType: img.contentType || 'image/jpeg' });
      paths.push(path);
      urls.push(await signPhotoUrl(db, path, 7 * 86400));
    } catch (e) { /* the words still go through */ }
  }
  const log = (await getSettingValue(db, 'product_feedback_log')) || [];
  const entry = { at: new Date().toISOString(), from: who || 'app', from_num: null, text: body || null, photo_path: paths[0] || null, photo_paths: paths, source: app, page: page || null };
  await saveSettingValue(db, 'product_feedback_log', [...log, entry].slice(-60));

  const head = `💡 <b>Feedback from ${who || 'the books app'}</b> · ${app}${page ? ` · ${page}` : ''}`;
  const tail = body ? `\n${body}` : '\n(screenshot only)';
  if (urls[0]) {
    await postTelegramPhoto(urls[0], `${head}${tail}`).catch(() => null);
    for (const u of urls.slice(1)) if (u) await postTelegramPhoto(u, `${head} (more)`).catch(() => null);
  } else {
    await postToTelegram(`${head}${tail}${paths.length ? '\n(photo saved, preview unavailable)' : ''}`).catch(() => null);
  }
  return { ok: true, photos: paths.length, logged_at: entry.at };
}
