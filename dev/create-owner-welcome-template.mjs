#!/usr/bin/env node
// Submit samba_owner_welcome_v1: Maya's FIRST message to the owner of a villa
// Samba already manages, carrying their portal link.
//
// Until 6 Sep 2026 the only link Maya could send an owner was the sign-in
// template written for the self-service login page ("expires in 10 minutes,
// ignore if you did not request it") — the wrong words for someone who has
// never heard from her. This one says who she is, what the portal shows,
// and that one tap opens it. {{1}} first name, {{2}} villa name; URL button
// suffix {{1}} = the 7-day wa_login token the portal mints (admin-invite-wa).
//
// Submit with the console key:
//   node dev/create-owner-welcome-template.mjs
//   node dev/create-owner-welcome-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const KEY = process.env.CONSOLE_KEY || '';

const T = {
  name: 'samba_owner_welcome_v1',
  language: 'en',
  category: 'UTILITY',
  body: `Hi {{1}}, I'm Maya, the assistant at Samba Realty, who manage {{2}} with Era and Ikiel.

Your owner portal is ready. It shows, for your villa: the monthly statement and what is owed to you, a weekly report with the inspection photos, repairs waiting for your approval and the ones already done, and the bookings calendar.

Tap the button to open it. It signs you in with this WhatsApp number, no password needed, and the link works for 7 days.

From now on I will also message you here when a repair needs your approval or a statement is ready. You can reply to me any time with questions about your villa.`,
  example: ['Cielo', 'Tropicana Valley Unit A5'],
  button: { text: 'Open my portal', urlBase: 'https://sambarentals.com/portal?wa_login=', exampleUrl: 'https://sambarentals.com/portal?wa_login=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' },
};

async function status() {
  const j = await (await fetch(ENDPOINT)).json();
  const f = (j.templates || []).find(x => x.name === T.name);
  console.log(`${T.name}: ${f ? f.status : 'not found yet'}`);
}
async function create() {
  if (!KEY) { console.error('Set CONSOLE_KEY'); process.exit(1); }
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-console-key': KEY }, body: JSON.stringify({ action: 'create', ...T }) });
  console.log(r.status, JSON.stringify(await r.json()).slice(0, 300));
  console.log('body chars', T.body.length);
}
if (process.argv[2] === 'status') await status(); else await create();
