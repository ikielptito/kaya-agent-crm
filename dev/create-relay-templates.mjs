#!/usr/bin/env node
// Submit the two question-relay templates to Meta. Both are UTILITY: they
// carry a pending question or a ready answer, never marketing.
//
//   maya_owner_question — Maya has an agent's question for a villa contact
//                         whose 24h window has closed. {{1}} = property name.
//                         Their reply opens the window and the webhook's
//                         flushRelayQuestions sends the question itself.
//
//   maya_answer_ready   — the answer came back but the AGENT's window has
//                         since closed. {{1}} = property name. Their reply
//                         triggers deliverAnswers with the real answer.
//
// Until both are approved the relay still works whenever the window happens
// to be open; the template send just fails silently and the row waits.
//
// Run:   SYNC_SECRET=xxxx node dev/create-relay-templates.mjs
// Check: node dev/create-relay-templates.mjs status

const ENDPOINT = 'https://kaya-agent-crm.vercel.app/api/whatsapp-templates';

const TEMPLATES = [
  {
    name: 'maya_owner_question',
    body: `Maya here from Samba Realty. An agent has asked a question about {{1}}.

Reply to this message and I will send you the question right away.`,
    example: ['Villa Saturno'],
  },
  {
    name: 'maya_answer_ready',
    body: `Maya here from Samba Realty. I have the answer to your question about {{1}}.

Reply OK and I will send it over.`,
    example: ['Villa Saturno'],
  },
];

async function status() {
  const r = await fetch(ENDPOINT);
  const j = await r.json();
  for (const t of TEMPLATES) {
    const found = (j.templates || []).find((x) => x.name === t.name);
    console.log(found
      ? `${t.name} -> status: ${found.status}, quality: ${found.quality || 'n/a'}`
      : `${t.name} not found yet.`);
  }
}

async function create() {
  const SECRET = process.env.SYNC_SECRET;
  if (!SECRET) {
    console.error('Set SYNC_SECRET, e.g.:\n  SYNC_SECRET=xxxx node dev/create-relay-templates.mjs');
    process.exit(1);
  }
  for (const t of TEMPLATES) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({
        action: 'create', name: t.name, category: 'UTILITY',
        language: 'en', body: t.body, example: t.example,
      }),
    });
    const j = await r.json();
    if (!r.ok) console.error(`Create failed for ${t.name}:`, JSON.stringify(j));
    else console.log(`Submitted ${t.name}:`, JSON.stringify(j));
  }
  console.log('\nCheck approval with:\n  node dev/create-relay-templates.mjs status');
}

if (process.argv[2] === 'status') await status();
else await create();
