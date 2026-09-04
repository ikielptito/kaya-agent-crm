#!/usr/bin/env node
// Submit the monthly PROFIT statement template (samba_owner_profit_v1). For
// co-owned, expenses-only properties (Tropicana B2/B3/B5/B6 with Oli): rent
// never passes through Samba, so "total payout to you" would read as a
// negative number. This one speaks in net profit and expenses instead.
//
// Body variables:
//   {{1}} first name   {{2}} month ("June 2026")   {{3}} property name
//   {{4}} net profit ("IDR 16,218,905")            {{5}} expenses ("IDR 13,112,000")
// Dynamic "View statement" URL button: https://sambarentals.com/st/{{1}}
//   (statement token, groupKey.YYYY-MM~hmac16).
//
//   CONSOLE_KEY=xxxx node dev/create-owner-profit-template.mjs
//   node dev/create-owner-profit-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_profit_v1';

const BODY = `Hi {{1}}, the {{2}} statement for {{3}} is ready.

Net profit for the month: {{4}}, after {{5}} of expenses.

Tap below for the full breakdown: revenue from the calendar, every expense, and the profit view by quarter and year to date.

Any questions about the numbers? Just reply here and I'll get you an answer. — Maya, Samba Realty`;

const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.CONSOLE_KEY ? { 'x-console-key': process.env.CONSOLE_KEY } : {}), ...(process.env.SYNC_SECRET ? { Authorization: 'Bearer ' + process.env.SYNC_SECRET } : {}) });

async function status() {
  const r = await fetch(ENDPOINT, { headers: headers() });
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, category: ${t.category || 'n/a'}`);
}
async function create() {
  const r = await fetch(ENDPOINT, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      action: 'create', name: NAME, category: 'UTILITY', language: 'en', body: BODY,
      example: ['Oli', 'June 2026', 'Tropicana Valley · Units B2, B3, B5 & B6', 'IDR 16,218,905', 'IDR 13,112,000'],
      button: { text: 'View statement', urlBase: 'https://sambarentals.com/st/', exampleUrl: 'https://sambarentals.com/st/tropicana-b2356.2026-06~a1b2c3d4e5f60718' },
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
}
if (process.argv[2] === 'status') await status(); else await create();
