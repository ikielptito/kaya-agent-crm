#!/usr/bin/env node
// Submit the monthly payout statement template (samba_owner_statement_v1) to
// Meta for approval. This is what lets Maya PROACTIVELY tell an owner of a
// Samba Realty-MANAGED villa that their monthly statement is ready (outside
// the 24h window), with a signed link to the full breakdown.
//
// Body variables:
//   {{1}} owner first name  {{2}} month ("July 2026")
//   {{3}} property name     {{4}} formatted payout ("IDR 26,290,000")
// Dynamic "View statement" URL button: https://sambarentals.com/st/{{1}}
//   where the per-send {{1}} is the period-scoped statement token
//   (groupKey.YYYY-MM~hmac16, built by lib/tokens.js on the send side).
//
// Category UTILITY — it's a financial statement about the owner's own villa,
// not marketing. If Meta reclassifies or rejects, resubmit as MARKETING.
//
// Run with your Vercel LISTING_SYNC_SECRET (same secret as the portal sync):
//   SYNC_SECRET=xxxxxxxx node dev/create-owner-statement-template.mjs
// Check status afterwards:
//   node dev/create-owner-statement-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_statement_v1';

const BODY = `Hi {{1}}, your monthly statement for {{2}} is ready.

{{3}} — total payout to you: {{4}}.

Tap below for the full breakdown: bookings, expenses, occupancy, and payment status.

Any questions about the numbers? Just reply here and I'll get you an answer. — Maya, Samba Realty`;

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, category: ${t.category || 'n/a'}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved — arm the owner_statements campaign in the Command Center to go live.');
  else console.log('Still pending Meta review. Re-run with `status` to check again.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-owner-statement-template.mjs');
    process.exit(1);
  }
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({
      action: 'create',
      name: NAME,
      category: 'UTILITY',
      language: 'en',
      body: BODY,
      example: ['Pedro', 'July 2026', 'Villa Saturno', 'IDR 26,290,000'],
      button: {
        text: 'View statement',
        urlBase: 'https://sambarentals.com/st/',
        exampleUrl: 'https://sambarentals.com/st/villa-saturno.2026-07~a1b2c3d4e5f60718',
      },
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log('Meta review is usually minutes to a few hours. Check with:\n  node dev/create-owner-statement-template.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
