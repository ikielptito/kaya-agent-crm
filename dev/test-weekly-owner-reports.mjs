// Logic test for sendWeeklyOwnerReports (multi-slug loop).
// Mocks Supabase REST + the portal report endpoint + the WhatsApp Graph API,
// and asserts: one template per (owner, slug) pair, per-owner dedupe window,
// two contact rows sharing a slug each get their own send, and
// last_report_sent_at is stamped once per owner that received anything.
//
// Run: node dev/test-weekly-owner-reports.mjs

process.env.LISTING_SYNC_SECRET = 'sync_secret';

import crypto from 'node:crypto';
const { sendWeeklyOwnerReports } = await import('/Users/ikiel/kaya-agent-crm/api/cron-followups.js');

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS', label);
  else { failures++; console.log('FAIL', label, extra ?? ''); }
}
const expectedToken = (slug) =>
  `${slug}~${crypto.createHmac('sha256', 'sync_secret').update(slug).digest('hex').slice(0, 16)}`;

// ── Fixtures ─────────────────────────────────────────────────────────
// A: multi-villa owner (3 slugs) — must get 3 sends.
// B: recent last_report_sent_at — skipped entirely.
// C/D: ops + dedicated report contact for the same villa (two owner rows
//      sharing a slug, as the (listing, contact)-pair feed produces).
const owners = [
  { id: 1, wa_num: '628A', name: 'Ikiel R', listing_slugs: ['haus-1', 'haus-2', 'villa-saturno'], opt_in: true, report_enabled: true, last_report_sent_at: null },
  { id: 2, wa_num: '628B', name: 'Recent', listing_slugs: ['villa-x'], opt_in: true, report_enabled: true, last_report_sent_at: new Date(Date.now() - 2 * 86400000).toISOString() },
  { id: 3, wa_num: '628C', name: 'Manager Made', listing_slugs: ['villa-umah'], opt_in: true, report_enabled: true, last_report_sent_at: null },
  { id: 4, wa_num: '628D', name: 'Owner Wayan', listing_slugs: ['villa-umah'], opt_in: true, report_enabled: true, last_report_sent_at: null },
];

const graphSends = [];       // captured Graph API template payloads
const patches = [];          // owners PATCH urls
const waMessages = [];       // wa_messages POST bodies
const reportRequests = [];   // slugs requested from the portal

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/rest/v1/owners?opt_in')) {
    return { ok: true, json: async () => owners };
  }
  if (u.includes('/api/portal?action=report')) {
    const slug = decodeURIComponent((u.match(/slug=([^&]+)/) || [])[1]);
    reportRequests.push(slug);
    if (slug === 'villa-x') return { ok: false, status: 404 }; // never reached (owner B skipped)
    return { ok: true, json: async () => ({
      slug, name: 'Name of ' + slug,
      week: { from: '2026-07-20', to: '2026-07-26' },
      metrics: { views: { now: 12 }, enquiries: { now: 3 } },
    }) };
  }
  if (u.includes('graph.facebook.com')) {
    graphSends.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.x' }] }) };
  }
  if (u.includes('/rest/v1/wa_messages')) {
    waMessages.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  }
  if (u.includes('/rest/v1/owners?id=eq.')) {
    patches.push(u);
    return { ok: true, json: async () => ({}) };
  }
  throw new Error('unexpected fetch: ' + u);
};

// ── Run ──────────────────────────────────────────────────────────────
const summary = await sendWeeklyOwnerReports({
  SUPABASE_URL: 'http://sb', sbHeaders: {}, WA_TOKEN: 'wt', WA_PHONE_ID: 'pid',
});

// ── Assertions ───────────────────────────────────────────────────────
check('summary counts: considered=4 sent=5 skipped=1 failed=0',
  summary.considered === 4 && summary.sent === 5 && summary.skipped === 1 && summary.failed === 0,
  JSON.stringify(summary));

check('multi-villa owner got one send per slug (3)',
  graphSends.filter(g => g.to === '628A').length === 3, JSON.stringify(graphSends.map(g => g.to)));

check('recent owner fully skipped (no report fetches for villa-x)',
  !reportRequests.includes('villa-x'), JSON.stringify(reportRequests));

check('ops and report contacts each got the shared villa report',
  graphSends.filter(g => g.to === '628C').length === 1 && graphSends.filter(g => g.to === '628D').length === 1);

const first = graphSends.find(g => g.to === '628A');
const body = first.template.components.find(c => c.type === 'body');
const btn = first.template.components.find(c => c.type === 'button');
check('template payload: name + 4 body params',
  first.template.name === 'samba_owner_weekly_report' && body.parameters.length === 4
  && body.parameters[0].text === 'Ikiel' && body.parameters[2].text === '12' && body.parameters[3].text === '3',
  JSON.stringify(first.template));
check('button token = slug~hmac16',
  btn.parameters[0].text === expectedToken('haus-1'), btn.parameters[0].text);

const tokens = graphSends.filter(g => g.to === '628A')
  .map(g => g.template.components.find(c => c.type === 'button').parameters[0].text);
check('each villa message carries its own signed token',
  JSON.stringify(tokens) === JSON.stringify(['haus-1', 'haus-2', 'villa-saturno'].map(expectedToken)),
  JSON.stringify(tokens));

check('last_report_sent_at stamped once per sending owner (3 patches)',
  patches.length === 3 && patches.some(p => p.includes('id=eq.1')) && patches.some(p => p.includes('id=eq.3')) && patches.some(p => p.includes('id=eq.4'))
  && !patches.some(p => p.includes('id=eq.2')),
  JSON.stringify(patches));

check('wa_messages logged per send with villa name',
  waMessages.length === 5 && waMessages.filter(m => m.owner_id === 1).length === 3
  && waMessages.every(m => /Weekly report sent — Name of /.test(m.content)),
  JSON.stringify(waMessages.map(m => m.content)));

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
