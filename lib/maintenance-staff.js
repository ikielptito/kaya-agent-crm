// Era's side of the maintenance loop, over WhatsApp.
//
// Two things arrive from her number (and from any cleaner listed in
// maintenance_reporters):
//
//   A NEW REPORT — usually a photo with "Haus unit 1 bathroom wall needs
//   paint touch up". Filed as an item, photo saved, confirmed back to her.
//   Extra photos sent within a few minutes attach to the same item, because
//   people send three pictures of one broken chair.
//
//   A REPLY TO A NUDGE — "done", "next tuesday", "waiting for the part".
//   Closes the item, or moves the next nudge to the day she named.
//
// Everything else she sends falls through untouched to the existing team
// handling: this module only claims a message when it is confident, so her
// ordinary chat with the team is never swallowed by a work-order robot.

import { matchProperty, createItem, savePhoto, savePendingPhoto, attachPhotoPaths, detachPhotoPaths, readPhotoBase64, completeItem, snoozeItem, appendThread, isReporter } from './maintenance.js';
import { looksLikeMaintenance, extractReports, parseStaffReply, classifyPhoto } from './maintenance-intake.js';
import { getSettingValue, saveSettingValue } from './campaigns.js';
import { sendList, parseTap } from './wa-interactive.js';
import { rememberPhoto, photoForWamid, suggest, askReporter } from './photo-assign.js';
import { realText } from './staff-lang.js';
import * as photoStore from './photos.js';
import { maintEvent } from './events.js';

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const BURST_MS = 6 * 60 * 1000;        // extra photos within 6 min = same issue

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

// Logged to wa_messages since 7 Sep 2026: Gede was asked "which villa?"
// and nobody but Gede could see that he had been.
let _logDb = null;
export function bindLog(db) { _logDb = db; }
async function sendText(wa, to, body) {
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    const d = r.ok ? await r.json().catch(() => ({})) : {};
    const mid = d.messages?.[0]?.id || null;
    if (_logDb) {
      await fetch(`${_logDb.SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: { ..._logDb.sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ wa_num: String(to).replace(/\D/g, ''), direction: 'outbound', content: body, wa_message_id: mid, timestamp: new Date().toISOString(), source: 'webhook', category: 'maintenance_staff', status: r.ok ? 'sent' : 'failed' }),
      }).catch(() => {});
    }
    return r.ok ? (mid || true) : null;
  } catch { return null; }
}

// Meta media id → base64, so the photo can live in our own storage rather
// than behind a URL that expires in five minutes. Exported for the
// inspection intake, which stores the same kind of photo under its own
// prefix rather than against a work order.
export async function fetchMediaBase64(mediaId, token) {
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const mime = meta.mime_type || '';
    if (!meta.url || !/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) return null;
    const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!bin.ok) return null;
    const buf = Buffer.from(await bin.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    return { mime, base64: buf.toString('base64') };
  } catch { return null; }
}

const placeOf = (item, group) =>
  item.unit_label ? `${group?.name || item.group_key} (${item.unit_label})` : (group?.name || item.group_key);

// Items Maya is currently chasing this person about.
async function openItems(db) {
  return (await sbGet(db, `maintenance_items?status=in.(approved,scheduled)&select=*,statement_groups(key,name)&order=updated_at.desc&limit=10`)) || [];
}

// The item a photo-burst or a bare reply most plausibly belongs to.
async function recentItemFrom(db, waNum) {
  const since = new Date(Date.now() - BURST_MS).toISOString();
  const rows = await sbGet(db, `maintenance_items?reported_by_wa=eq.${encodeURIComponent(waNum)}&created_at=gte.${encodeURIComponent(since)}&select=*&order=created_at.desc&limit=1`);
  return rows?.[0] || null;
}

// ── Parked photos ───────────────────────────────────────────────────
// Photos that arrived before we knew which villa they were about. Held for
// half an hour and attached to the next ticket this person creates.
const PARK_KEY = 'maintenance_pending_photos';
const PHOTOQ_KEY = 'maintenance_photo_question';   // photos Maya couldn't place
const PARK_MS = 30 * 60 * 1000;

async function parkPhoto(db, waNum, path) {
  const all = (await getSettingValue(db, PARK_KEY)) || {};
  const mine = (all[waNum] || []).filter(p => Date.now() - (p.at || 0) < PARK_MS);
  mine.push({ path, at: Date.now() });
  all[waNum] = mine.slice(-8);
  await saveSettingValue(db, PARK_KEY, all);
  return mine.length;
}
async function takeParkedPhotos(db, waNum) {
  const all = (await getSettingValue(db, PARK_KEY)) || {};
  const mine = (all[waNum] || []).filter(p => Date.now() - (p.at || 0) < PARK_MS);
  if (!mine.length) return [];
  delete all[waNum];
  await saveSettingValue(db, PARK_KEY, all);
  return mine.map(p => p.path);
}
async function peekParked(db, waNum) {
  const all = (await getSettingValue(db, PARK_KEY)) || {};
  return (all[waNum] || []).filter(p => Date.now() - (p.at || 0) < PARK_MS).length;
}

// WhatsApp delivers a burst of messages at once and Vercel runs each in its
// own lambda, so "have I already asked?" cannot be answered by reading a
// row — every copy reads the same answer before any of them writes. This
// claims a 5-minute slot atomically: settings.key is a primary key, so
// exactly one insert wins and the rest are ignored.
async function claimAskLock(db, waNum) {
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: { ...db.sbHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ key: `maintask:${waNum}:${bucket}`, value: { at: Date.now() } }),
    });
    if (!r.ok) return true;                    // lock unavailable → still speak
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  } catch { return true; }
}

// Tickets this person created moments ago — a photo that lands after them
// (or out of order) belongs to those, not to a new report.
async function recentItemsFrom(db, waNum) {
  const since = new Date(Date.now() - BURST_MS).toISOString();
  return (await sbGet(db, `maintenance_items?reported_by_wa=eq.${encodeURIComponent(waNum)}&created_at=gte.${encodeURIComponent(since)}&select=id,title&order=created_at.desc&limit=5`)) || [];
}

/**
 * @returns {boolean} true when this message was consumed as maintenance.
 */
// "Which one is it?" — the report waits here (30 min) until she picks.
const AMBIG_KEY = 'maint_ambiguous';
const AMBIG_MS = 30 * 60 * 1000;
async function parkAmbiguous(db, waNum, { body, options }) {
  const all = (await getSettingValue(db, AMBIG_KEY)) || {};
  all[waNum] = { body, options, at: Date.now() };
  await saveSettingValue(db, AMBIG_KEY, all);
}
// Her pick: a list tap (villa:pick:<slug>), the name or slug typed, or the
// row number. Returns { option, body } and clears the parked report.
async function takeAmbiguous(db, waNum, { body, buttonPayload }) {
  const all = (await getSettingValue(db, AMBIG_KEY)) || {};
  const mine = all[waNum];
  if (!mine || Date.now() - (mine.at || 0) > AMBIG_MS) return null;
  const opts = mine.options || [];
  const tap = parseTap(buttonPayload);
  const t = String(body || '').trim().toLowerCase();
  let option = null;
  if (tap?.domain === 'villa' && tap.verb === 'pick') option = opts.find(o => o.slug === tap.id) || null;
  if (!option && /^\d{1,2}$/.test(t)) option = opts[Number(t) - 1] || null;
  if (!option && t) option = opts.find(o => (o.slug && t.includes(o.slug)) || (o.name && t.includes(String(o.name).toLowerCase()))) || null;
  if (!option) return null;
  delete all[waNum];
  await saveSettingValue(db, AMBIG_KEY, all);
  return { option, body: mine.body };
}

// A housekeeper's own units, when the general matcher finds nothing: "b3"
// from Gede can only be Tropicana B3, and a photo from someone who covers a
// single villa is a photo of that villa. Returns the matcher's shape.
export async function matchOwnUnit(db, text, staffSlugs = []) {
  const mine = (staffSlugs || []).filter(Boolean);
  if (!mine.length) return null;
  const { resolveUnits } = await import('./housekeeping-schedule.js');
  let hits = resolveUnits(text, mine);
  if (!hits.length && mine.length === 1 && !/\b[a-z]\d\b|\bunit\b/i.test(String(text || ''))) hits = mine;
  if (hits.length !== 1) return null;
  const slug = hits[0];
  const groups = (await sbGet(db, 'statement_groups?active=is.true&select=key,name,listing_slugs,owner_names')) || [];
  const g = groups.find(x => (x.listing_slugs || []).includes(slug));
  if (!g) return null;
  return { score: 100, group_key: g.key, slug, unit_label: slug, group: g };
}

export async function handleStaffMaintenance({ db, wa, fromNum, text, mediaType, mediaId, waToken, force = false, buttonPayload = null, waMessageId = null, replyTo = null, staffSlugs = null }) {
  const reporter = await isReporter(db, fromNum);
  // Era and Ikiel are always allowed, even before anyone seeds the reporters
  // table — they are the two people certain to be reporting issues on day one.
  const me = String(fromNum).replace(/\D/g, '');
  const eraNum = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  const ownerNum = String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
  const allowed = reporter || me === eraNum || (ownerNum && me === ownerNum);
  if (!allowed) return false;

  // A captionless image reaches us with the sales-side placeholder as its
  // text; that is a prompt for Maya, not a report. Until 8 Sep 2026 it was
  // parsed as one, so a bare photo from a single-villa housekeeper became a
  // ticket with a model-invented title.
  let body = realText(text);
  const hasImage = mediaType === 'image' && !!mediaId;
  const reporterName = reporter?.name || (ownerNum && me === ownerNum ? 'Ikiel' : 'Era');
  const inId = !!staffSlugs;   // roster staff read Indonesian

  // The answer to "which villa is it?": the parked report resumes with the
  // villa named unambiguously in front of her original words.
  const picked = await takeAmbiguous(db, me, { body, buttonPayload }).catch(() => null);
  if (picked) {
    body = `${picked.option.slug || picked.option.name}: ${picked.body}`;
    force = true;
  }

  // ── A photo with no new description, moments after a report: same issue
  if (hasImage && body.length < 12) {
    const recent = await recentItemFrom(db, fromNum);
    if (recent) {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media) await savePhoto(db, recent.id, { base64: media.base64, contentType: media.mime }).catch(() => {});
      return true;   // silent: she's mid-burst, another "logged ✅" would be noise
    }
  }

  // ── Is she answering "which job is that photo of?" ────────────────
  // Only a text reply, and only within half an hour of the question.
  if (!hasImage && body) {
    const qAll = (await getSettingValue(db, PHOTOQ_KEY)) || {};
    const q = qAll[me];
    if (q && Date.now() - (q.at || 0) < PARK_MS && (q.items || []).length > 1) {
      const words = new Set(body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2));
      const scored = q.items.map(it => ({
        it,
        hits: it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
          .filter(w => w.length > 2 && words.has(w)).length,
      })).sort((a, b) => b.hits - a.hits);
      // One title matched her words and the others didn't — that's an answer.
      if (scored[0].hits > 0 && scored[0].hits > (scored[1]?.hits || 0)) {
        const keep = scored[0].it;
        for (const other of q.items) {
          if (other.id !== keep.id) await detachPhotoPaths(db, other.id, q.paths).catch(() => {});
        }
        await attachPhotoPaths(db, keep.id, q.paths).catch(() => {});
        delete qAll[me];
        await saveSettingValue(db, PHOTOQ_KEY, qAll).catch(() => {});
        await sendText(wa, fromNum, `👍 Moved ${q.paths.length > 1 ? 'those photos' : 'that photo'} to *${keep.title}* only.`);
        return true;
      }
    }
  }

  // ── Is she answering a nudge? ─────────────────────────────────────
  // Only when there's no photo and no fresh property mention, so a genuine
  // new report is never mistaken for an answer about an old one.
  if (!hasImage && body) {
    const open = await openItems(db);
    const chased = open.filter(i => (i.followup_count || 0) > 0);
    if (chased.length) {
      const propHit = await matchProperty(db, body);
      const looksNew = propHit && (force || looksLikeMaintenance(body, false));
      if (!looksNew) {
        // Which item? The one she names, else the only one being chased.
        let target = null;
        if (propHit) {
          target = chased.find(i => i.group_key === propHit.group_key && (!propHit.slug || i.slug === propHit.slug)) || null;
        }
        if (!target && chased.length === 1) target = chased[0];

        if (target) {
          const parsed = await parseStaffReply(body, { itemTitle: target.title });
          const g = target.statement_groups;
          if (parsed.intent === 'done') {
            await completeItem(db, target.id, { note: parsed.summary || body, by: reporterName });
            await sendText(wa, fromNum, `✅ Marked done: ${target.title} — ${placeOf(target, g)}.\nI'll let the owner know.`);
            return true;
          }
          if (parsed.intent === 'scheduled' && parsed.date) {
            await snoozeItem(db, target.id, { untilDate: parsed.date, note: body, who: reporterName });
            const nice = new Date(`${parsed.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
            await sendText(wa, fromNum, `Got it — ${target.title} by ${nice}. I'll check back then. 👍`);
            return true;
          }
          if (parsed.intent === 'blocked') {
            await snoozeItem(db, target.id, { note: body, who: reporterName });
            await sendText(wa, fromNum, `Noted: ${parsed.summary || 'waiting on something'}. I'll check again in a few days.`);
            return true;
          }
          // Anything else is context worth keeping, but not an instruction.
          await appendThread(db, target.id, { who: reporterName, text: body });
          return false;
        }
        if (chased.length > 1 && /^\s*(done|finished|selesai|sudah|beres)\b/i.test(body)) {
          const list = chased.slice(0, 5).map((i, n) => `${n + 1}. ${i.title} — ${placeOf(i, i.statement_groups)}`).join('\n');
          await sendText(wa, fromNum, `Which one is finished?\n\n${list}\n\nReply with the number or the villa name.`);
          return true;
        }
      }
    }
  }

  // ── The answer to "which villa?" after a parked photo ─────────────
  // Era on 7 Sep 2026: a photo captioned "Replace the pan.", then "Unit 2
  // haus canggu", then "Estimate price: 250,000" — three messages, one
  // report. The villa line alone is not a report by vocabulary, but with a
  // photo parked minutes ago it is the missing half of one.
  if (!hasImage && body && !force) {
    const parkedRows = await photoStore.parked(db, me).catch(() => []);
    const legacyParked = await peekParked(db, me).catch(() => 0);
    if (parkedRows.length || legacyParked) {
      const where = (staffSlugs ? await matchOwnUnit(db, body, staffSlugs).catch(() => null) : null) || await matchProperty(db, body);
      if (where && !where.ambiguous) {
        const captions = parkedRows.map(r => r.caption).filter(Boolean);
        const said = captions.length ? captions.join('; ') : null;
        if (!looksLikeMaintenance(body, false) && said) body = `${body}: ${said}`;
        else if (!looksLikeMaintenance(body, false)) body = `${body}: ${inId ? 'lihat foto' : 'see photo'}`;
        force = true;
      }
    }
  }

  // ── A new report ──────────────────────────────────────────────────
  // `force` is the second pass: the vocabulary gate declined, but a model
  // read the message and thought it WAS a report. See couldBeMaintenance.
  if (!force && !hasImage && !looksLikeMaintenance(body, false)) return false;

  // Her own villas first: "A4" from Ita can only be Tropicana A4, and the
  // general matcher must not get a chance to read it as anything else.
  let matched = staffSlugs ? await matchOwnUnit(db, body, staffSlugs).catch(() => null) : null;
  if (!matched) matched = await matchProperty(db, body);
  if (!matched) {
    if (!hasImage) return false;
    const media = await fetchMediaBase64(mediaId, waToken);

    // The description may already have been processed — WhatsApp sends the
    // burst at once and the lambdas finish in any order. If tickets exist
    // from moments ago, this photo belongs to them.
    const recent = await recentItemsFrom(db, me);
    if (recent.length === 1 && media) {
      const path = await savePhoto(db, recent[0].id, { base64: media.base64, contentType: media.mime }).catch(() => null);
      if (path) { await photoStore.remember(db, { path, wamid: waMessageId, waNum: me, staffId: reporter?.staff?.id ?? null, caption: body || null, source: 'maintenance', status: 'attached', itemId: recent[0].id }); await rememberPhoto(db, waMessageId, path).catch(() => {}); await maintEvent(db, recent[0].id, 'photo', { actor: reporterName, payload: { path }, wamid: waMessageId }); }
      return true;   // silent: the ticket confirmation has already been sent
    }
    if (recent.length > 1 && media) {
      // Several tickets a moment ago: she picks, the photo is never put on all.
      try {
        const path = await rememberPhoto(db, waMessageId, await savePendingPhoto(db, me, { base64: media.base64, contentType: media.mime }));
        await photoStore.remember(db, { path, wamid: waMessageId, waNum: me, staffId: reporter?.staff?.id ?? null, caption: body || null, source: 'maintenance', status: 'suggested' });
        for (const it of recent) await suggest(db, it.id, [path], { why: 'sent after several reports', from: me }).catch(() => {});
        await photoStore.suggestFor(db, path, recent.map(r => r.id), { why: 'sent after several reports' });
        await askReporter(db, wa, { to: me, lang: inId ? 'id' : 'en', items: recent.map(r => ({ id: r.id, title: r.title })), photos: [path], villa: null }).catch(() => {});
      } catch { /* a lost photo must not cost the reply */ }
      return true;
    }

    // Nothing to attach to yet: park it rather than lose it, and ask at most
    // once — people send two or three pictures then explain, and being asked
    // after every photo would be maddening.
    if (media) {
      try {
        const path = await rememberPhoto(db, waMessageId, await savePendingPhoto(db, me, { base64: media.base64, contentType: media.mime }));
        await parkPhoto(db, me, path);
        await photoStore.remember(db, { path, wamid: waMessageId, waNum: me, staffId: reporter?.staff?.id ?? null, caption: body || null, source: 'parked', status: 'parked' });
      } catch { /* a lost photo must not cost us the reply */ }
    }
    const already = await peekParked(db, me);
    if (already <= 1 && await claimAskLock(db, me)) {
      await sendText(wa, fromNum, inId
        ? `Foto sudah saya terima 👍 Ini di villa mana, dan apa yang perlu diperbaiki? (contoh: "B3 – piring pecah 1")`
        : `Got the photo 👍 Which villa is it, and what needs doing? (e.g. "Haus unit 5 — wardrobe door needs repair")`);
      if (inId) { try { const { coach } = await import('./coaching.js'); await coach(db, wa, { person: reporter?.staff || null, fromNum: me, key: 'fault_no_caption' }); } catch { /* optional */ } }
    }
    return true;
  }

  // Two properties fit the message equally well — better to ask than to
  // bill the wrong owner.
  if (matched.ambiguous) {
    if (hasImage) {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media) {
        try { const path = await rememberPhoto(db, waMessageId, await savePendingPhoto(db, me, { base64: media.base64, contentType: media.mime })); await parkPhoto(db, me, path); await photoStore.remember(db, { path, wamid: waMessageId, waNum: me, staffId: reporter?.staff?.id ?? null, caption: body || null, source: 'parked', status: 'parked' }); } catch {}
      }
    }
    const options = (matched.options || []).filter(o => o.slug || o.name).slice(0, 10);
    await parkAmbiguous(db, me, { body, options }).catch(() => {});
    await sendList(wa, fromNum, {
      body: inId ? 'Ini untuk villa yang mana? Supaya tidak salah pemilik.' : `Which villa is this for? I don't want to log it against the wrong one.`,
      buttonLabel: inId ? 'Pilih villa' : 'Pick the villa',
      rows: options.map(o => ({ id: `villa:pick:${o.slug || o.name}`, title: o.name || o.slug, description: o.slug && o.name ? o.slug : undefined })),
    });
    return true;
  }

  // One message can describe several jobs ("the wardrobe door AND the patio
  // chairs"), and may quote a price for them.
  const parsedItems = await extractReports(body, { matched, hasImage, lang: inId ? 'id' : 'en' });
  // Nothing broken in the words: not a report, whatever the photo shows.
  // Unclaimed, so the door can park the photo or ask (9 Sep 2026, #27).
  if (!parsedItems.length) return false;
  const parkedRows = await photoStore.takeParked(db, me).catch(() => []);
  const parked = [...new Set([...(await takeParkedPhotos(db, me)), ...parkedRows.map(r => r.path)])];
  let freshPhoto = null;
  if (hasImage) {
    const media = await fetchMediaBase64(mediaId, waToken);
    if (media) freshPhoto = media;
  }

  const created = [];
  for (const parsed of parsedItems) {
    const item = await createItem(db, {
      group_key: matched.group_key,
      slug: matched.slug,
      unit_label: matched.unit_label,
      title: parsed.title,
      description: parsed.description,
      urgency: parsed.urgency,
      estimated_cost: parsed.estimated_cost,
      reported_by_wa: fromNum,
      reported_by_name: reporterName,
      thread: [{ at: nowIso(), who: reporterName, text: body }],
      source: staffSlugs ? 'housekeeper' : 'team', wamid: waMessageId,
    });
    if (!item?.id) continue;
    created.push({ ...item, _parsed: parsed });
  }
  if (!created.length) return false;

  // ── Put each photo on the job it actually shows ───────────────────
  // A wardrobe door and a broken chair should not both land on both
  // tickets. Every photo is stored once and then looked at; a confident
  // match goes to that ticket alone, an uncertain one goes on all of them
  // and is queued for a question.
  // Certain photos: the one sent with these words (caption), or the one the
  // words quote. Parked photos from earlier messages are only certain when
  // there is a single ticket to put them on; otherwise they are suggested
  // and Era picks with a tap. Nothing is attached by a model's guess.
  const allPaths = [...parked];
  let freshPath = null;
  if (freshPhoto) {
    try { freshPath = await rememberPhoto(db, waMessageId, await savePendingPhoto(db, me, { base64: freshPhoto.base64, contentType: freshPhoto.mime })); allPaths.push(freshPath); } catch {}
  }
  const quotedPath = replyTo ? await photoForWamid(db, replyTo).catch(() => null) : null;
  if (quotedPath && !allPaths.includes(quotedPath)) allPaths.push(quotedPath);
  const unsure = [];
  for (const path of allPaths) {
    // One ticket: everything she sent is its evidence. Several tickets: only
    // the photo her words quote is certain; a caption naming two jobs does
    // not say which job the picture shows, so she is asked (8 Sep 2026).
    const certain = created.length === 1 || path === quotedPath;
    if (certain) {
      for (const t of created) { await attachPhotoPaths(db, t.id, [path]).catch(() => {}); await photoStore.place(db, path, { status: 'attached', itemId: t.id, by: reporterName, why: path === quotedPath ? 'quoted' : 'sent with the report' }); }
      continue;
    }
    unsure.push(path);
    for (const t of created) await suggest(db, t.id, [path], { why: 'sent with a report naming several jobs', from: me }).catch(() => {});
    await photoStore.suggestFor(db, path, created.map(t => t.id), { why: 'report named several jobs' });
  }
  if (freshPath) await photoStore.remember(db, { path: freshPath, wamid: waMessageId, waNum: me, staffId: reporter?.staff?.id ?? null, caption: body, source: 'maintenance', status: created.length === 1 ? 'attached' : 'suggested', itemId: created.length === 1 ? created[0].id : null });
  if (unsure.length) {
    await askReporter(db, wa, { to: me, lang: (me === eraNum || (ownerNum && me === ownerNum)) ? 'en' : 'id', items: created.map(c => ({ id: c.id, title: c._parsed.title })), photos: unsure, villa: matched.group?.name || null }).catch(() => {});
  }

  const where = matched.unit_label ? `${matched.group.name} (${matched.unit_label})` : matched.group.name;
  const idr = (n) => 'IDR ' + Math.round(n).toLocaleString('en-US');
  const lines = created.map(c =>
    `• *${c._parsed.title}*${c._parsed.estimated_cost ? ` — est. ${idr(c._parsed.estimated_cost)}` : ''}${c._parsed.urgency === 'urgent' ? ' ⚠️' : ''}`);
  const anyCost = created.some(c => c._parsed.estimated_cost);
  const photoNote = allPaths.length
    ? (unsure.length
        ? `\n\n${allPaths.length - unsure.length} of ${allPaths.length} photo${allPaths.length > 1 ? 's' : ''} attached.`
        : `\n\n${allPaths.length} photo${allPaths.length > 1 ? 's' : ''} attached to the right job${created.length > 1 ? 's' : ''}.`)
    : '';
  const ask = unsure.length
    ? `\n\n❓ ${unsure.length > 1 ? `${unsure.length} photos` : 'One photo'} could belong to more than one job — I am sending ${unsure.length > 1 ? 'each one' : 'it'} back with buttons to pick the job.`
    : '';
  if (inId) {
    const linesId = created.map(c => `• ${c._parsed.title}`);
    const photoId = allPaths.length ? (unsure.length ? `\n${allPaths.length - unsure.length} dari ${allPaths.length} foto sudah masuk.` : `\n${allPaths.length} foto sudah masuk.`) : '';
    const askId = unsure.length ? `\n\nAda ${unsure.length} foto yang bisa masuk ke lebih dari satu laporan — saya kirim balik satu per satu dengan tombol, tolong pilih laporannya.` : '';
    await sendText(wa, fromNum, `📋 Sudah saya catat untuk *${where}*:\n${linesId.join('\n')}${photoId}\n\nEra akan menindaklanjuti. Terima kasih 🙏${askId}`);
    return true;
  }
  await sendText(wa, fromNum,
    `📋 Logged for *${where}*:\n${lines.join('\n')}${photoNote}\n\n` +
    (reporter?.role === 'owner'
      // An owner reporting on their own villa: Era does the next step, not them.
      ? `Era will look at it, add a cost, and you'll get a message to approve if it needs your OK. I'll tell you when it's done.`
      : anyCost
        ? `I've pre-filled the estimate${created.length > 1 ? 's' : ''} — check ${created.length > 1 ? 'them' : 'it'} in the payouts app and publish to the owner.`
        : `Add the cost estimate in the payouts app when you're ready, then publish it to the owner.`) + ask);
  return true;
}
