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
//   statement_amend_start {id}                 open a transparent correction
//   statement_amend_finalize {id, note, notify_owner?}  close it (owner-visible note)
//   statement_amend_cancel {id}                restore pre-amendment lines/totals
//   statement_mark_paid {id}                   legacy: pay full remaining balance
//   statement_record_payment {id, amount, note?, paid_at?, fileBase64?, contentType?}
//   statement_delete_payment {id, payment_id}
//   statement_payments {id}                    ledger + signed proof URLs
//   statement_upload_proof {id, fileBase64, contentType}   (legacy statement-level)
//   statement_proof_url {id}                   5-min signed URL
//   statement_notify_preview {}                sweep dry-run (who/what/where)
//   statement_public {group_key, period}       published-only owner payload
//   statement_export_data {group_key, year?}   statements+lines+payments for Excel
//   statement_wa_login_code {wa_num, token}    deliver a tap-to-sign-in link on WhatsApp
//   statement_groups {}                        registry list
//   statement_group_patch {key, fields}        owner names/numbers/notify/active/payout_account

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import {
  listGroups, syncGroup, syncAllGroups, reparseStatement, recomputeTotals,
  publishStatement, unpublishStatement, refreshSnapshot, markPaid, saveProofUpload, signProofUrl,
  recordPayment, deletePayment, markPaymentReturned, listPayments, exportData,
  publicStatement, statementUnitNights, runOwnerStatementSweep, periodLabel,
  amendStart, amendFinalize, amendCancel, hasOpenRevision, renotifyStatement,
  sheetDiff, amendFromSheet, dismissDiscrepancy, setRevisionChanges,
} from '../lib/statements.js';
import { statementToken, inviteToken, previewToken } from '../lib/tokens.js';

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
      // Era's payroll sheet rides the same daily pass (lib/payroll.js).
      let payroll = null;
      try {
        const { syncAllPayroll } = await import('../lib/payroll.js');
        payroll = await syncAllPayroll(db, {});
      } catch (e) { payroll = { error: e.message }; }
      return res.status(200).json({ ok: true, groups: out, payroll });
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
      // tracks_payments may predate the migration; select=* tolerates that.
      const gRows = (await sb('statement_groups?select=*')) || [];
      const noSettle = new Set(gRows.filter(g => g.tracks_payments === false).map(g => g.key));
      // Expenses-only groups (co-owned units with no rent through Samba):
      // a negative payout there is money the co-owners owe Samba, not a
      // payout owed to anyone, so they never enter the outstanding banner.
      const expOnly = new Set(gRows.filter(g => g.expenses_only === true).map(g => g.key));
      for (const r of rows) {
        if (r.statement_groups) {
          r.statement_groups.tracks_payments = !noSettle.has(r.group_key);
          r.statement_groups.expenses_only = expOnly.has(r.group_key);
        }
      }
      // Outstanding = published/partial statements still owing a POSITIVE
      // balance. Deficit months (negative payout) are not owed to anyone —
      // they carry forward into the next month on publish.
      // Groups that don't track settlement (LaneHAUS — privately arranged
      // between Ikiel and Guy) never count as money owed.
      const outstanding = rows.filter(s => (s.status === 'published' || s.status === 'partial')
        && !noSettle.has(s.group_key) && !expOnly.has(s.group_key)
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
      const st = (await sb(`statements?id=eq.${id}&select=id,status,revisions&limit=1`))?.[0];
      if (!st) return res.status(404).json({ error: 'Statement not found' });
      // Published lines are frozen — except inside an open amendment.
      if (st.status !== 'draft' && !hasOpenRevision(st)) {
        return res.status(409).json({ error: `Statement is ${st.status} — lines are frozen (use Amend)` });
      }

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
    if (action === 'statement_renotify') return res.status(200).json(await renotifyStatement(db, id));
    // Sheet changed after publish: what changed, bring it in, or keep as is.
    if (action === 'statement_sheet_diff') return res.status(200).json(await sheetDiff(db, id));
    if (action === 'statement_amend_from_sheet') return res.status(200).json(await amendFromSheet(db, id, { notifyOwner: !!payload.notify_owner, actor: payload.actor || 'admin' }));
    if (action === 'statement_dismiss_discrepancy') return res.status(200).json(await dismissDiscrepancy(db, id));
    if (action === 'statement_revision_changes') return res.status(200).json(await setRevisionChanges(db, id, payload.changes || []));
    if (action === 'statement_attachments') {
      const { statementAttachments } = await import('../lib/statement-requests.js');
      return res.status(200).json({ attachments: await statementAttachments(db, id) });
    }

    // Amendments — transparent corrections to published statements.
    if (action === 'statement_amend_start') {
      return res.status(200).json(await amendStart(db, id, payload.actor || 'admin'));
    }
    if (action === 'statement_amend_finalize') {
      return res.status(200).json(await amendFinalize(db, id, {
        note: payload.note, notifyOwner: !!payload.notify_owner, actor: payload.actor || 'admin',
      }));
    }
    if (action === 'statement_amend_cancel') {
      return res.status(200).json(await amendCancel(db, id));
    }
    if (action === 'statement_refresh_snapshot') return res.status(200).json(await refreshSnapshot(db, id));
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

    if (action === 'statement_unit_nights') {
      const out = await statementUnitNights(db, String(payload.group_key || ''), String(payload.from || ''), String(payload.to || ''));
      if (!out) return res.status(404).json({ error: 'Unknown group' });
      return res.status(200).json(out);
    }

    // An owner just claimed their portal account. Worth a ping: it is the
    // moment their queued statements and maintenance requests become
    // sendable, and Ikiel is otherwise left refreshing a page to find out.
    if (action === 'statement_owner_claimed') {
      const key = String(payload.group_key || '');
      const g = (await sb(`statement_groups?key=eq.${encodeURIComponent(key)}&select=name,owner_names&limit=1`))?.[0];
      const pend = (await sb(`maintenance_items?group_key=eq.${encodeURIComponent(key)}&status=in.(pending_approval,scheduled)&notified_at=is.null&select=id`)) || [];
      const stmts = (await sb(`statements?group_key=eq.${encodeURIComponent(key)}&status=in.(published,partial,paid)&notified_at=is.null&select=id`)) || [];
      const waiting = [];
      if (stmts.length) waiting.push(`${stmts.length} statement${stmts.length > 1 ? 's' : ''}`);
      if (pend.length) waiting.push(`${pend.length} maintenance request${pend.length > 1 ? 's' : ''}`);
      const { postToTelegram } = await import('../lib/telegram.js');
      await postToTelegram(
        `<b>Owner onboarded</b>\n${g?.owner_names || key} claimed ${g?.name || key}` +
        `${payload.owner_email ? `\n${payload.owner_email}` : ''}` +
        (waiting.length
          ? `\n\nMaya will send ${waiting.join(' and ')} on the next daily pass.`
          : `\n\nNothing queued for them.`),
        { parse_mode: 'HTML' },
      ).catch(() => {});
      return res.status(200).json({ ok: true, queued: { statements: stmts.length, maintenance: pend.length } });
    }

    if (action === 'statement_preview_link') {
      return res.status(200).json({ url: `https://sambarentals.com/portal?preview=${previewToken(String(payload.group_key || ''))}` });
    }
    if (action === 'statement_invite_link') {
      return res.status(200).json({ url: `https://sambarentals.com/portal?invite=${inviteToken(String(payload.group_key || ''))}` });
    }

    // WhatsApp magic-link sign-in delivery. The portal generates a one-time
    // token (KV, 10-min TTL) and calls here only to put the tap-to-sign-in
    // button on WhatsApp — this side never learns whether it was used.
    // UTILITY template with a URL button, NOT an OTP: Meta force-classifies
    // code-style messages as AUTHENTICATION, a category it refuses to
    // deliver to US (+1) numbers — and some owners (Romina) are on US numbers.
    if (action === 'statement_wa_login_code') {
      const to = String(payload.wa_num || '').replace(/\D/g, '');
      // Keep the dash: a management login's token is prefixed 'd8-' so the
      // portal can route the tap to the cockpit instead of the owner portal.
      const tok = String(payload.token || '').replace(/[^a-f0-9-]/gi, '');
      if (!to || tok.replace(/-/g, '').length < 16) return res.status(400).json({ error: 'wa_num and token required' });
      // Only numbers registered on an active group may be messaged — this
      // endpoint must not be usable to spam arbitrary numbers from our WABA.
      // Normally only numbers already registered on a property may be
      // messaged, so this endpoint can never be used to reach strangers.
      // allow_unregistered is the one exception: an admin assigning a villa
      // to its owner by number, which is by definition a first contact. The
      // caller is already holding the sync secret and an admin password.
      if (!payload.allow_unregistered) {
        const groups = await listGroups(db, { activeOnly: true });
        const known = groups.some(g => (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === to));
        if (!known) return res.status(403).json({ error: 'Number not registered to any property' });
      }
      const WA_TOKEN = process.env.META_WA_TOKEN;
      const WA_PHONE_ID = process.env.META_WA_PHONE_ID;
      if (!WA_TOKEN || !WA_PHONE_ID) return res.status(500).json({ error: 'WhatsApp env not configured' });
      // A first contact gets the welcome template (who Maya is, what the
      // portal shows, one tap to open) when Meta has approved it; the plain
      // sign-in template otherwise, and always for a self-service login.
      let name = 'samba_owner_login_link', components = [
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
      ];
      if (payload.welcome?.first && payload.welcome?.villa) {
        try {
          const wabaId = process.env.META_WABA_ID;
          const t = await fetch(`https://graph.facebook.com/v24.0/${wabaId}/message_templates?fields=name,status&name=samba_owner_welcome_v1&limit=5`, { headers: { Authorization: 'Bearer ' + WA_TOKEN } });
          const ok = ((await t.json()).data || []).some(x => x.name === 'samba_owner_welcome_v1' && x.status === 'APPROVED');
          if (ok) {
            name = 'samba_owner_welcome_v1';
            components = [
              { type: 'body', parameters: [{ type: 'text', text: String(payload.welcome.first).slice(0, 40) }, { type: 'text', text: String(payload.welcome.villa).replace(/[\r\n\t]+/g, ' ').slice(0, 60) }] },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] },
            ];
          }
        } catch { /* fall back to the sign-in template */ }
      }
      const r = await fetch(`https://graph.facebook.com/v24.0/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: 'en' }, components } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: d.error?.message || 'WhatsApp send failed' });
      // Logged so the owner's thread shows the first contact.
      await fetch(`${SUPABASE_URL}/rest/v1/wa_messages`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ wa_num: to, direction: 'outbound', content: name === 'samba_owner_welcome_v1' ? `[Owner welcome — ${payload.welcome.villa}: portal link]` : '[Owner portal sign-in link]', timestamp: new Date().toISOString(), wa_message_id: d.messages?.[0]?.id || null, source: 'console', category: 'owner_onboard', template_name: name, status: 'sent' }),
      }).catch(() => {});
      return res.status(200).json({ ok: true, message_id: d.messages?.[0]?.id || null, template: name });
    }

    // What Maya is shown when an owner asks about money — for checking her
    // knowledge against a real owner without messaging anyone.
    if (action === 'owner_statements_preview') {
      const { ownerStatementsContext } = await import('../lib/statements.js');
      return res.status(200).json(await ownerStatementsContext(db, {
        waNum: payload.wa_num, slugs: payload.slugs || [], months: payload.months || 6,
      }));
    }

    if (action === 'statement_groups') {
      return res.status(200).json({ groups: await listGroups(db, { activeOnly: false }) });
    }
    // Create (or rename/re-slug) a property group. A group without a sheet is
    // a maintenance-and-reports-only property — Ikiel's own units, co-owned —
    // and is skipped by the statement sync rather than failing it.
    if (action === 'statement_group_upsert') {
      const key = String(payload.key || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      const name = String(payload.name || '').trim();
      if (!key || !name) return res.status(400).json({ error: 'key and name required' });
      const row = {
        key, name,
        sheet_file_id: String(payload.sheet_file_id || ''),
        listing_slugs: Array.isArray(payload.listing_slugs) ? payload.listing_slugs.map(String) : [],
        owner_wa_nums: Array.isArray(payload.owner_wa_nums) ? payload.owner_wa_nums.map(n => String(n).replace(/\D/g, '')).filter(Boolean) : [],
        owner_names: payload.owner_names ? String(payload.owner_names) : null,
        notify: payload.notify !== false,
        active: payload.active !== false,
        updated_at: new Date().toISOString(),
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/statement_groups?on_conflict=key`, {
        method: 'POST', headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row),
      });
      if (!r.ok) return res.status(500).json({ error: (await r.text()).slice(0, 300) });
      return res.status(200).json({ ok: true, group: (await r.json())[0] || row });
    }
    if (action === 'statement_group_patch') {
      const allowed = {};
      const f = payload.fields || {};
      if (Array.isArray(f.owner_wa_nums)) allowed.owner_wa_nums = f.owner_wa_nums.map(n => String(n).replace(/\D/g, '')).filter(Boolean);
      if (f.owner_names !== undefined) allowed.owner_names = String(f.owner_names || '') || null;
      if (typeof f.notify === 'boolean') allowed.notify = f.notify;
      if (typeof f.active === 'boolean') allowed.active = f.active;
      if (typeof f.charges_commission === 'boolean') allowed.charges_commission = f.charges_commission;
      if (typeof f.tracks_payments === 'boolean') allowed.tracks_payments = f.tracks_payments;
      if (f.sheet_file_id) allowed.sheet_file_id = String(f.sheet_file_id);
      // Era's running expense ledger for the property (lib/expense-sheet-parser.js).
      if (f.expense_sheet_file_id !== undefined) allowed.expense_sheet_file_id = String(f.expense_sheet_file_id || '') || null;
      if (typeof f.expenses_only === 'boolean') allowed.expenses_only = f.expenses_only;
      if (f.payout_account !== undefined) {
        // International accounts carry country-specific fields (US routing,
        // UK sort code, IBAN, AU BSB, SWIFT…). Provided fields MERGE onto the
        // stored account so a quick 3-field edit never wipes the rest; an
        // explicit null/empty object clears the account entirely.
        const ACCT_FIELDS = { country: 8, bank: 80, account_name: 120, account_number: 60, routing_number: 20, sort_code: 12, bsb: 12, iban: 42, swift: 16, account_type: 12, note: 300 };
        if (!f.payout_account || Object.keys(f.payout_account).length === 0) {
          allowed.payout_account = null;
        } else {
          const existing = (await sb(`statement_groups?key=eq.${encodeURIComponent(payload.key)}&select=payout_account&limit=1`))?.[0]?.payout_account || {};
          const merged = { ...existing };
          for (const [k, cap] of Object.entries(ACCT_FIELDS)) {
            if (f.payout_account[k] === undefined) continue;
            let v = String(f.payout_account[k] || '').trim().slice(0, cap);
            if (k === 'iban' || k === 'swift') v = v.toUpperCase().replace(/\s+/g, '');
            merged[k] = v || null;
          }
          const meaningful = Object.entries(merged).some(([k, v]) => v && !['updated_by', 'updated_at', 'country'].includes(k));
          allowed.payout_account = meaningful ? {
            ...merged,
            updated_by: payload.actor === 'owner' ? 'owner' : 'admin',
            updated_at: new Date().toISOString(),
          } : null;
        }
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
