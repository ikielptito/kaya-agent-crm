// Monday owner reports: one message per owner. On 7 Sep 2026 the managed
// portfolio's report contact (Ikiel) got twelve identical templates in forty
// seconds — the single-villa template has no villa-name slot. Multi-villa
// owners now get ONE ping carrying the totals and a portfolio link; a
// single-villa owner keeps exactly what they had.
process.env.LISTING_SYNC_SECRET = 'test-secret';
process.env.META_WA_TOKEN = 't'; process.env.META_WA_PHONE_ID = 'p';
const { sendWeeklyOwnerReports } = await import('../api/cron-followups.js');
const { portfolioToken, reportToken } = await import('../lib/tokens.js');

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

const owners = [
  { id: 43, name: 'Ikiel P', wa_num: '628120000048', listing_slugs: ['haus-1', 'lanehaus-3', 'villa-saturno'], opt_in: true, report_enabled: true, last_report_sent_at: null },
  { id: 3, name: 'Vira', wa_num: '8615900764173', listing_slugs: ['villa-rice'], opt_in: true, report_enabled: true, last_report_sent_at: null },
];
const feed = { owners: [
  { slug: 'haus-1', waNumber: '628120000048', role: 'ops' }, { slug: 'lanehaus-3', waNumber: '628120000048', role: 'ops' },
  { slug: 'villa-saturno', waNumber: '628120000048', role: 'ops' }, { slug: 'villa-rice', waNumber: '8615900764173', role: 'ops' },
] };
const reports = {
  'haus-1': { name: 'HAUS Canggu – Unit 1', week: { from: '2026-08-31', to: '2026-09-06' }, metrics: { views: { now: 46 }, enquiries: { now: 2 } } },
  'lanehaus-3': { name: 'LaneHAUS – Unit 3', week: { from: '2026-08-31', to: '2026-09-06' }, metrics: { views: { now: 60 }, enquiries: { now: 3 } } },
  'villa-saturno': { name: 'Villa Saturno', week: { from: '2026-08-31', to: '2026-09-06' }, metrics: { views: { now: 22 }, enquiries: { now: 1 } } },
  'villa-rice': { name: 'Villa Rice', week: { from: '2026-08-31', to: '2026-09-06' }, metrics: { views: { now: 35 }, enquiries: { now: 0 } } },
};

let sends = [], logs = [];
let rejectTemplates = new Set(); // template names Meta answers "not usable" (132001) for
function stub() {
  sends = []; logs = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('graph.facebook.com')) {
      const body = JSON.parse(opts.body);
      if (rejectTemplates.has(body.template.name)) return { ok: false, json: async () => ({ error: { code: 132001 } }) };
      sends.push(body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.' + sends.length }] }) };
    }
    if (u.includes('/rest/v1/owners?') && !opts.method) return { ok: true, json: async () => owners };
    if (u.includes('/rest/v1/wa_messages')) { logs.push(JSON.parse(opts.body)); return { ok: true, json: async () => [] }; }
    if (u.includes('/rest/v1/owners?id=')) return { ok: true, json: async () => [] };
    if (u.includes('owner_sync=1')) return { ok: true, json: async () => feed };
    const m = u.match(/action=report&slug=([a-z0-9-]+)/);
    if (m) return { ok: true, json: async () => reports[m[1]] };
    return { ok: true, json: async () => [] };
  };
}
const db = { SUPABASE_URL: 'http://x', sbHeaders: {}, WA_TOKEN: 't', WA_PHONE_ID: 'p' };
// Node's ICU prints the month as 'Sep' or 'Sept' depending on the build; the
// cron's fmtWeekRange uses the same call, so derive the expectation from it.
const WEEK = '31–' + new Date('2026-09-06T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const bodyParams = (s) => s.template.components.find(c => c.type === 'body').parameters.map(p => p.text);
const linkParam = (s) => s.template.components.find(c => c.type === 'button').parameters[0].text;

{
  stub();
  const out = await sendWeeklyOwnerReports(db);
  t('two owners, two messages (was four)', [out.sent, sends.length], [2, 2]);
  const ikiel = sends.find(s => s.to === '628120000048'), vira = sends.find(s => s.to === '8615900764173');
  t('the multi-villa owner gets the portfolio template', ikiel.template.name, 'samba_owner_portfolio_report_v1');
  t('…with name, week, villa count, total views, total enquiries', bodyParams(ikiel), ['Ikiel', WEEK, '3', '128', '6']);
  t('…and a portfolio link over the sorted slug set', linkParam(ikiel), portfolioToken(['haus-1', 'lanehaus-3', 'villa-saturno']));
  t('the single-villa owner is untouched: v3 template, four params', [vira.template.name, bodyParams(vira)], ['samba_owner_weekly_report_v3', ['Vira', WEEK, '35', '0']]);
  t('…with her villa\'s own report link', linkParam(vira), reportToken('villa-rice'));
  t('the inbox log carries one line per message', logs.map(l => l.content), [
    '[Weekly report sent — 3 villas: 128 views, 6 enquiries]',
    '[Weekly report sent — Villa Rice: 35 views, 0 enquiries]',
  ]);
}
{
  // Meta has not approved the portfolio template yet: same totals, same link,
  // v3 wording — still ONE message.
  stub(); rejectTemplates = new Set(['samba_owner_portfolio_report_v1']);
  const out = await sendWeeklyOwnerReports(db);
  const ikiel = sends.find(s => s.to === '628120000048');
  t('portfolio template pending → falls through to v3, still one message', [out.sent, ikiel.template.name], [2, 'samba_owner_weekly_report_v3']);
  t('…with four params (totals) and the portfolio link', [bodyParams(ikiel), linkParam(ikiel)], [['Ikiel', WEEK, '128', '6'], portfolioToken(['haus-1', 'lanehaus-3', 'villa-saturno'])]);
  rejectTemplates = new Set();
}
{
  // Preview mode reports the plan and sends nothing.
  stub();
  const out = await sendWeeklyOwnerReports({ ...db, preview: true });
  t('preview sends nothing', sends.length, 0);
  t('…and plans one row per owner with their villas', out.plan.map(p => [p.owner, p.villas.length]), [['Ikiel P', 3], ['Vira', 1]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
