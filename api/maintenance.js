// Maintenance API — every maintenance action in one router, called by the
// Samba admin panel through its server-side proxy (Era and Ikiel) and by the
// portal server-to-server for the owner surfaces. POST { action, payload }.
//
// Actions:
//   maint_list {group_key?, status?, open_only?}   items + counts
//   maint_detail {id}                              one item + signed photo URLs
//   maint_create {group_key, slug?, title, ...}    file one by hand
//   maint_patch {id, fields}                       edit title/cost/urgency/…
//   maint_delete {id}
//   maint_publish {id, requires_approval, estimated_cost?}   → queues the owner message
//   maint_approve {id, by?}                        (owner or admin on their behalf)
//   maint_decline {id, note?, by?}
//   maint_complete {id, note?, actual_cost?}       → queues "it's finished"
//   maint_reopen {id}
//   maint_snooze {id, until_date?, note?}          push the next Era nudge
//   maint_photo {id, fileBase64, contentType}      attach a photo
//   maint_public {group_key, id}                   the no-login /m/ page payload
//   maint_owner_items {group_keys[]}               the portal Maintenance tab
//   maint_sweep_preview {}                         dry-run of the messaging sweep
//   maint_reporters {} / maint_reporter_patch {wa_num, name?, role?, active?}

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  listItems, getItem, createItem, patchItem, deleteItem,
  publishItem, approveItem, declineItem, completeItem, reopenItem,
  snoozeItem, savePhoto, publicItem, ownerItems,
  listReporters, upsertReporter,
} from '../lib/maintenance.js';
import { runMaintenanceSweep } from '../lib/maintenance-sweep.js';

export default async function handler(req, res) {
  setConsoleCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST {action, payload}' });
  if (!consoleAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });
  const sbHeaders = {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'return=minimal',
  };
  const db = { SUPABASE_URL, sbHeaders };

  const { action, payload = {} } = req.body || {};
  const id = payload.id != null ? parseInt(payload.id, 10) : null;

  try {
    if (action === 'maint_list') {
      const items = await listItems(db, {
        group_key: payload.group_key, status: payload.status, open_only: !!payload.open_only,
      });
      const counts = items.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
      // What actually needs a human: Era's review pile and work still open.
      const needsReview = items.filter(i => i.status === 'new').length;
      const awaitingOwner = items.filter(i => i.status === 'pending_approval').length;
      const openWork = items.filter(i => ['approved', 'scheduled'].includes(i.status)).length;
      return res.status(200).json({ items, counts, needsReview, awaitingOwner, openWork });
    }

    if (action === 'maint_detail') {
      const item = await getItem(db, id);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ item });
    }

    if (action === 'maint_create') {
      if (!payload.group_key) return res.status(400).json({ error: 'group_key required' });
      const item = await createItem(db, payload);
      return res.status(200).json({ ok: true, item });
    }

    if (action === 'maint_patch')    return res.status(200).json(await patchItem(db, id, payload.fields || {}));
    if (action === 'maint_delete')   return res.status(200).json(await deleteItem(db, id));
    if (action === 'maint_publish')  return res.status(200).json(await publishItem(db, id, {
      requires_approval: payload.requires_approval,
      estimated_cost: payload.estimated_cost,
      actor: payload.actor || 'admin',
    }));
    if (action === 'maint_approve')  return res.status(200).json(await approveItem(db, id, { by: payload.by || 'owner' }));
    if (action === 'maint_decline')  return res.status(200).json(await declineItem(db, id, { note: payload.note, by: payload.by || 'owner' }));
    if (action === 'maint_complete') return res.status(200).json(await completeItem(db, id, {
      note: payload.note, actual_cost: payload.actual_cost, by: payload.by || 'admin',
    }));
    if (action === 'maint_reopen')   return res.status(200).json(await reopenItem(db, id));
    if (action === 'maint_snooze')   return res.status(200).json(await snoozeItem(db, id, {
      untilDate: payload.until_date, note: payload.note, who: payload.who || 'era',
    }));

    if (action === 'maint_photo') {
      const path = await savePhoto(db, id, { base64: payload.fileBase64, contentType: payload.contentType });
      return res.status(200).json({ ok: true, path });
    }

    if (action === 'maint_public') {
      const item = await publicItem(db, String(payload.group_key || ''), parseInt(payload.item_id ?? payload.id, 10));
      if (!item) return res.status(404).json({ error: 'No maintenance item for that link' });
      return res.status(200).json(item);
    }

    if (action === 'maint_owner_items') {
      return res.status(200).json({ items: await ownerItems(db, payload.group_keys || []) });
    }

    if (action === 'maint_sweep_preview') {
      return res.status(200).json(await runMaintenanceSweep({
        SUPABASE_URL, sbHeaders, WA_TOKEN: process.env.META_WA_TOKEN,
        WA_PHONE_ID: process.env.META_WA_PHONE_ID, preview: true,
      }));
    }

    // Recover photos that were parked but never attached (e.g. the report
    // and its pictures crossed in flight before the ordering fix).
    if (action === 'maint_attach_parked') {
      const { attachPhotoPaths } = await import('../lib/maintenance.js');
      const { getSettingValue, saveSettingValue } = await import('../lib/campaigns.js');
      const wa = String(payload.wa_num || '').replace(/\D/g, '');
      const ids = (Array.isArray(payload.ids) ? payload.ids : [payload.id]).map(n => parseInt(n, 10)).filter(Boolean);
      const all = (await getSettingValue(db, 'maintenance_pending_photos')) || {};
      const paths = (all[wa] || []).map(p => p.path).filter(Boolean);
      if (!paths.length) return res.status(404).json({ error: 'no parked photos for that number' });
      for (const i of ids) await attachPhotoPaths(db, i, paths);
      if (payload.clear !== false) { delete all[wa]; await saveSettingValue(db, 'maintenance_pending_photos', all); }
      return res.status(200).json({ ok: true, attached: paths.length, items: ids });
    }

    // Dry run: what would Maya file for this message? Creates nothing.
    if (action === 'maint_parse_preview') {
      const { matchProperty } = await import('../lib/maintenance.js');
      const { extractReports } = await import('../lib/maintenance-intake.js');
      const text = String(payload.text || '');
      const matched = await matchProperty(db, text);
      const items = await extractReports(text, { matched, hasImage: !!payload.has_image });
      return res.status(200).json({
        matched: matched ? { group_key: matched.group_key, slug: matched.slug, name: matched.group?.name } : null,
        items,
      });
    }

    if (action === 'maint_reporters') return res.status(200).json({ reporters: await listReporters(db) });
    if (action === 'maint_reporter_patch') return res.status(200).json(await upsertReporter(db, payload));

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
