// The three mechanisms that had Maya asking villa owners the same question
// until they got angry (late Aug 2026), each pinned with the real incident's
// own data.
//
// 1. Villa Rice: four near-identical oven/washing-machine relays inside 90
//    minutes — exact-match dedup is blind to a paraphrase, and model-worded
//    questions are never byte-identical.
// 2. Villa Tiga: a complete answer 60 seconds after the flush matched to
//    nothing, because the disambiguation guard read "their reply is to
//    Maya's last message" as a reason to bail — when the last message WAS
//    the delivery of the open question.
// 3. The chase: re-messaging a contact who never replied to the last round,
//    up to eight times.
import { openRelay, detectDeliveredRelay, handbackText, HANDBACK_PREFIX } from '../lib/relay.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

// ── 1. Paraphrase-proof dedup ────────────────────────────────────────
// Stubbed PostgREST: one open info relay about villa-rice.
const openRows = [{ id: 71, question: 'Does Villa Rice have an oven in the kitchen?', rental_slug: 'villa_rice' }];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/relays?') && (!opts || !opts.method)) return { ok: true, json: async () => openRows };
  if (u.includes('/relays') && opts?.method === 'POST') return { ok: true, text: async () => JSON.stringify([{ id: 999 }]) };
  if (u.includes('/owners?')) return { ok: true, json: async () => [] };
  return { ok: true, json: async () => [], text: async () => '[]' };
};
const db = { SUPABASE_URL: 'http://x', sbHeaders: {} };
const wa = { phoneId: 'p', token: 't' };
const base = { agent: { id: 1, wa_num: '620000' }, contactWa: '8615900764173', slug: 'villa_rice', propertyName: 'Villa Rice' };

{
  const r = await openRelay(db, wa, { ...base, question: 'Does this villa have a washing machine and an oven?' });
  t('a paraphrase of a pending question is refused',
    [r.ok, String(r.reason || '').includes('already with the contact')], [false, true]);
}
{
  const r = await openRelay(db, wa, { ...base, question: 'Is there covered parking at the villa?' });
  t('a genuinely different info question about the SAME listing still waits its turn',
    [r.ok, String(r.reason || '').includes('already with the contact')], [false, true]);
}
{
  const r = await openRelay(db, wa, { ...base, slug: 'villa_solstice', propertyName: 'Villa Solstice', question: 'Does Villa Solstice have a bathtub?' });
  t('a question about a DIFFERENT listing goes through', r.ok !== false || r.reason === undefined, true);
}
{
  const r = await openRelay(db, wa, { ...base, question: '[Viewing] An agent would like to VIEW Villa Rice. Requested time: Friday 2pm.' });
  t('a viewing request never queues behind a fact question', r.ok !== false || !String(r.reason || '').includes('already with the contact'), true);
}

// ── 2. The delivered-question trap ───────────────────────────────────
const tigaRelay = [{ id: 88, question: "[Listing info] I'm trying to complete a few missing details on Villa Tiga Canggu so I can answer agents faster — could you help me out?\n\n• Villa Tiga Canggu: deposit, electricity, wifi speed", property_name: 'Villa Tiga Canggu' }];
{
  const hit = detectDeliveredRelay("[Relay → Villa Tiga Canggu] [Listing info] I'm trying to complete a few missing details on Villa Tiga Canggu so I can answer agents faster — could you help me out?", tigaRelay);
  t('the flush of an open question is recognised as its delivery', hit?.id, 88);
}
{
  const hit = detectDeliveredRelay('[Weekly report sent — Villa Tiga Canggu: 23 views, 3 enquiries]', tigaRelay);
  t('an unrelated recent outbound is not mistaken for the delivery', hit, null);
}
{
  t('no last outbound, no detection', detectDeliveredRelay(null, tigaRelay), null);
}

// ── 3. Chase guards ──────────────────────────────────────────────────
// The pure parts are inline queries, exercised via the module's behavior in
// production preview (chase dry-run); here we pin the constant that governs
// repetition — eight rounds of the same message was the complaint.
import { CHASE_MAX } from '../lib/listing-info.js';
t('the chase gives up after three unanswered rounds, not eight', CHASE_MAX, 3);

// The hand-back names the contact and the number, and carries its marker.
{
  const h = handbackText('Villa Rice', 'Vira', '+62 812-3456');
  t('handback carries the marker', h.startsWith(HANDBACK_PREFIX), true);
  t('handback names contact and number', h.includes('Vira directly on +628123456'), true);
  t('placeholder contact becomes "the villa contact"', handbackText('Villa Rice', 'there', '628123456').includes('the villa contact directly'), true);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
