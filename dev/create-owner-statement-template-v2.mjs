#!/usr/bin/env node
// samba_owner_statement_v2: same words as v1, but the button opens the
// owner's portal on that month (/portal?stopen=<group>.<YYYY-MM>) instead of
// the standalone /st/ page. Ikiel, 5 Sep 2026: owners should live in the
// portal, where the month now carries the full statement and the calendar
// numbers. The sweep prefers v2 once approved and keeps v1 as fallback.
//
//   CONSOLE_KEY=xxxx node dev/create-owner-statement-template-v2.mjs
//   node dev/create-owner-statement-template-v2.mjs status
const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'samba_owner_statement_v2';
const BODY = `Hi {{1}}, your monthly statement for {{2}} is ready.

{{3}} — total payout to you: {{4}}.

Tap below for the full breakdown: bookings, expenses, occupancy, and payment status.

Any questions about the numbers? Just reply here and I'll get you an answer. — Maya, Samba Realty`;
const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.CONSOLE_KEY ? { 'x-console-key': process.env.CONSOLE_KEY } : {}), ...(process.env.SYNC_SECRET ? { Authorization: 'Bearer ' + process.env.SYNC_SECRET } : {}) });
async function status() {
  const j = await (await fetch(ENDPOINT, { headers: headers() })).json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  console.log(t ? `${NAME} -> ${t.status} (${t.category || 'n/a'})` : `${NAME} not found yet.`);
}
async function create() {
  const r = await fetch(ENDPOINT, { method: 'POST', headers: headers(), body: JSON.stringify({
    action: 'create', name: NAME, category: 'UTILITY', language: 'en', body: BODY,
    example: ['Romina', 'July 2026', 'HAUS Canggu · Units 2 & 4', 'IDR 7,785,250'],
    button: { text: 'View statement', urlBase: 'https://sambarentals.com/portal?stopen=', exampleUrl: 'https://sambarentals.com/portal?stopen=haus-2-4.2026-07' },
  }) });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
}
if (process.argv[2] === 'status') await status(); else await create();
