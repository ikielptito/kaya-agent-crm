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
//   hk_readiness {from?, to?}         handover checks: photos, verdicts, flags
//   hk_readiness_photos {id}          signed URLs for one check's photos
//   hk_standard {slug}                the villa's kit, consumables and photo spots
//   hk_standard_save {slug, ...}      Era's audit; missing kit → maintenance items
//   hk_rounds {months?}               inspections and deep cleans projected ahead
//   hk_stats {days?}                  per-housekeeper counts for the last N days
//   hk_calendar {months?}             everything for a calendar feed
//   hk_schedule_preview {name|wa, text|texts[]}  dry run of the schedule parser
//   hk_staff_review {days?, propose?}  the staff funnel (said → understood →
//                                     recorded → right) and, with propose,
//                                     what the review would put to Ikiel
//   hk_staff_learned {}               the approved words/examples/tips/hours

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import { generateTasks, catalogNames, fetchStays, projectRounds, roundAnchors } from '../lib/housekeeping.js';
import { runHousekeepingSweep, KIND_EN } from '../lib/housekeeping-sweep.js';
import { standardFor, readinessForWindow, housekeeperStats } from '../lib/housekeeping-readiness.js';
import { recordCorrection, correctingChange } from '../lib/corrections.js';

const KINDS = ['turnover', 'regular', 'pre_arrival', 'inspection', 'deep_clean'];

const PATCHABLE = new Set(['assigned_staff_id', 'task_date', 'notes', 'status', 'next_followup_at', 'photos']);

// Which templates Meta has approved, by name → true. Same source the cron
// uses before sending anything.
async function approvedTemplates() {
  const wabaId = process.env.META_WABA_ID, token = process.env.META_WA_TOKEN;
  if (!wabaId || !token) return {};
  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${wabaId}/message_templates?limit=100&access_token=${token}`);
    if (!r.ok) return {};
    const map = {};
    for (const t of ((await r.json()).data || [])) if (t.status === 'APPROVED') map[t.name] = true;
    return map;
  } catch { return {}; }
}

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

    // The stays the schedule is derived from, for the same window — so a
    // calendar can draw the guest on top of the cleans that serve them.
    if (action === 'hk_stays') {
      const { fetchStays } = await import('../lib/housekeeping.js');
      const stays = await fetchStays({ from: payload.from, to: payload.to });
      if (!stays) return res.status(502).json({ error: 'the portal calendar is unreachable' });
      return res.status(200).json(stays);
    }

    // A clean Era adds by hand from the schedule. origin_date is the date it
    // was created on, so a later move keeps its identity the way generated
    // visits do; the (slug, origin_date, kind) uniqueness means "there is
    // already a regular clean that day" comes back as a plain answer rather
    // than a duplicate row.
    if (action === 'hk_create') {
      const slug = String(payload.slug || '');
      const task_date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.task_date)) ? payload.task_date : null;
      const kind = KINDS.includes(payload.kind) ? payload.kind : null;
      if (!slug || !task_date || !kind) return res.status(400).json({ error: 'villa, day and kind are required' });
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      if (task_date < today) return res.status(400).json({ error: 'that day has already passed' });
      const row = {
        slug, task_date, origin_date: task_date, kind, status: 'planned',
        assigned_staff_id: payload.assigned_staff_id ? Number(payload.assigned_staff_id) : null,
        notes: payload.notes ? String(payload.notes).slice(0, 500) : null,
        moved_by: payload.actor || 'admin', moved_at: new Date().toISOString(),
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_tasks`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(row),
      });
      if (r.status === 409) return res.status(409).json({ error: `there is already a ${kind.replace('_', ' ')} at that villa on that day` });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      return res.status(201).json({ ok: true, task: (await r.json())[0] || null });
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
      // Never a visit someone moved by hand: those carry a date a person
      // chose, and the rule would put them back where they were.
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/housekeeping_tasks?status=eq.planned&notified_at=is.null&moved_by=is.null`,
        { method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=representation' } });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      const removed = (await r.json().catch(() => [])) || [];
      const built = await generateTasks(db);
      return res.status(200).json({ removed: removed.length, ...built });
    }

    // Each villa's cleaning weekdays. clean_days uses Postgres numbering,
    // 0 = Sunday, and the generator reads this rather than any hardcoded pair.
    if (action === 'hk_care') {
      return res.status(200).json({ care: await sbGet('property_care?select=*&order=slug.asc') });
    }
    if (action === 'hk_care_patch') {
      const slug = String(payload.slug || '');
      if (!slug) return res.status(400).json({ error: 'slug required' });
      // Sets the days AND makes the calendar agree: regular cleans already
      // planned on the old days (never one anybody was told about, never one
      // moved by hand) are skipped, and the new days are generated. Before
      // 7 Sep 2026 this only wrote the row, so three weeks of wrong-day
      // cleans stayed on the schedule after a change.
      const { applyCleanDays } = await import('../lib/housekeeping-schedule.js');
      const out = await applyCleanDays(db, { slug, days: payload.clean_days, actor: payload.actor || 'admin', regenerate: payload.regenerate !== false });
      if (payload.active != null) {
        await fetch(`${SUPABASE_URL}/rest/v1/property_care?slug=eq.${encodeURIComponent(slug)}`, {
          method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ active: !!payload.active, updated_at: new Date().toISOString() }),
        });
      }
      const care = (await sbGet(`property_care?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`))?.[0] || null;
      return res.status(200).json({ ok: true, care, ...out });
    }

    // Dry run of the schedule parser on a person's words: what "b3 dan b5
    // hari senin dan kamis" would mean for Gede, without writing anything.
    // texts may be several messages (a burst), oldest first.
    if (action === 'hk_schedule_preview') {
      const { listStaff } = await import('../lib/staff.js');
      const { previewSchedule } = await import('../lib/housekeeping-schedule.js');
      const people = await listStaff(db, { active_only: true });
      const p = people.find(x => x.name === payload.name || String(x.wa_num || '').replace(/\D/g, '') === String(payload.wa || '').replace(/\D/g, ''));
      if (!p) return res.status(404).json({ error: 'no such staff member' });
      const texts = Array.isArray(payload.texts) ? payload.texts : [payload.text].filter(Boolean);
      if (!texts.length) return res.status(400).json({ error: 'text required' });
      return res.status(200).json(await previewSchedule(db, { person: p, texts }));
    }

    if (action === 'hk_staff_review') {
      const { stageStaffReview } = await import('../lib/staff-review.js');
      const out = await stageStaffReview({ SUPABASE_URL, headers: sbHeaders, ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY }, { days: Number(payload.days) > 0 ? Number(payload.days) : 7, preview: true, propose: !!payload.propose });
      return res.status(200).json(out);
    }
    if (action === 'hk_staff_learned') {
      const { staffLearned } = await import('../lib/staff-review.js');
      return res.status(200).json(await staffLearned(db));
    }

    if (action === 'hk_patch') {
      const fields = {};
      for (const [k, v] of Object.entries(payload.fields || {})) if (PATCHABLE.has(k)) fields[k] = v;
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to change' });
      // Moving a task is recorded, so the schedule can say a date was changed
      // by hand rather than presenting it as what the rule produced.
      if (fields.task_date) {
        fields.moved_by = payload.actor || 'admin';
        fields.moved_at = new Date().toISOString();
        // A moved task has to be announced again on its new day.
        fields.notified_at = null;
        fields.status = 'planned';
      }
      fields.updated_at = new Date().toISOString();
      const before = (await sbGet(`housekeeping_tasks?id=eq.${id}&select=*&limit=1`).catch(() => []))?.[0] || null;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_tasks?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(fields),
      });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      const change = correctingChange('housekeeping_task', fields, before);
      if (change) await recordCorrection(db, { targetType: 'housekeeping_task', targetId: id, change, actor: payload.actor || 'admin', source: 'console' }).catch(() => {});
      return res.status(200).json({ ok: true, task: (await r.json())[0] || null });
    }

    if (action === 'hk_status') {
      const status = ['planned', 'notified', 'confirmed', 'done', 'skipped'].includes(payload.status)
        ? payload.status : null;
      if (!status) return res.status(400).json({ error: 'unknown status' });
      const before = (await sbGet(`housekeeping_tasks?id=eq.${id}&select=status&limit=1`).catch(() => []))?.[0] || null;
      if (before && before.status !== status) await recordCorrection(db, { targetType: 'housekeeping_task', targetId: id, change: { status: { from: before.status, to: status } }, actor: payload.actor || 'admin', source: 'console' }).catch(() => {});
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

    // Correct a round's findings by hand (a placeholder that slipped in, a
    // typo before the owner's report goes out).
    if (action === 'hk_inspection_patch') {
      const fields = {};
      if ('findings' in payload) fields.findings = payload.findings == null ? null : String(payload.findings).slice(0, 1000);
      if (Array.isArray(payload.item_ids)) fields.item_ids = payload.item_ids.map(Number).filter(Number.isInteger);
      // Photos can be moved off a misfiled record (onto the visit they
      // belong to) so the record can then be deleted.
      if (Array.isArray(payload.photos)) fields.photos = payload.photos.map(String).filter(Boolean);
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to change' });
      const before = (await sbGet(`housekeeping_inspections?id=eq.${id}&select=findings,photos,item_ids,task_id&limit=1`).catch(() => []))?.[0] || null;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_inspections?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(fields),
      });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });
      const change = correctingChange('housekeeping_inspection', fields, before);
      if (change) await recordCorrection(db, { targetType: 'housekeeping_inspection', targetId: id, change, actor: payload.actor || 'admin', source: 'console', taskId: before?.task_id || null }).catch(() => {});
      return res.status(200).json({ ok: true, inspection: (await r.json())[0] || null });
    }
    // Remove an inspection record that holds nothing (no photos): a round
    // opened by a stray word, never walked.
    if (action === 'hk_inspection_delete') {
      const row = (await sbGet(`housekeeping_inspections?id=eq.${id}&select=id,photos,item_ids,task_id,slug&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'no such inspection' });
      if ((row.photos || []).length || (row.item_ids || []).length) return res.status(409).json({ error: 'that record has photos or tickets; edit it instead' });
      await fetch(`${SUPABASE_URL}/rest/v1/housekeeping_inspections?id=eq.${id}`, { method: 'DELETE', headers: sbHeaders });
      await recordCorrection(db, { targetType: 'housekeeping_inspection', targetId: id, change: { deleted: { to: true } }, actor: payload.actor || 'admin', source: 'console', taskId: row.task_id || null, note: row.slug }).catch(() => {});
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

    // ── Owner-facing ──────────────────────────────────────────────
    // The portal's Housekeeping tab. Scoped to the slugs the portal has
    // already established the owner holds; no staff names or numbers.
    if (action === 'hk_owner_records') {
      const { ownerRecords } = await import('../lib/housekeeping-owner.js');
      return res.status(200).json(await ownerRecords(db, { slugs: payload.slugs, from: payload.from, to: payload.to }));
    }
    if (action === 'hk_owner_record_photos') {
      const { cleanSlugs } = await import('../lib/housekeeping-owner.js');
      const mine = new Set(cleanSlugs(payload.slugs));
      const table = payload.type === 'inspection' ? 'housekeeping_inspections' : payload.type === 'visit' ? 'housekeeping_tasks' : 'housekeeping_readiness';
      const row = (await sbGet(`${table}?id=eq.${id}&select=id,slug,photos&limit=1`))?.[0];
      if (!row || !mine.has(row.slug)) return res.status(404).json({ error: 'no such record' });
      const { signPhotoUrl } = await import('../lib/maintenance.js');
      const photo_urls = [];
      for (const p of (row.photos || []).slice(0, 40)) {
        const u = await signPhotoUrl(db, p, 3600).catch(() => null);
        if (u) photo_urls.push(u);
      }
      return res.status(200).json({ id: row.id, type: ['inspection', 'visit'].includes(payload.type) ? payload.type : 'handover', photo_urls });
    }

    // ── Readiness ─────────────────────────────────────────────────
    if (action === 'hk_readiness') {
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.from)) ? payload.from : new Date(Date.parse(today) - 30 * 86400e3).toISOString().slice(0, 10);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.to)) ? payload.to : today;
      return res.status(200).json({ from, to, checks: await readinessForWindow(db, { from, to }) });
    }
    if (action === 'hk_readiness_photos') {
      const row = (await sbGet(`housekeeping_readiness?id=eq.${id}&select=id,photos,checks,flags&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'no such check' });
      const { signPhotoUrl } = await import('../lib/maintenance.js');
      const urls = [];
      for (const p of (row.photos || []).slice(0, 12)) {
        const u = await signPhotoUrl(db, p).catch(() => null);
        if (u) urls.push(u);
      }
      return res.status(200).json({ id: row.id, photo_urls: urls, checks: row.checks, flags: row.flags });
    }

    // ── The villa's standard ──────────────────────────────────────
    if (action === 'hk_standard') {
      const slug = String(payload.slug || '');
      if (!slug) return res.status(400).json({ error: 'slug required' });
      return res.status(200).json({ standard: await standardFor(db, slug) });
    }
    if (action === 'hk_standard_save') {
      const slug = String(payload.slug || '');
      if (!slug) return res.status(400).json({ error: 'slug required' });
      const kit = (Array.isArray(payload.kit) ? payload.kit : []).map(k => ({
        key: String(k.key || '').slice(0, 40), label: String(k.label || '').slice(0, 120),
        present: k.present === true ? true : k.present === false ? false : null,
        note: k.note ? String(k.note).slice(0, 200) : null,
      })).filter(k => k.key);
      const consumables = (Array.isArray(payload.consumables) ? payload.consumables : []).map(c => ({
        key: String(c.key || '').slice(0, 40), label: String(c.label || '').slice(0, 120), par: Number(c.par) || 1,
      })).filter(c => c.key);
      const audited = kit.some(k => k.present != null);
      const row = {
        slug, kit, consumables,
        notes: payload.notes ? String(payload.notes).slice(0, 500) : null,
        ...(audited ? { audited_at: new Date().toISOString(), audited_by: payload.actor || 'admin' } : {}),
        updated_at: new Date().toISOString(),
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/unit_standards?on_conflict=slug`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 200) });

      // Every missing item becomes a maintenance item for the owner, once.
      // A villa with no statement group (some Tropicanas) has no owner to
      // ask, so the gap stays on the standard and is reported back as such.
      const missing = kit.filter(k => k.present === false);
      const filed = [], unowned = [];
      if (missing.length) {
        const groups = (await sbGet('statement_groups?active=is.true&select=key,listing_slugs')) || [];
        const group = groups.find(g => (g.listing_slugs || []).includes(slug));
        if (!group) unowned.push(...missing.map(k => k.label));
        else {
          const { createItem, appendThread } = await import('../lib/maintenance.js');
          const open = (await sbGet(`maintenance_items?slug=eq.${encodeURIComponent(slug)}&status=neq.done&status=neq.declined&select=id,title`)) || [];
          for (const k of missing) {
            const title = `Provide: ${k.label}`;
            if (open.some(i => i.title === title)) continue;
            const item = await createItem(db, {
              group_key: group.key, slug, title,
              description: `Missing from the villa's minimum kit${k.note ? `: ${k.note}` : ''}. Guests compare against neighbouring units; this is a standard Samba item.`,
              urgency: 'normal', reported_by_name: payload.actor || 'Kit audit',
            });
            if (item?.id) { filed.push(title); await appendThread(db, item.id, { who: 'Kit audit', text: 'Raised from the villa standard on the Schedule page' }).catch(() => {}); }
          }
        }
      }
      return res.status(200).json({ ok: true, standard: await standardFor(db, slug), filed, unowned });
    }

    // ── Rounds ahead and the calendar ─────────────────────────────
    if (action === 'hk_rounds' || action === 'hk_calendar') {
      const months = Math.min(12, Math.max(1, parseInt(payload.months, 10) || 6));
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const end = new Date(Date.parse(today) + Math.round(months * 30.4) * 86400e3).toISOString().slice(0, 10);
      const [feed, anchors, cfg, names] = await Promise.all([
        fetchStays({ from: new Date(Date.parse(today) - 7 * 86400e3).toISOString().slice(0, 10), to: end }),
        roundAnchors(db),
        (await import('../lib/campaigns.js')).getSettingValue(db, 'housekeeping'),
        catalogNames(db).catch(() => ({})),
      ]);
      const units = feed?.units || [];
      const rounds = projectRounds({ units, today, cfg: cfg || {}, months, ...anchors });
      // Real tasks inside the horizon replace the projection for those days.
      const tasks = await sbGet(
        `housekeeping_tasks?task_date=gte.${today}&task_date=lte.${end}&status=neq.skipped`
        + `&select=id,slug,task_date,kind,status,same_day,guest_in_date,staff:assigned_staff_id(name)&order=task_date.asc&limit=1000`);
      const horizonMax = tasks.reduce((m, t) => t.task_date > m ? t.task_date : m, today);
      const projected = rounds.filter(r => r.date > horizonMax);
      if (action === 'hk_rounds') return res.status(200).json({ today, months, names, tasks: tasks.filter(t => ['inspection', 'deep_clean'].includes(t.kind)), projected });
      // Calendar: everything, so one subscription shows the whole operation.
      const events = [];
      for (const t of tasks) events.push({
        uid: `hk-task-${t.id}`, date: t.task_date, slug: t.slug, kind: t.kind,
        title: `${names[t.slug] || t.slug}: ${KIND_EN[t.kind] || t.kind}${t.staff?.name ? ` (${t.staff.name})` : ''}`,
        status: t.status,
      });
      for (const r of projected) events.push({
        uid: `hk-proj-${r.slug}-${r.kind}-${r.date}`, date: r.date, slug: r.slug, kind: r.kind,
        title: `${names[r.slug] || r.slug}: ${KIND_EN[r.kind] || r.kind} (planned)`, status: 'projected',
      });
      for (const u of units) for (const s of (u.stays || [])) {
        if (s.status === 'cancelled') continue;
        if (s.check_in >= today && s.check_in <= end) events.push({ uid: `hk-in-${u.slug}-${s.check_in}`, date: s.check_in, slug: u.slug, kind: 'guest_in', title: `${names[u.slug] || u.slug}: guest arrives (${s.nights || '?'} nights)`, status: 'guest' });
        if (s.check_out >= today && s.check_out <= end) events.push({ uid: `hk-out-${u.slug}-${s.check_out}`, date: s.check_out, slug: u.slug, kind: 'guest_out', title: `${names[u.slug] || u.slug}: guest leaves`, status: 'guest' });
      }
      events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
      return res.status(200).json({ today, months, events });
    }

    if (action === 'hk_stats') {
      return res.status(200).json({ days: parseInt(payload.days, 10) || 30, people: await housekeeperStats(db, { days: parseInt(payload.days, 10) || 30 }) });
    }

    // Ask Maya a staff question without sending anything: what she would
    // reply to a housekeeper (or Era) who asked this.
    if (action === 'hk_help_preview') {
      const { answerStaffQuestion, looksLikeStaffQuestion } = await import('../lib/staff-help.js');
      const text = String(payload.text || '');
      if (!looksLikeStaffQuestion(text)) return res.status(200).json({ claimed: false, why: 'does not read as a question' });
      const role = payload.role === 'era' ? 'era' : 'housekeeper';
      let person = null;
      if (role === 'housekeeper') {
        const { listStaff } = await import('../lib/staff.js');
        const people = await listStaff(db, { active_only: true, role: 'housekeeper' });
        person = people.find(p => p.name === payload.name) || people[0] || null;
      }
      const out = await answerStaffQuestion({ db, wa: null, fromNum: '0', text, role, person, dryRun: true });
      return res.status(200).json({ claimed: !!out, as: role === 'era' ? 'Era' : person?.name || null, ...(out || {}) });
    }

    // Dry run of the staff dispatcher: what a message from this person would
    // be read as (the reference, the word rules, the classifier), sending
    // nothing and writing nothing. {name, text, reply_to?, button?}
    if (action === 'hk_dispatch_preview') {
      const { listStaff } = await import('../lib/staff.js');
      const { openWork, resolveReference, classifyStaffText } = await import('../lib/staff-dispatch.js');
      const { isAck, isDone, isAllFine, isGreeting, isQuestion, isAvail, isRestock, realText, SCHEDULE_WORD_RE } = await import('../lib/staff-lang.js');
      const people = await listStaff(db, { active_only: true });
      const person = people.find(p => p.name === payload.name) || null;
      if (!person) return res.status(404).json({ error: 'no such staff member' });
      const body = realText(payload.text || '');
      const work = await openWork(db, person);
      const ref = await resolveReference(db, { replyTo: payload.reply_to || null, buttonPayload: payload.button || null, person, work }).catch(e => ({ error: e.message }));
      const { looksLikeCompletion } = await import('../lib/ticket-guard.js');
      const rules = { ack: isAck(body), done: isDone(body), all_fine: isAllFine(body), ticket_completion: !isDone(body) && !isAllFine(body) && looksLikeCompletion(body) && work.tickets?.length > 0, greeting: isGreeting(body), question: isQuestion(body), avail: isAvail(body), restock: isRestock(body), schedule_word: SCHEDULE_WORD_RE.test(body) };
      const deterministic = Object.entries(rules).filter(([, v]) => v).map(([k]) => k);
      const cls = body && !deterministic.length ? await classifyStaffText({ body, person, work, names: await catalogNames(db).catch(() => ({})) }).catch(e => ({ error: e.message })) : null;
      const brief = { tasks: work.tasks.map(t => ({ id: t.id, slug: t.slug, kind: t.kind, date: t.task_date, status: t.status })), round: work.round?.id || null, check: work.check?.id || null, recent: work.recent.map(t => t.id), asks: work.asks.map(a => ({ id: a.id, kind: a.kind, targets: a.target_ids })) };
      return res.status(200).json({ person: person.name, body, reference: ref ? { kind: ref.kind, task: ref.task?.id || null, tasks: (ref.tasks || []).map(t => t.id), check: ref.check?.id || null, ask: ref.ask?.id || null } : null, rules: deterministic, classifier: cls, open: brief });
    }

    // Maya introduces the readiness system to the housekeepers herself.
    // hk_onboard {dry_run, only:[names], again} sends the template; status
    // shows who was sent, who tapped which button, who asked something.
    if (action === 'hk_onboard') {
      const { sendOnboarding } = await import('../lib/staff-onboarding.js');
      const templatesMap = await approvedTemplates();
      return res.status(200).json(await sendOnboarding({
        db, wa: { phoneId: process.env.META_WA_PHONE_ID, token: process.env.META_WA_TOKEN },
        templatesMap, only: Array.isArray(payload.only) ? payload.only : null,
        again: !!payload.again, dryRun: !!payload.dry_run,
      }));
    }
    // A one-off text from Maya to one staff member (a correction, a
    // clarification). Logged as staff_help so the thread stays coherent.
    if (action === 'hk_staff_message') {
      const { listStaff } = await import('../lib/staff.js');
      const text = String(payload.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const people = await listStaff(db, { active_only: true });
      const p = people.find(x => x.name === payload.name || String(x.wa_num || '').replace(/\D/g, '') === String(payload.wa || '').replace(/\D/g, ''));
      if (!p) return res.status(404).json({ error: 'no such staff member' });
      const to = String(p.wa_num).replace(/\D/g, '');
      const r = await fetch(`https://graph.facebook.com/v24.0/${process.env.META_WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.META_WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'WhatsApp refused', detail: d });
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ wa_num: to, direction: 'outbound', content: text, timestamp: new Date().toISOString(), source: 'console', category: 'staff_help', wa_message_id: d.messages?.[0]?.id || null, status: 'sent' }),
      }).catch(() => {});
      return res.status(200).json({ ok: true, to: p.name });
    }
    if (action === 'hk_onboard_status') {
      const { onboardingStatus } = await import('../lib/staff-onboarding.js');
      return res.status(200).json({ people: await onboardingStatus(db), template: (await approvedTemplates())['samba_hk_onboarding'] ? 'approved' : 'not approved' });
    }

    // ── The records library ───────────────────────────────────────
    // Every handover check and inspection round, newest first, so a claim
    // ("the guest broke the glass table") can be answered with the photos
    // taken before they arrived and after they left. Photos are signed on
    // demand per record, not here: a month of records is hundreds of them.
    if (action === 'hk_records') {
      const { buildRecords } = await import('../lib/housekeeping-records.js');
      const limit = Math.min(3000, parseInt(payload.limit, 10) || 1500);
      return res.status(200).json(await buildRecords(db, { from: payload.from, to: payload.to, slugs: payload.slug ? [String(payload.slug)] : null, limit, audience: 'era' }));
    }
    // One record in full: photos (signed), the housekeeper's thread, the
    // events behind it, the repairs it raised. type: visit|handover|inspection.
    if (action === 'hk_record_detail') {
      const { recordDetail } = await import('../lib/housekeeping-records.js');
      const type = ['visit', 'handover', 'inspection'].includes(payload.type) ? payload.type : 'handover';
      const d = await recordDetail(db, { type, id, audience: 'era' });
      if (!d) return res.status(404).json({ error: 'no such record' });
      return res.status(200).json(d);
    }
    // One record with everything the portal needs to print it: the record,
    // the villa name, signed photo URLs, the repairs it raised.
    if (action === 'hk_record_export') {
      const { recordDetail } = await import('../lib/housekeeping-records.js');
      const type = ['visit', 'handover', 'inspection'].includes(payload.type) ? payload.type : 'handover';
      const d = await recordDetail(db, { type, id, audience: payload.audience === 'owner' ? 'owner' : 'era' });
      if (!d) return res.status(404).json({ error: 'no such record' });
      return res.status(200).json({ record: d.record, villa: d.record.villa, photo_urls: d.photo_urls, repairs: d.repairs, events: d.events });
    }
    if (action === 'hk_record_photos') {
      const table = payload.type === 'inspection' ? 'housekeeping_inspections' : payload.type === 'visit' ? 'housekeeping_tasks' : 'housekeeping_readiness';
      const row = (await sbGet(`${table}?id=eq.${id}&select=id,photos&limit=1`))?.[0];
      if (!row) return res.status(404).json({ error: 'no such record' });
      const { signPhotoUrl } = await import('../lib/maintenance.js');
      const photo_urls = [];
      for (const p of (row.photos || []).slice(0, 40)) {
        const u = await signPhotoUrl(db, p, 3600).catch(() => null);
        if (u) photo_urls.push(u);
      }
      return res.status(200).json({ id: row.id, type: ['inspection', 'visit'].includes(payload.type) ? payload.type : 'handover', photo_urls });
    }

    // Dry run of the evening chase at a given WITA hour (default: now).
    // Era's daily brief: the data (for the portal's page), a preview of
    // the message, or a send right now.
    if (action === 'hk_era_brief') {
      const { buildBrief } = await import('../lib/era-brief.js');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date)) ? payload.date : null;
      return res.status(200).json(await buildBrief(db, { date }));
    }
    if (action === 'hk_era_brief_preview' || action === 'hk_era_brief_send') {
      const { runEraBrief } = await import('../lib/era-brief.js');
      return res.status(200).json(await runEraBrief({ db, wa: { phoneId: process.env.META_WA_PHONE_ID, token: process.env.META_WA_TOKEN }, preview: action === 'hk_era_brief_preview', force: action === 'hk_era_brief_send' }));
    }
    if (action === 'hk_chase_preview') {
      const { runHousekeepingChase } = await import('../lib/housekeeping-chase.js');
      const tm = await approvedTemplates().catch(() => ({}));
      return res.status(200).json(await runHousekeepingChase({
        db, wa: null, templatesMap: tm, catalogNames: await catalogNames(db).catch(() => ({})),
        preview: true, hour: payload.hour != null ? parseInt(payload.hour, 10) : null,
      }));
    }
    // The morning messages, for real, on demand: when the 09:00 pass did not
    // run (8 Sep 2026: no daily run logged, no templates sent) this sends
    // today's visits now. Idempotent — a visit already notified is skipped.
    if (action === 'hk_sweep_run') {
      const { loadTemplatesMap } = await import('./cron-followups.js');
      const templatesMap = await loadTemplatesMap(process.env.META_WA_PHONE_ID, process.env.META_WA_TOKEN, SUPABASE_URL, sbHeaders).catch(() => ({}));
      if (!Object.keys(templatesMap).length) return res.status(503).json({ error: 'template list unavailable; not sending blind' });
      return res.status(200).json(await runHousekeepingSweep({
        SUPABASE_URL, sbHeaders, WA_TOKEN: process.env.META_WA_TOKEN, WA_PHONE_ID: process.env.META_WA_PHONE_ID,
        catalogNames: await catalogNames(db).catch(() => ({})), templatesMap, preview: false,
      }));
    }
    // Are the 8 Sep 2026 tables there, and what does each housekeeper's
    // channel look like? {refresh: true} recomputes the channel rows now.
    if (action === 'hk_channels') {
      const tables = {};
      for (const t of ['staff_asks', 'staff_photos', 'maintenance_events', 'housekeeping_events', 'staff_channel']) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, { headers: sbHeaders });
        tables[t] = r.ok ? 'ok' : `missing (${r.status})`;
      }
      const { refreshChannels, channels, resetChannel } = await import('../lib/staff-channel.js');
      if (payload.reset) {
        const who = (await sbGet(`staff?name=eq.${encodeURIComponent(String(payload.reset))}&select=id&limit=1`))?.[0];
        if (!who) return res.status(404).json({ error: 'no such staff member' });
        await resetChannel(db, who.id, { hours: Number(payload.hours) || 24 });
      }
      const modes = (payload.refresh || payload.reset) ? await refreshChannels(db) : await channels(db);
      const { openAsks } = await import('../lib/asks.js');
      const staff = (await sbGet('staff?active=is.true&select=id,name,wa_num&limit=50')) || [];
      const people = [];
      for (const p of staff) {
        const m = modes[p.id] || {};
        const asks = await openAsks(db, p.wa_num).catch(() => []);
        people.push({ name: p.name, mode: m.mode || null, last_inbound: m.last_inbound_at || null, last_read: m.last_read_at || null, undelivered_since: m.undelivered_since || null, asks_7d: m.asks_7d ?? null, ignored_7d: m.ignored_asks_7d ?? null, open_asks: asks.map(a => ({ id: a.id, kind: a.kind, targets: a.target_ids, asked: a.asked_at })) });
      }
      return res.status(200).json({ tables, people });
    }
    // Ask the housekeepers about past visits nobody confirmed. {preview,
    // only:[names], force} — force sends now even if today's run happened.
    if (action === 'hk_backfill') {
      const { runBackfill } = await import('../lib/housekeeping-backfill.js');
      return res.status(200).json(await runBackfill({
        db, wa: { phoneId: process.env.META_WA_PHONE_ID, token: process.env.META_WA_TOKEN }, catalogNames: await catalogNames(db).catch(() => ({})),
        preview: !!payload.preview, force: !!payload.force, only: Array.isArray(payload.only) ? payload.only : null,
      }));
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
