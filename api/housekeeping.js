// Housekeeping API. Same shape as api/maintenance.js: POST { action, payload },
// reached by the Samba admin panel through its server-side proxy.
//
// Actions:
//   hk_schedule {from?, to?}          the schedule, with who is assigned
//   hk_generate {}                    re-derive tasks from the calendar now
//   hk_patch {id, fields}             reassign, reschedule, add a note
//   hk_status {id, status}            done / skipped by hand
//   hk_inspections {slug?, limit?}    inspection rounds and what they found
//   hk_sweep_preview {}               dry run of the messaging sweep

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import { generateTasks, catalogNames } from '../lib/housekeeping.js';
import { runHousekeepingSweep } from '../lib/housekeeping-sweep.js';

const PATCHABLE = new Set(['assigned_staff_id', 'task_date', 'notes', 'status', 'next_followup_at']);

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
  const sbGet = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`read → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const { action, payload = {} } = req.body || {};
  const id = payload.id != null ? parseInt(payload.id, 10) : null;

  try {
    if (action === 'hk_schedule') {
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.from)) ? payload.from : today;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.to))
        ? payload.to : new Date(Date.parse(today) + 21 * 86400e3).toISOString().slice(0, 10);
      const tasks = await sbGet(
        `housekeeping_tasks?task_date=gte.${from}&task_date=lte.${to}`
        + `&select=*,staff:assigned_staff_id(id,name,wa_num)&order=task_date.asc,slug.asc&limit=500`);
      const names = await catalogNames(db).catch(() => ({}));
      // A task nobody covers is the finding, not an omission: surface it.
      const unassigned = tasks.filter(t => !t.assigned_staff_id).length;
      return res.status(200).json({ from, to, today, tasks, names, unassigned });
    }

    if (action === 'hk_generate') {
      return res.status(200).json(await generateTasks(db));
    }

    // Throw away tasks nobody has been told about and rebuild from scratch.
    // Deliberately limited to status 'planned' with notified_at null: a visit
    // a housekeeper has already been asked to make is a promise, and a
    // completed one is a record. Neither is ours to delete. Use this after
    // changing a threshold, or when the schedule was first generated with
    // rules that have since been fixed.
    if (action === 'hk_replan') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/housekeeping_tasks?status=eq.planned&notified_at=is.null`,
        { method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      const removed = (await r.json().catch(() => [])) || [];
      const built = await generateTasks(db);
      return res.status(200).json({ removed: removed.length, ...built });
    }

    if (action === 'hk_patch') {
      const fields = {};
      for (const [k, v] of Object.entries(payload.fields || {})) if (PATCHABLE.has(k)) fields[k] = v;
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to change' });
      fields.updated_at = new Date().toISOString();
      const r = await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_tasks?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(fields),
      });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      return res.status(200).json({ ok: true, task: (await r.json())[0] || null });
    }

    if (action === 'hk_status') {
      const status = ['planned', 'notified', 'confirmed', 'done', 'skipped'].includes(payload.status)
        ? payload.status : null;
      if (!status) return res.status(400).json({ error: 'unknown status' });
      await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_tasks?id=eq.${id}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({
          status,
          ...(status === 'done' ? { done_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        }),
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'hk_inspections') {
      let q = 'housekeeping_inspections?select=*,staff:by_staff_id(id,name)&order=inspected_on.desc&limit='
        + (parseInt(payload.limit, 10) || 50);
      if (payload.slug) q += `&slug=eq.${encodeURIComponent(payload.slug)}`;
      return res.status(200).json({ inspections: await sbGet(q) });
    }

    // The one owner-facing read, called server-to-server by the portal when
    // it builds a weekly report. Signed photo URLs, no staff names, and the
    // repairs that came out of the round so the owner sees the loop closed.
    if (action === 'hk_owner_inspection') {
      const slug = String(payload.slug || '');
      if (!slug) return res.status(400).json({ error: 'slug required' });
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.from)) ? payload.from : null;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.to)) ? payload.to : null;
      let q = `housekeeping_inspections?slug=eq.${encodeURIComponent(slug)}&select=*&order=inspected_on.desc&limit=1`;
      if (from) q += `&inspected_on=gte.${from}`;
      if (to) q += `&inspected_on=lte.${to}`;
      const row = (await sbGet(q))?.[0];
      if (!row) return res.status(200).json({ inspection: null });

      const { signPhotoUrl } = await import('../lib/maintenance.js');
      const photo_urls = [];
      for (const p of (row.photos || []).slice(0, 12)) {
        const u = await signPhotoUrl(db, p).catch(() => null);
        if (u) photo_urls.push(u);
      }
      // What the round turned into. Only titles and status: an owner reading
      // their weekly report does not need the internal ticket.
      let repairs = [];
      if ((row.item_ids || []).length) {
        repairs = ((await sbGet(
          `maintenance_items?id=in.(${row.item_ids.join(',')})&select=id,title,status,estimated_cost,actual_cost,currency`)) || [])
          .map(i => ({
            title: i.title, status: i.status,
            cost: i.actual_cost ?? i.estimated_cost ?? null, currency: i.currency || 'IDR',
          }));
      }
      return res.status(200).json({
        inspection: {
          inspected_on: row.inspected_on,
          findings: row.findings || null,
          photo_urls,
          photo_count: (row.photos || []).length,
          repairs,
        },
      });
    }

    if (action === 'hk_sweep_preview') {
      return res.status(200).json(await runHousekeepingSweep({
        SUPABASE_URL, sbHeaders, WA_TOKEN: process.env.META_WA_TOKEN,
        WA_PHONE_ID: process.env.META_WA_PHONE_ID,
        catalogNames: await catalogNames(db).catch(() => ({})),
        preview: true,
      }));
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
