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

import { matchProperty, createItem, savePhoto, completeItem, snoozeItem, appendThread, isReporter } from './maintenance.js';
import { looksLikeMaintenance, extractReport, parseStaffReply } from './maintenance-intake.js';

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
// than behind a URL that expires in five minutes.
async function fetchMediaBase64(mediaId, token) {
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

/**
 * @returns {boolean} true when this message was consumed as maintenance.
 */
export async function handleStaffMaintenance({ db, wa, fromNum, text, mediaType, mediaId, waToken }) {
  const reporter = await isReporter(db, fromNum);
  // Era's own number is always allowed even before anyone seeds the table.
  const eraNum = String(process.env.ERA_WA_NUM || '6281246357778').replace(/\D/g, '');
  const allowed = reporter || String(fromNum).replace(/\D/g, '') === eraNum;
  if (!allowed) return false;

  const body = String(text || '').trim();
  const hasImage = mediaType === 'image' && !!mediaId;
  const reporterName = reporter?.name || 'Era';

  // ── A photo with no new description, moments after a report: same issue
  if (hasImage && body.length < 12) {
    const recent = await recentItemFrom(db, fromNum);
    if (recent) {
      const media = await fetchMediaBase64(mediaId, waToken);
      if (media) await savePhoto(db, recent.id, { base64: media.base64, contentType: media.mime }).catch(() => {});
      return true;   // silent: she's mid-burst, another "logged ✅" would be noise
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
    // A photo with no identifiable property is worth one question — losing
    // the report would be worse than asking.
    if (hasImage) {
      await sendText(wa, fromNum, `Got the photo — which villa is it? (e.g. "Haus unit 1", "Tropicana B4")`);
      return true;
    }
    return false;
  }

  const parsed = await extractReport(body, { matched, hasImage });
  const item = await createItem(db, {
    group_key: matched.group_key,
    slug: matched.slug,
    unit_label: matched.unit_label,
    title: parsed.title,
    description: parsed.description,
    urgency: parsed.urgency,
    reported_by_wa: fromNum,
    reported_by_name: reporterName,
    thread: [{ at: nowIso(), who: reporterName, text: body }],
  });

  if (hasImage && item?.id) {
    const media = await fetchMediaBase64(mediaId, waToken);
    if (media) await savePhoto(db, item.id, { base64: media.base64, contentType: media.mime }).catch(() => {});
  }

  const where = matched.unit_label ? `${matched.group.name} (${matched.unit_label})` : matched.group.name;
  await sendText(wa, fromNum,
    `📋 Logged: *${parsed.title}*\n${where}${parsed.urgency === 'urgent' ? '\n⚠️ Marked urgent' : ''}\n\nAdd the cost estimate in the payouts app when you're ready, then publish it to the owner.`);
  return true;
}
