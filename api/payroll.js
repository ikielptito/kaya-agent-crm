// Staff payroll API — two entities on one engine. Samba's runs come from
// Era's "Staff Salary and Expenses" sheet; Double 8's (Tropicana B2/B3/B5/B6,
// co-owned with Oli) are derived from the salary rows on the DOUBLE EIGHT
// ledger that already feed the Tropicana B statements. Called by the Samba
// admin panel through its server-side proxy (sync secret passes
// consoleAuthorized) and by the daily statements cron. POST {action, payload}.
//
// Scope: the proxy may send payload.entity_scope ('double8' for Oli's
// login). Every run-level action then refuses runs outside that entity and
// list/sync are pinned to it.
//
// Actions:
//   payroll_entities {}                    the two entities
//   payroll_probe {tab?}                   Samba sheet: tabs, raw rows, parse preview
//   payroll_sync {entity?, dry_run?, force?}
//   payroll_list {entity?}                 runs + outstanding summary
//   payroll_detail {id}
//   payroll_patch_line {id, line_id, fields} · payroll_add_line {id, fields} · payroll_delete_line {id, line_id}
//   payroll_reimport {id}                  Samba drafts only
//   payroll_publish {id} · payroll_unpublish {id}
//   payroll_record_payment {id, payee, staff_id?, amount, note?, paid_at?, fileBase64?, contentType?}
//   payroll_delete_payment {id, payment_id}
//   payroll_settings {} · payroll_settings_patch {fields}
//   payroll_feedback {entity, from, text, run_period?}   → Ikiel's Telegram

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  ENTITIES, entityOf, probePayroll, syncPayroll, syncDouble8, reimportRun, listRuns, runDetail,
  patchLine, addLine, deleteLine, publishRun, unpublishRun,
  recordPayment, deletePayment, payrollSettings, patchPayrollSettings, sendFeedback,
} from '../lib/payroll.js';

export default async function handler(req, res) {
  setConsoleCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST {action, payload}' });
  if (!consoleAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });
  const db = {
    SUPABASE_URL,
    sbHeaders: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
  };

  const { action, payload = {} } = req.body || {};
  const id = payload.id != null ? parseInt(payload.id, 10) : null;
  const scope = entityOf(payload.entity_scope) && payload.entity_scope ? payload.entity_scope : null;
  const entity = scope || entityOf(payload.entity) || 'samba';

  // Run-level actions: the run must be inside the caller's scope.
  const guard = async () => {
    if (!scope || id == null) return null;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/payroll_runs?id=eq.${id}&select=entity&limit=1`, { headers: db.sbHeaders });
    const row = r.ok ? (await r.json())?.[0] : null;
    return row && row.entity === scope ? null : 'This run is outside your access';
  };

  try {
    if (action === 'payroll_entities') return res.status(200).json({ entities: Object.values(ENTITIES).filter(e => !scope || e.key === scope), scope });
    if (action === 'payroll_probe') {
      if (scope) return res.status(403).json({ error: 'Not available for this login' });
      return res.status(200).json(await probePayroll(db, { tab: payload.tab || null }));
    }
    if (action === 'payroll_sync') {
      const opts = { dryRun: !!payload.dry_run, force: !!payload.force || !payload.dry_run };
      return res.status(200).json(entity === 'double8' ? await syncDouble8(db, opts) : await syncPayroll(db, opts));
    }
    if (action === 'payroll_list') return res.status(200).json({ entity, ...(await listRuns(db, { entity })) });
    if (action === 'payroll_settings') {
      if (scope) return res.status(403).json({ error: 'Not available for this login' });
      return res.status(200).json(await payrollSettings(db));
    }
    if (action === 'payroll_settings_patch') {
      if (scope) return res.status(403).json({ error: 'Not available for this login' });
      return res.status(200).json(await patchPayrollSettings(db, payload.fields || {}));
    }
    if (action === 'payroll_feedback') {
      return res.status(200).json(await sendFeedback(db, { entity, from: payload.from || (scope === 'double8' ? 'Oli' : 'admin'), text: payload.text, run_period: payload.run_period }));
    }

    const denied = await guard();
    if (denied) return res.status(403).json({ error: denied });
    if (action === 'payroll_detail') {
      const out = await runDetail(db, id);
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'Run not found' });
    }
    if (action === 'payroll_patch_line') return res.status(200).json(await patchLine(db, id, payload.line_id, payload.fields || {}));
    if (action === 'payroll_add_line') return res.status(200).json(await addLine(db, id, payload.fields || {}));
    if (action === 'payroll_delete_line') return res.status(200).json(await deleteLine(db, id, payload.line_id));
    if (action === 'payroll_reimport') return res.status(200).json(await reimportRun(db, id));
    if (action === 'payroll_publish') return res.status(200).json(await publishRun(db, id, { actor: payload.actor || (scope === 'double8' ? 'oli' : 'admin') }));
    if (action === 'payroll_unpublish') return res.status(200).json(await unpublishRun(db, id));
    if (action === 'payroll_record_payment') {
      return res.status(200).json(await recordPayment(db, id, {
        payee: payload.payee, staffId: payload.staff_id, amount: payload.amount, note: payload.note,
        paidAt: payload.paid_at, base64: payload.fileBase64, contentType: payload.contentType,
      }));
    }
    if (action === 'payroll_delete_payment') return res.status(200).json(await deletePayment(db, id, payload.payment_id));
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : /frozen|already|cannot|required|only drafts|first/i.test(e.message) ? 409 : 500;
    return res.status(code).json({ error: e.message });
  }
}
