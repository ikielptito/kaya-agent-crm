#!/usr/bin/env node
// Submit the maya_team_alert template to Meta — the utility ping Maya sends
// Ikiel or Era when she has promised a follow-up or a guest needs help and
// their 24h WhatsApp session is closed. {{1}} = who the alert is about.
//
// Flow: template opens the conversation → Ikiel/Era reply anything ("OK") →
// the webhook's flushTeamAlerts delivers the queued summary + contact card.
// While unapproved, notifyTeam still queues the detail and the PWA push +
// Telegram mirror carry the alert; the template send just fails silently.
//
// Run:   SYNC_SECRET=xxxx node dev/create-team-alert-template.mjs
// Check: node dev/create-team-alert-template.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';
const NAME = 'maya_team_alert';

const BODY = `Maya here with a team alert regarding {{1}}.

Something came up that needs your attention. Reply OK and I will send you the full details right away.`;

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  const t = (j.templates || []).find((x) => x.name === NAME);
  if (!t) return console.log(`${NAME} not found yet.`);
  console.log(`${NAME} -> status: ${t.status}, quality: ${t.quality || 'n/a'}`);
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-team-alert-template.mjs');
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
      example: ['agent Putra Surya'],
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Create failed:', JSON.stringify(j)); process.exit(1); }
  console.log(`Submitted ${NAME}:`, JSON.stringify(j));
  console.log(`Check approval with:\n  node dev/create-team-alert-template.mjs status`);
}

if (process.argv[2] === 'status') await status();
else await create();
