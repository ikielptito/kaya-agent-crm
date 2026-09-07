#!/usr/bin/env node
// Submit the multi-villa weekly report ping (samba_owner_portfolio_report_v1)
// to Meta. One message per owner on Mondays instead of one per villa: the
// single-villa template has no villa-name slot, so a 12-villa owner got
// twelve identical pings (7 Sep 2026). {{1}} first name, {{2}} week,
// {{3}} villa count, {{4}} total views, {{5}} total enquiries; the URL button
// carries a portfolio token (/r/<slug1+slug2+…>~<sig>) that opens a page
// listing every villa with its own numbers.
//
// Sent by sendWeeklyOwnerReports in api/cron-followups.js. Until Meta
// approves it the walk falls through to samba_owner_weekly_report_v3 with
// the same totals, so nothing waits on this review.
//
// Run with the console key or LISTING_SYNC_SECRET:
//   CONSOLE_KEY=xxxx node dev/create-owner-portfolio-template.mjs
//   node dev/create-owner-portfolio-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_portfolio_report_v1';

// Same register as v3 (UTILITY): no comparative claims in the ping — Meta
// classifies from the body text, and "how you compare" made v1 MARKETING.
const BODY = `Hi {{1}}, your weekly report for {{2}} is ready.

Across your {{3}} villas: {{4}} listing views and {{5}} enquiries this week.

Tap below for the villa-by-villa view — each one opens its own full report with occupancy, agent reach and this week's activity.

Any questions about the numbers? Just reply here and I'll help. — Maya, Samba Realty`;

function authHeaders() {
  if (process.env.CONSOLE_KEY) return { 'x-console-key': process.env.CONSOLE_KEY };
  if (process.env.SYNC_SECRET) return { Authorization: 'Bearer ' + process.env.SYNC_SECRET };
  console.error('Set CONSOLE_KEY (Maya console key) or SYNC_SECRET (LISTING_SYNC_SECRET).');
  process.exit(1);
}

async function status() {
  const r = await fetch(ENDPOINT, { headers: authHeaders() });
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, quality: ${t.quality || 'n/a'}`);
  if (t.status === 'APPROVED') console.log('Approved. Multi-villa owners get this wording from the next Monday run, no deploy needed.');
  else console.log('Still in Meta review; multi-villa owners get the v3 wording with portfolio totals meanwhile.');
}

async function create() {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      action: 'create',
      name: NAME,
      category: 'UTILITY',
      language: 'en',
      body: BODY,
      example: ['Ikiel', '31 Aug–6 Sep', '12', '342', '19'],
      button: {
        text: 'View report',
        urlBase: 'https://sambarentals.com/r/',
        exampleUrl: 'https://sambarentals.com/r/haus-1+lanehaus-3+villa-saturno~a1b2c3d4e5f60718',
      },
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log('Check with:\n  node dev/create-owner-portfolio-template.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
