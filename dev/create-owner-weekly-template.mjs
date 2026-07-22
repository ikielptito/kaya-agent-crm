#!/usr/bin/env node
// Submit the villa-owner weekly performance report template
// (samba_owner_weekly_report) to Meta for approval. This is what lets Maya
// PROACTIVELY message an owner first (outside the 24h window) with their weekly
// numbers + a link to the full report.
//
// Body variables:
//   {{1}} owner first name   {{2}} week range   {{3}} listing views   {{4}} enquiries
// Dynamic "View report" URL button: https://sambarentals.com/r/{{1}}
//   where the per-send {{1}} is the report path/token (built on the send side).
//
// Category UTILITY — it's a service update about the owner's own listing, not
// marketing. If Meta reclassifies or rejects, resubmit with category MARKETING.
//
// Run with your Vercel LISTING_SYNC_SECRET (same secret as the portal sync):
//   SYNC_SECRET=xxxxxxxx node dev/create-owner-weekly-template.mjs
// Check status afterwards:
//   node dev/create-owner-weekly-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_weekly_report';

const BODY = `Hi {{1}}, here's your Samba weekly update for {{2}}.

Your villa had {{3}} listing views and {{4}} enquiries this week.

Tap below for the full report — occupancy, agent reach, and how you compare to similar villas.

Any questions? Just reply here and I'll help. — Maya, Samba Realty`;

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, category: ${t.category || 'n/a'}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved — the Monday report push can use it.');
  else console.log('Still pending Meta review. Re-run with `status` to check again.');
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET to your Vercel LISTING_SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-owner-weekly-template.mjs');
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
      example: ['Ari', '14–20 Jul', '342', '11'],
      button: {
        text: 'View report',
        urlBase: 'https://sambarentals.com/r/',
        exampleUrl: 'https://sambarentals.com/r/villa-saturno',
      },
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log('Meta review is usually minutes to a few hours. Check with:\n  node dev/create-owner-weekly-template.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
