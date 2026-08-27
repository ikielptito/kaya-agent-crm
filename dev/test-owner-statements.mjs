#!/usr/bin/env node
// Live dry-run harness for the owner-statements pipeline (run AFTER deploy +
// migration + Google token re-mint). Nothing here writes or sends: sync uses
// dry_run (parse + reconciliation only) and notify uses the preview flag
// (prints the send plan, no Meta call).
//
//   SYNC_SECRET=xxxx node dev/test-owner-statements.mjs sync [group_key]
//   SYNC_SECRET=xxxx node dev/test-owner-statements.mjs notify
//   SYNC_SECRET=xxxx node dev/test-owner-statements.mjs groups

const ENDPOINT = process.env.STATEMENTS_ENDPOINT || 'https://kaya-agent-crm.vercel.app/api/statements';

async function call(action, payload = {}) {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) { console.error('Set SYNC_SECRET to your LISTING_SYNC_SECRET.'); process.exit(1); }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({ action, payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`${action} failed (${r.status}):`, JSON.stringify(j)); process.exit(1); }
  return j;
}

const cmd = process.argv[2] || 'sync';

if (cmd === 'groups') {
  const { groups } = await call('statement_groups');
  for (const g of groups) {
    console.log(`${g.key.padEnd(14)} ${g.active ? '' : '(inactive) '}sheet=${g.sheet_file_id.slice(0, 8)}… slugs=[${g.listing_slugs}] notify=${g.notify} owners=${g.owner_names || '—'} nums=[${g.owner_wa_nums}]`);
  }
} else if (cmd === 'notify') {
  const out = await call('statement_notify_preview');
  console.log(`queued: ${out.queued ?? 0}${out.skipped ? ` — skipped: ${out.skipped}` : ''}`);
  for (const p of out.plan || []) {
    console.log(`  ${p.statement}: ${p.owner} → ${p.to.join(', ')} · ${p.payout}\n    ${p.url}`);
  }
} else {
  const payload = { dry_run: true };
  if (process.argv[3]) payload.group_key = process.argv[3];
  const { groups } = await call('statement_sync', payload);
  for (const g of groups) {
    if (g.error) { console.log(`${g.group}: ERROR ${g.error}`); continue; }
    if (g.skipped) { console.log(`${g.group}: ${g.skipped}`); continue; }
    console.log(`${g.group}: ${g.tabs} report tab(s)`);
    for (const d of g.drafts || []) {
      if (d.error) { console.log(`  ${d.tab}: ERROR ${d.error}`); continue; }
      const t = d.totals;
      console.log(`  ${d.tab} → ${d.period}: nett ${t.nett.toLocaleString()} − exp ${t.expenses.toLocaleString()} = payout ${t.payout.toLocaleString()} (Era says ${d.era_payout_total?.toLocaleString() ?? '—'})${d.needs_review ? ` ⚠ ${d.flags.join(',')}` : ''}`);
      for (const c of d.reconciliation?.checks || []) {
        if (!c.ok) console.log(`    ✗ ${c.name}: expected ${c.expected?.toLocaleString()}, got ${c.actual?.toLocaleString()}`);
      }
      for (const u of d.reconciliation?.unparsed_rows || []) {
        console.log(`    ? row ${u.row}: ${u.cells.join(' | ')}`);
      }
    }
  }
}
