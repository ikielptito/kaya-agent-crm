// The midnight re-ask (Mon 7 Sep 2026, 00:05 WITA): the hourly relay sweep's
// first Monday pass re-asked 22 expired questions across 8 villa contacts at
// midnight, and when Vira (Villa Rice) replied "Yes" the flush handed her four
// wordings of the oven question at once. Her answer then went to the agent as
// free text into a shut window — accepted by Meta, failed with 131047 later,
// relay marked delivered anyway. Each mechanism pinned here.
import {
  sweepRelays, reaskExpired, pickReaskRelays, deliverAnswers, inSweepHours,
  ANSWER_READY_TEMPLATE, VERBATIM_PREFIX,
} from '../lib/relay.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

const db = { SUPABASE_URL: 'http://x', sbHeaders: {} };
const wa = { phoneId: 'p', token: 't' };
const wita = (iso) => new Date(Date.parse(iso + '+08:00'));

// A recording stub: every request is remembered, PostgREST reads answer from
// `tables`, Graph sends return an id.
let calls = [];
let tables = {};
function stub() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('graph.facebook.com')) return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + calls.length }] }), text: async () => '{}' };
    if (opts.method === 'GET' || !opts.method) {
      const m = u.match(/\/rest\/v1\/([a-z_]+)\??/);
      const rows = (tables[m?.[1]] || []);
      const f = typeof rows === 'function' ? rows(u) : rows;
      return { ok: true, json: async () => f, text: async () => JSON.stringify(f) };
    }
    return { ok: true, json: async () => [], text: async () => '[]' };
  };
}
const sends = () => calls.filter(c => c.u.includes('graph.facebook.com') && c.u.includes('/messages'));
const stamps = () => calls.filter(c => c.u.endsWith('/settings') && c.method === 'POST');

// ── 1. Hour gates ────────────────────────────────────────────────────
t('00:05 WITA is outside the contact-facing sweep window', inSweepHours(wita('2026-09-07T00:05:00')), false);
t('09:05 WITA is inside it', inSweepHours(wita('2026-09-07T09:05:00')), true);
t('21:05 WITA is outside it again', inSweepHours(wita('2026-09-07T21:05:00')), false);

// The real rows: 22 expired relays waiting for a Monday.
const expired = [
  { id: 29, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_rice', property_name: 'Villa Rice', created_at: '2026-08-27T03:49:00Z', question: 'Does Villa Rice have an oven in the kitchen?' },
  { id: 31, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_rice', property_name: 'Villa Rice', created_at: '2026-08-27T04:34:00Z', question: 'Does the villa have a washing machine and an oven available for guests to use?' },
  { id: 32, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_rice', property_name: 'Villa Rice', created_at: '2026-08-27T04:35:00Z', question: 'Does this villa have a washing machine and an oven?' },
  { id: 33, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_rice', property_name: 'Villa Rice', created_at: '2026-08-27T05:00:00Z', question: 'Does the villa have a washing machine and an oven available for tenants to use?' },
  { id: 13, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_rice', property_name: 'Villa Rice', created_at: '2026-08-24T03:49:00Z', question: 'Do you have a video of the villa that we can share with an interested agent?' },
  { id: 40, status: 'expired', nudges: 0, contact_wa: '8615900764173', contact_name: 'Vira', rental_slug: 'villa_solstice', property_name: '2 of your listings', created_at: '2026-08-31T01:03:00Z', question: "[Listing info] I'm trying to complete a few missing details on your listings so I can answer agents faster — could you help me out?" },
  { id: 1, status: 'expired', nudges: 0, contact_wa: '628123457778', contact_name: 'Era', rental_slug: 'haus_1', property_name: '7 of your listings', created_at: '2026-08-23T01:10:00Z', question: "[Listing info] I'm trying to complete some missing details for some of the listings we manage — A" },
  { id: 16, status: 'expired', nudges: 0, contact_wa: '628123457778', contact_name: 'Era', rental_slug: 'haus_1', property_name: '7 of your listings', created_at: '2026-08-26T01:01:00Z', question: "[Listing info] I'm trying to complete some missing details for some of the listings we manage — B" },
  { id: 38, status: 'expired', nudges: 0, contact_wa: '628123457778', contact_name: 'Era', rental_slug: 'haus_1', property_name: '6 of your listings', created_at: '2026-08-31T01:03:00Z', question: "[Listing info] I'm trying to complete some missing details for some of the listings we manage — C" },
  { id: 15, status: 'expired', nudges: 0, contact_wa: '628123457778', contact_name: 'Era', rental_slug: 'villa_bula', property_name: 'Villa Bula', agent_wa: '620006891', created_at: '2026-08-25T01:33:00Z', question: 'An agent has a client interested in a 6-month stay at 30jt per month, paid monthly. Is monthly payment possible?' },
];

// ── 2. The re-ask waits for the morning pass ─────────────────────────
{
  stub(); tables = { relays: expired, settings: [], wa_messages: [] };
  const r = await reaskExpired(db, wa, { now: wita('2026-09-07T00:05:00') });
  t('Monday 00:05 WITA: the re-ask does not run', r.skipped, 'before 9:00 WITA');
  t('…sends nothing', sends().length, 0);
  t('…and does not burn the week stamp, so the 9am pass still runs', stamps().length, 0);
}
{
  stub(); tables = { relays: expired, settings: [], wa_messages: [] };
  const r = await reaskExpired(db, wa, { now: wita('2026-09-07T09:05:00') });
  t('Monday 09:05 WITA: the re-ask runs', [r.contacts, typeof r.skipped], [2, 'number']);
  t('…and stamps the week', stamps()[0]?.body?.value, '2026-09-07');
}
{
  stub(); tables = { relays: expired, settings: [], wa_messages: [] };
  const r = await reaskExpired(db, wa, { now: wita('2026-09-08T09:05:00') });
  t('Tuesday: not Monday', r.skipped, 'not Monday');
}

// ── 3. One question per listing, one listing-info round per contact ──
{
  const keep = pickReaskRelays(expired.filter(r => r.contact_wa === '8615900764173'));
  t('Vira gets ONE oven question (newest wording), not four — plus the listing-info round',
    keep.map(r => r.id).sort((a, b) => a - b), [33, 40]);
  t('the video question is left expired for a later Monday, its nudge count untouched',
    expired.find(r => r.id === 13).nudges, 0);
}
{
  const keep = pickReaskRelays(expired.filter(r => r.contact_wa === '628123457778'));
  t('Era gets one listing-info round (the newest) and the Villa Bula question',
    keep.map(r => r.id).sort((a, b) => a - b), [15, 38]);
}
{
  stub(); tables = { relays: expired, settings: [], wa_messages: [] };
  const r = await reaskExpired(db, wa, { now: wita('2026-09-07T09:05:00') });
  t('re-queued relays: 4 across the two contacts (was 10)', r.relays, 4);
  const requeued = calls.filter(c => c.method === 'PATCH' && c.u.includes('/relays?id=eq.') && c.body?.status === 'queued').map(c => Number(c.u.match(/id=eq\.(\d+)/)[1]));
  t('…exactly these rows', requeued.sort((a, b) => a - b), [15, 33, 38, 40]);
  t('windows shut → one re-opener template per contact', sends().filter(s => s.u && calls.find(c => c === s).body?.type === 'template').length, 2);
}

// ── 4. The sweep itself is quiet at night ────────────────────────────
{
  // An 'asked' relay 9h old that would normally be nudged, plus an answered
  // one waiting for an agent whose window is shut.
  const asked = [{ id: 50, status: 'asked', nudges: 0, contact_wa: '628111', contact_name: 'Nindi', property_name: 'Sawah Studios', asked_at: new Date(Date.parse('2026-09-06T15:05:00Z') - 9 * 3600e3).toISOString(), question: 'Is there a bathtub?' }];
  stub(); tables = {
    relays: (u) => /status=in\.\(queued,asked\)/.test(u) ? asked : (/status=eq\.answered&agent_wa=not/.test(u) ? [{ agent_wa: '620006888' }] : []),
    settings: [], wa_messages: [],
  };
  const r = await sweepRelays(db, wa, { now: wita('2026-09-07T00:05:00') });
  t('00:05 WITA: the sweep reports the quiet window', String(r.quiet || '').startsWith('00:05 WITA'), true);
  t('…and sends nothing to anyone', sends().length, 0);
}
{
  const asked = [{ id: 50, status: 'asked', nudges: 0, contact_wa: '628111', contact_name: 'Nindi', property_name: 'Sawah Studios', asked_at: new Date(Date.parse('2026-09-07T01:05:00Z') - 9 * 3600e3).toISOString(), question: 'Is there a bathtub?' }];
  stub(); tables = { relays: (u) => /status=in\.\(queued,asked\)/.test(u) ? asked : [], settings: [], wa_messages: [] };
  const r = await sweepRelays(db, wa, { now: wita('2026-09-07T09:05:00') });
  t('09:05 WITA: the same relay IS nudged', [r.nudged, r.quiet], [1, undefined]);
}

// ── 5. An answer never goes as free text into a shut window ──────────
const answered = [{ id: 32, status: 'answered', agent_wa: '620006888', agent_id: 166, contact_wa: '8615900764173', contact_name: 'Vira', property_name: 'Villa Rice', answer: 'Villa Rice has both a washing machine and an oven available for guests.', answered_at: '2026-09-06T16:21:30Z' }];
{
  stub(); tables = { relays: answered, wa_messages: [] }; // no inbound from the agent in 24h
  const n = await deliverAnswers(db, wa, '620006888');
  const s = sends();
  t('shut window: nothing delivered as free text', n, 0);
  t('…the answer-ready template goes instead', [s.length, s[0]?.body?.type, s[0]?.body?.template?.name], [1, 'template', ANSWER_READY_TEMPLATE]);
  const patched = calls.find(c => c.method === 'PATCH' && c.u.includes('/relays?id=eq.32'));
  t('…the relay stays answered with the template clock set', [patched?.body?.status, typeof patched?.body?.answer_template_at], [undefined, 'string']);
}
{
  stub(); tables = { relays: answered, wa_messages: [{ id: 1 }] }; // the agent wrote in the last 24h
  const n = await deliverAnswers(db, wa, '620006888');
  const s = sends();
  t('open window: the answer goes as text', [n, s[0]?.body?.type], [1, 'text']);
  t('…and the relay is marked delivered', calls.find(c => c.method === 'PATCH' && c.u.includes('/relays?id=eq.32'))?.body?.status, 'delivered');
}

// ── 6. A viewing reply parked overnight goes word for word in the morning ──
// (Era tapped "Can't this time" at 05:17 WITA; the agent heard at 05:17 — BAM, 10 Sep 2026)
{
  const line = "On Tropicana Valley – Unit B2 — the villa can't do Fri 11 Sep, 2pm. Want me to ask about a different time, or line up another villa?";
  const parked = [{ id: 40, status: 'answered', agent_wa: '620006888', agent_id: 166, contact_wa: '6281246357778', contact_name: 'Era', property_name: 'Tropicana Valley – Unit B2', answer: VERBATIM_PREFIX + line }];
  stub(); tables = { relays: parked, wa_messages: [{ id: 1 }] };
  const n = await deliverAnswers(db, wa, '620006888');
  const s = sends();
  t('verbatim answer: sent exactly as composed', [n, s[0]?.body?.text?.body], [1, line]);
  t('…no contact card rides along', s.length, 1);
  t('…and the relay is marked delivered, not expired', calls.find(c => c.method === 'PATCH' && c.u.includes('/relays?id=eq.40'))?.body?.status, 'delivered');
}
t('05:17 WITA is outside the sweep window', inSweepHours(wita('2026-09-10T05:17:00')), false);
t('08:05 WITA is inside it', inSweepHours(wita('2026-09-10T08:05:00')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
