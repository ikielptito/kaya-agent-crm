// Staff payroll API — Era's "Staff Salary and Expenses" sheet as monthly
// payroll runs. Called by the Samba admin panel through its server-side
// proxy (sync secret passes consoleAuthorized) and by the daily statements
// cron (api/statements.js ?cron=1) for the sheet sync. POST {action, payload}.
//
// Actions:
//   payroll_probe {tab?}                   read-only: tabs, raw rows, parse preview
//   payroll_sync {dry_run?, force?}        sheet → draft runs (non-clobber)
//   payroll_list {}                        runs + outstanding summary
//   payroll_detail {id}                    run + lines + payments + payee/property views
//   payroll_patch_line {id, line_id, fields}
//   payroll_add_line {id, fields}
//   payroll_delete_line {id, line_id}
//   payroll_reimport {id}                  discard manual edits, re-import the draft
//   payroll_publish {id}                   freeze the lines
//   payroll_unpublish {id}                 back to draft (no payments yet)
//   payroll_record_payment {id, payee, staff_id?, amount, note?, paid_at?, fileBase64?, contentType?}
//   payroll_delete_payment {id, payment_id}
//   payroll_settings {}                    sheet id + unpaid villas
//   payroll_settings_patch {fields}

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  probePayroll, syncPayroll, reimportRun, listRuns, runDetail,
  patchLine, addLine, deleteLine, publishRun, unpublishRun,
  recordPayment, deletePayment, payrollSettings, patchPayrollSettings,
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
  try {
    if (action === 'payroll_probe') return res.status(200).json(await probePayroll(db, { tab: payload.tab || null }));
    if (action === 'payroll_sync') return res.status(200).json(await syncPayroll(db, { dryRun: !!payload.dry_run, force: !!payload.force || !payload.dry_run }));
    if (action === 'payroll_list') return res.status(200).json(await listRuns(db));
    if (action === 'payroll_detail') {
      const out = await runDetail(db, id);
      return out ? res.status(200).json(out) : res.status(404).json({ error: 'Run not found' });
    }
    if (action === 'payroll_patch_line') return res.status(200).json(await patchLine(db, id, payload.line_id, payload.fields || {}));
    if (action === 'payroll_add_line') return res.status(200).json(await addLine(db, id, payload.fields || {}));
    if (action === 'payroll_delete_line') return res.status(200).json(await deleteLine(db, id, payload.line_id));
    if (action === 'payroll_reimport') return res.status(200).json(await reimportRun(db, id));
    if (action === 'payroll_publish') return res.status(200).json(await publishRun(db, id, { actor: payload.actor || 'admin' }));
    if (action === 'payroll_unpublish') return res.status(200).json(await unpublishRun(db, id));
    if (action === 'payroll_record_payment') {
      return res.status(200).json(await recordPayment(db, id, {
        payee: payload.payee, staffId: payload.staff_id, amount: payload.amount, note: payload.note,
        paidAt: payload.paid_at, base64: payload.fileBase64, contentType: payload.contentType,
      }));
    }
    if (action === 'payroll_delete_payment') return res.status(200).json(await deletePayment(db, id, payload.payment_id));
    if (action === 'payroll_settings') return res.status(200).json(await payrollSettings(db));
    if (action === 'payroll_settings_patch') return res.status(200).json(await patchPayrollSettings(db, payload.fields || {}));
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : /frozen|already|cannot|required|only drafts|first/i.test(e.message) ? 409 : 500;
    return res.status(code).json({ error: e.message });
  }
}
