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

const GRAPH = 'https://graph.facebook.com/v24.0';
const nowIso = () => new Date().toISOString();
const BURST_MS = 6 * 60 * 1000;        // extra photos within 6 min = same issue

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

async function sendText(wa, to, body) {
  try {
    const r = await fetch(`${GRAPH}/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wa.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.messages?.[0]?.id || true;
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
export async function handleStaffMaintenance({ db, wa, fromNum, text, mediaType, mediaId, waToken }) {
  const reporter = await isReporter(db, fromNum);
  // Era and Ikiel are always allowed, even before anyone seeds the reporters
  // table — they are the two people certain to be reporting issues on day one.
  const me = String(fromNum).replace(/\D/g, '');
  const eraNum = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  const ownerNum = String(process.env.OWNER_WA_NUM || '').replace(/\D/g, '');
  const allowed = reporter || me === eraNum || (ownerNum && me === ownerNum);
  if (!allowed) return false;

  const body = String(text || '').trim();
  const hasImage = mediaType === 'image' && !!mediaId;
  const reporterName = reporter?.name || (ownerNum && me === ownerNum ? 'Ikiel' : 'Era');

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
      const looksNew = propHit && looksLikeMaintenance(body, false);
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

  // ── A new report ──────────────────────────────────────────────────
  if (!hasImage && !looksLikeMaintenance(body, false)) return false;

  const matched = await matchProperty(db, body);
  if (!matched) {
    if (!hasImage) return false;
    const media = await fetchMediaBase64(mediaId, waToken);

    // The description may already have been processed — WhatsApp sends the
    // burst at once and the lambdas finish in any order. If tickets exist
    // from moments ago, this photo belongs to them.
    const recent = await recentItemsFrom(db, me);
    if (recent.length) {
      if (media) {
        for (const it of recent) {
          await savePhoto(db, it.id, { base64: media.base64, contentType: media.mime }).catch(() => {});
        }
      }
      return true;   // silent: the ticket confirmation has already been sent
    }

    // Nothing to attach to yet: park it rather than lose it, and ask at most
    // once — people send two or three pictures then explain, and being asked
    // after every photo would be maddening.
    if (media) {
      try {
        const path = await savePendingPhoto(db, me, { base64: media.base64, contentType: media.mime });
        await parkPhoto(db, me, path);
      } catch { /* a lost photo must not cost us the reply */ }
    }
    const already = await peekParked(db, me);
    if (already <= 1 && await claimAskLock(db, me)) {
      await sendText(wa, fromNum, `Got the photo 👍 Which villa is it, and what needs doing? (e.g. "Haus unit 5 — wardrobe door needs repair")`);
    }
    return true;
  }

  // Two properties fit the message equally well — better to ask than to
  // bill the wrong owner.
  if (matched.ambiguous) {
    if (hasImage) {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media) {
        try { await parkPhoto(db, me, await savePendingPhoto(db, me, { base64: media.base64, contentType: media.mime })); } catch {}
      }
    }
    const names = (matched.options || []).map(o => o.slug || o.name).filter(Boolean).join(' or ');
    await sendText(wa, fromNum, `Which one is it — ${names}? I don't want to log it against the wrong villa.`);
    return true;
  }

  // One message can describe several jobs ("the wardrobe door AND the patio
  // chairs"), and may quote a price for them.
  const parsedItems = await extractReports(body, { matched, hasImage });
  const parked = await takeParkedPhotos(db, me);
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
  const allPaths = [...parked];
  if (freshPhoto) {
    try { allPaths.push(await savePendingPhoto(db, me, { base64: freshPhoto.base64, contentType: freshPhoto.mime })); } catch {}
  }
  const titles = created.map(c => c._parsed.title);
  const unsure = [];
  for (const path of allPaths) {
    let target = null;
    if (created.length > 1) {
      const media = await readPhotoBase64(db, path);
      if (media) {
        const verdict = await classifyPhoto(media, titles).catch(() => null);
        if (verdict && verdict.index != null) target = created[verdict.index];
      }
    }
    const targets = target ? [target] : created;
    if (!target && created.length > 1) unsure.push(path);
    for (const t of targets) await attachPhotoPaths(db, t.id, [path]).catch(() => {});
  }
  if (unsure.length) {
    await saveSettingValue(db, PHOTOQ_KEY, {
      ...((await getSettingValue(db, PHOTOQ_KEY)) || {}),
      [me]: { at: Date.now(), paths: unsure, items: created.map(c => ({ id: c.id, title: c._parsed.title })) },
    }).catch(() => {});
  }

  const where = matched.unit_label ? `${matched.group.name} (${matched.unit_label})` : matched.group.name;
  const idr = (n) => 'IDR ' + Math.round(n).toLocaleString('en-US');
  const lines = created.map(c =>
    `• *${c._parsed.title}*${c._parsed.estimated_cost ? ` — est. ${idr(c._parsed.estimated_cost)}` : ''}${c._parsed.urgency === 'urgent' ? ' ⚠️' : ''}`);
  const anyCost = created.some(c => c._parsed.estimated_cost);
  const photoNote = allPaths.length
    ? (unsure.length
        ? `\n\n${allPaths.length} photo${allPaths.length > 1 ? 's' : ''} attached.`
        : `\n\n${allPaths.length} photo${allPaths.length > 1 ? 's' : ''} attached to the right job${created.length > 1 ? 's' : ''}.`)
    : '';
  const ask = unsure.length
    ? `\n\n❓ I couldn't tell which job ${unsure.length > 1 ? 'some of them belong' : 'one of them belongs'} to, so ${unsure.length > 1 ? "they're" : "it's"} on both for now. Which is it — ${created.map(c => `*${c._parsed.title}*`).join(' or ')}? Reply and I'll fix it.`
    : '';
  await sendText(wa, fromNum,
    `📋 Logged for *${where}*:\n${lines.join('\n')}${photoNote}\n\n` +
    (anyCost
      ? `I've pre-filled the estimate${created.length > 1 ? 's' : ''} — check ${created.length > 1 ? 'them' : 'it'} in the payouts app and publish to the owner.`
      : `Add the cost estimate in the payouts app when you're ready, then publish it to the owner.`) + ask);
  return true;
}
