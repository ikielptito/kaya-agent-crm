#!/usr/bin/env node
// samba_owner_guide_v1: Maya explains how the villa is looked after and
// hands the owner the Samba Owner Guide (PDF on the portal), to owners whose
// WhatsApp window is shut. {{1}} first name, {{2}} villa; URL button opens
// https://sambarentals.com/guides/{{1}} = Samba-Owner-Guide.pdf.
//   CONSOLE_KEY=… node dev/create-owner-guide-template.mjs
//   node dev/create-owner-guide-template.mjs status
const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const KEY = process.env.CONSOLE_KEY || '';
const T = {
  name: 'samba_owner_guide_v1', language: 'en', category: 'UTILITY',
  body: `Hi {{1}}, Maya from Samba Realty. From this month we look after {{2}} to a written standard, and I wanted you to have it in one place.

In short: cleaned twice a week and prepared before every guest; a photo check of seven spots before each arrival, which I verify; an inspection with photos every two weeks that reaches you on your Monday report; a deep clean every three months; every repair a ticket you approve from your phone, with the cost on that month's statement; and a permanent photo record of every handover, so a damage claim can be answered with the photo from before the guest arrived.

The button opens the Samba Owner Guide, 9 pages, with who does what, how repairs and statements work, and how to use your portal. Ask me anything about your villa here, any time.`,
  example: ['Cielo', 'Tropicana Valley Unit A5'],
  button: { text: 'Open the owner guide', urlBase: 'https://sambarentals.com/guides/', exampleUrl: 'https://sambarentals.com/guides/Samba-Owner-Guide.pdf' },
};
async function status() { const j = await (await fetch(ENDPOINT)).json(); const f = (j.templates || []).find(x => x.name === T.name); console.log(`${T.name}: ${f ? f.status : 'not found yet'}`); }
async function create() {
  if (!KEY) { console.error('Set CONSOLE_KEY'); process.exit(1); }
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-console-key': KEY }, body: JSON.stringify({ action: 'create', ...T }) });
  console.log(r.status, JSON.stringify(await r.json()).slice(0, 300), '| body chars', T.body.length);
}
if (process.argv[2] === 'status') await status(); else await create();
