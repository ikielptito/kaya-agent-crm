// Owner statements API — all statement actions in one router. Called by the
// Samba admin panel via its server-side proxy (the sync secret passes
// consoleAuthorized), by the portal server-to-server for owner surfaces, and
// by the daily Vercel cron for sheet sync. POST { action, payload }.
//
// GET  ?cron=1  (Authorization: Bearer CRON_SECRET) — daily sheet sync pass
//
// Actions:
//   statement_list {status?, group_key?}       list + outstanding summary
//   statement_detail {id}                      statement + lines + group
//   statement_patch_line {id, line_id, fields} edit one line (marks manual)
//   statement_add_line {id, fields}            add adjustment/booking/expense
//   statement_delete_line {id, line_id}
//   statement_sync {group_key?, dry_run?, force?}
//   statement_reparse {id}                     discard manual edits, re-import
//   statement_publish {id, notify_owner?}      freeze + Hostex snapshot
//   statement_unpublish {id}                   only before the owner was notified
//   statement_mark_paid {id}                   legacy: pay full remaining balance
//   statement_record_payment {id, amount, note?, paid_at?, fileBase64?, contentType?}
//   statement_delete_payment {id, payment_id}
//   statement_payments {id}                    ledger + signed proof URLs
//   statement_upload_proof {id, fileBase64, contentType}   (legacy statement-level)
//   statement_proof_url {id}                   5-min signed URL
//   statement_notify_preview {}                sweep dry-run (who/what/where)
//   statement_public {group_key, period}       published-only owner payload
//   statement_export_data {group_key, year?}   statements+lines+payments for Excel
//   statement_groups {}                        registry list
//   statement_group_patch {key, fields}        owner names/numbers/notify/active/payout_account

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  listGroups, syncGroup, syncAllGroups, reparseStatement, recomputeTotals,
  publishStatement, unpublishStatement, markPaid, saveProofUpload, signProofUrl,
  recordPayment, deletePayment, markPaymentReturned, listPayments, exportData,
  publicStatement, runOwnerStatementSweep, periodLabel,
} from '../lib/statements.js';
import { statementToken } from '../lib/tokens.js';

// Line fields the editor may write, per kind. Everything else is derived.
const EDITABLE = new Set(['unit_name', 'guest_name', 'stay_dates', 'platform', 'nights', 'amount', 'commission', 'nett', 'expense_date', 'description', 'position']);

export default async function handler(req, res) {
  setConsoleCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });
  const sbHeaders = {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', Prefer: 'return=minimal',
  };
  const db = { SUPABASE_URL, sbHeaders };
  const sb = async (path) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
    return r.ok ? r.json() : null;
  };
  const patch = async (path, body) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(body) });

  // ── Daily cron: sheet sync ───────────────────────────────────────
  if (req.method === 'GET') {
    if (req.query.cron !== '1') return res.status(400).json({ error: 'POST {action, payload}, or GET ?cron=1' });
    const auth = req.headers.authorization || '';
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const out = await syncAllGroups(db, {});
      return res.status(200).json({ ok: true, groups: out });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!consoleAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { action, payload = {} } = req.body || {};
  const id = payload.id != null ? parseInt(payload.id, 10) : null;

  try {
    if (action === 'statement_list') {
      let q = 'statements?select=*,statement_groups(key,name,owner_names,notify)&order=period.desc,group_key.asc&limit=500';
      if (payload.status) q += `&status=eq.${encodeURIComponent(payload.status)}`;
      if (payload.group_key) q += `&group_key=eq.${encodeURIComponent(payload.group_key)}`;
      const rows = (await sb(q)) || [];
      // Outstanding = published/partial statements still owing a POSITIVE
      // balance. Deficit months (negative payout) are not owed to anyone —
      // they carry forward into the next month on publish.
      const outstanding = rows.filter(s => (s.status === 'published' || s.status === 'partial')
        && ((Number(s.payout_total) || 0) - (Number(s.paid_total) || 0)) > 0);
      return res.status(200).json({
        statements: rows,
        outstanding: {
          count: outstanding.length,
          total: outstanding.reduce((a, s) => a + ((Number(s.payout_total) || 0) - (Number(s.paid_total) || 0)), 0),
        },
      });
    }

    if (action === 'statement_detail') {
      const st = (await sb(`statements?id=eq.${id}&select=*,statement_groups(*)&limit=1`))?.[0];
      if (!st) return res.status(404).json({ error: 'Statement not found' });
      const lines = (await sb(`statement_lines?statement_id=eq.${id}&select=*&order=position.asc,id.asc`)) || [];
      return res.status(200).json({
        statement: st, lines,
        payments: await listPayments(db, id),
        period_label: periodLabel(st.period),
        token: statementToken(st.group_key, st.period),
      });
    }

    if (action === 'statement_patch_line' || action === 'statement_add_line' || action === 'statement_delete_line') {
      const st = (await sb(`statements?id=eq.${id}&select=id,status&limit=1`))?.[0];
      if (!st) return res.status(404).json({ error: 'Statement not found' });
      if (st.status !== 'draft') return res.status(409).json({ error: `Statement is ${st.status} — lines are frozen` });

      if (action === 'statement_patch_line') {
        const fields = {};
        for (const [k, v] of Object.entries(payload.fields || {})) if (EDITABLE.has(k)) fields[k] = v;
        if (!Object.keys(fields).length) return res.status(400).json({ error: 'No editable fields' });
        await patch(`statement_lines?id=eq.${parseInt(payload.line_id, 10)}&statement_id=eq.${id}`, { ...fields, edited: true });
      } else if (action === 'statement_add_line') {
        const f = payload.fields || {};
        const kind = ['booking', 'expense', 'adjustment'].includes(f.kind) ? f.kind : 'adjustment';
        const maxPos = (await sb(`statement_lines?statement_id=eq.${id}&select=position&order=position.desc&limit=1`))?.[0]?.position ?? 0;
        const row = { statement_id: id, kind, position: maxPos + 1, edited: true, flags: ['manual'] };
        for (const [k, v] of Object.entries(f)) if (EDITABLE.has(k)) row[k] = v;
        await fetch(`${SUPABASE_URL}/rest/v1/statement_lines`, { method: 'POST', headers: sbHeaders, body: JSON.stringify(row) });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/statement_lines?id=eq.${parseInt(payload.line_id, 10)}&statement_id=eq.${id}`, { method: 'DELETE', headers: sbHeaders });
      }
      await patch(`statements?id=eq.${id}`, { has_manual_edits: true });
      const totals = await recomputeTotals(db, id);
      return res.status(200).json({ ok: true, totals });
    }

    if (action === 'statement_sync') {
      const opts = { dryRun: !!payload.dry_run, force: !!payload.force || !payload.dry_run };
      if (payload.group_key) {
        const group = (await sb(`statement_groups?key=eq.${encodeURIComponent(payload.group_key)}&select=*&limit=1`))?.[0];
        if (!group) return res.status(404).json({ error: 'Unknown group' });
        return res.status(200).json({ groups: [await syncGroup(db, group, opts)] });
      }
      return res.status(200).json({ groups: await syncAllGroups(db, opts) });
    }

    if (action === 'statement_reparse') return res.status(200).json(await reparseStatement(db, id));
    if (action === 'statement_publish') {
      return res.status(200).json(await publishStatement(db, id, {
        actor: payload.actor || 'admin',
        notifyOwner: payload.notify_owner !== false,
      }));
    }
    if (action === 'statement_unpublish') return res.status(200).json(await unpublishStatement(db, id));
    if (action === 'statement_mark_paid') return res.status(200).json(await markPaid(db, id));

    if (action === 'statement_record_payment') {
      return res.status(200).json(await recordPayment(db, id, {
        amount: payload.amount, note: payload.note, paidAt: payload.paid_at,
        base64: payload.fileBase64, contentType: payload.contentType,
      }));
    }
    if (action === 'statement_delete_payment') {
      return res.status(200).json(await deletePayment(db, id, payload.payment_id));
    }
    if (action === 'statement_payment_returned') {
      return res.status(200).json(await markPaymentReturned(db, id, payload.payment_id, { note: payload.note, undo: !!payload.undo }));
    }
    if (action === 'statement_payments') {
      return res.status(200).json({ payments: await listPayments(db, id) });
    }
    if (action === 'statement_export_data') {
      const out = await exportData(db, String(payload.group_key || ''), {
        year: payload.year ? String(payload.year).replace(/\D/g, '').slice(0, 4) : null,
        from: payload.from, to: payload.to,
      });
      if (!out) return res.status(404).json({ error: 'Unknown group' });
      return res.status(200).json(out);
    }

    if (action === 'statement_upload_proof') {
      return res.status(200).json(await saveProofUpload(db, id, {
        base64: payload.fileBase64, contentType: payload.contentType,
      }));
    }
    if (action === 'statement_proof_url') {
      const st = (await sb(`statements?id=eq.${id}&select=proof_path&limit=1`))?.[0];
      if (!st?.proof_path) return res.status(404).json({ error: 'No proof attached' });
      const url = await signProofUrl(db, st.proof_path);
      return url ? res.status(200).json({ url }) : res.status(500).json({ error: 'Could not sign proof URL' });
    }

    if (action === 'statement_notify_preview') {
      const out = await runOwnerStatementSweep({
        SUPABASE_URL, sbHeaders,
        WA_TOKEN: process.env.META_WA_TOKEN, WA_PHONE_ID: process.env.META_WA_PHONE_ID,
        preview: true,
      });
      return res.status(200).json(out);
    }

    if (action === 'statement_public') {
      const out = await publicStatement(db, String(payload.group_key || ''), String(payload.period || ''));
      if (!out) return res.status(404).json({ error: 'No published statement for that period' });
      // Paid statements may show their proof to the owner.
      if (out.status === 'paid') {
        const st = (await sb(`statements?group_key=eq.${encodeURIComponent(payload.group_key)}&period=eq.${encodeURIComponent(payload.period)}&select=proof_path&limit=1`))?.[0];
        if (st?.proof_path) out.proof_url = await signProofUrl(db, st.proof_path);
      }
      return res.status(200).json(out);
    }

    if (action === 'statement_groups') {
      return res.status(200).json({ groups: await listGroups(db, { activeOnly: false }) });
    }
    if (action === 'statement_group_patch') {
      const allowed = {};
      const f = payload.fields || {};
      if (Array.isArray(f.owner_wa_nums)) allowed.owner_wa_nums = f.owner_wa_nums.map(n => String(n).replace(/\D/g, '')).filter(Boolean);
      if (f.owner_names !== undefined) allowed.owner_names = String(f.owner_names || '') || null;
      if (typeof f.notify === 'boolean') allowed.notify = f.notify;
      if (typeof f.active === 'boolean') allowed.active = f.active;
      if (typeof f.charges_commission === 'boolean') allowed.charges_commission = f.charges_commission;
      if (f.sheet_file_id) allowed.sheet_file_id = String(f.sheet_file_id);
      if (f.payout_account !== undefined) {
        const a = f.payout_account || {};
        allowed.payout_account = a && (a.bank || a.account_name || a.account_number || a.note) ? {
          bank: String(a.bank || '').slice(0, 80) || null,
          account_name: String(a.account_name || '').slice(0, 120) || null,
          account_number: String(a.account_number || '').slice(0, 60) || null,
          note: String(a.note || '').slice(0, 300) || null,
          updated_by: payload.actor === 'owner' ? 'owner' : 'admin',
          updated_at: new Date().toISOString(),
        } : null;
      }
      if (!Object.keys(allowed).length) return res.status(400).json({ error: 'No editable fields' });
      await patch(`statement_groups?key=eq.${encodeURIComponent(payload.key)}`, { ...allowed, updated_at: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `unsupported action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
