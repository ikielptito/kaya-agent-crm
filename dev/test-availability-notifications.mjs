// Logic test for runAvailabilityNotifications.
// Mocks Supabase REST + the availability_checker digest endpoint, drives the
// helper through every important branch, and asserts on the returned summary
// and the recorded side effects (PATCHes to agents, POSTs to wa_messages,
// settings upserts).
//
// Run: /opt/homebrew/bin/node dev/test-availability-notifications.mjs

process.env.AVAILABILITY_DIGEST_URL = 'http://digest/api/digest';
process.env.DIGEST_SHARED_SECRET = 'digest_secret';

const { runAvailabilityNotifications } = await import('/Users/ikiel/kaya-agent-crm/api/cron-followups.js');

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS', label);
  else { failures++; console.log('FAIL', label, extra ?? ''); }
}

// ── Mock fixtures ──────────────────────────────────────────────────
const T0 = '2026-06-12';
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function makeDigest(overrides = []) {
  const props = [
    { id: '11621510', slug: 'haus-1', name: 'HAUS Canggu – Unit 1', tag: 'Batu Bolong', monthly: '27jt', yearly: '270jt', portalUrl: 'x/haus-1', isCustom: false, isHidden: false,
      availability: { availableToday: true, nextAvailableFrom: T0, nextLongWindowFrom: T0, longWindowDays: 90 } },
    { id: '11621511', slug: 'haus-2', name: 'HAUS Canggu – Unit 2', tag: 'Batu Bolong', monthly: '27jt', yearly: '270jt', portalUrl: 'x/haus-2', isCustom: false, isHidden: false,
      availability: { availableToday: false, nextAvailableFrom: addDays(T0, 14), nextLongWindowFrom: addDays(T0, 14), longWindowDays: 60 } },
    { id: 'c_villa-sunrise', slug: 'villa-sunrise', name: 'Villa Sunrise', tag: 'Umalas', monthly: '35jt', yearly: '350jt', portalUrl: 'x/villa-sunrise', isCustom: true, isHidden: false,
      availability: { availableToday: true, nextAvailableFrom: T0, nextLongWindowFrom: T0, longWindowDays: 120 } },
  ];
  for (const o of overrides) {
    const target = props.find(p => p.id === o.id);
    if (target) Object.assign(target, o);
    else props.push(o);
  }
  return { asOf: new Date().toISOString(), portalBase: 'https://sambarentals.vercel.app', horizonDays: 180, longWindowDays: 30, properties: props };
}

// Default = both v1 and v2 templates approved. Individual tests override
// by passing a subset.
const TEMPLATES_BOTH = {
  samba_availability_alert:     { name: 'samba_availability_alert',     language: 'en', body: 'Hi {{1}}\n{{2}}\n{{3}}' },
  samba_availability_digest:    { name: 'samba_availability_digest',    language: 'en', body: 'Hi {{1}}\n{{2}}\n{{3}}' },
  samba_availability_alert_v2:  { name: 'samba_availability_alert_v2',  language: 'en', body: 'Hi {{1}}\n• {{2}}\n• {{3}}\n• {{4}}\n{{5}}\n{{6}}' },
  samba_availability_digest_v2: { name: 'samba_availability_digest_v2', language: 'en', body: 'Hi {{1}}\n• {{2}}\n• {{3}}\n• {{4}}\n• {{5}}\n• {{6}}\n• {{7}}\n• {{8}}\n{{9}}' },
};
const TEMPLATES_V1_ONLY = {
  samba_availability_alert:  TEMPLATES_BOTH.samba_availability_alert,
  samba_availability_digest: TEMPLATES_BOTH.samba_availability_digest,
};
const TEMPLATES = TEMPLATES_BOTH;

function makeAgent(over = {}) {
  return {
    id: '1', name: 'Era Putri', wa_num: '6281200001111',
    automation_override: null, samba_alerts_opt_out: false, is_test: false,
    last_availability_alert_at: null,
    campaign_engagement: { samba: { status: 'opted_in' } },
    ...over,
  };
}

// ── Mock environment harness ───────────────────────────────────────
function makeMockEnv({ digest, settings = {}, agentPatches = [], waMessages = [], metaSends = [], waSendOk = true }) {
  const settingsState = { ...settings };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(process.env.AVAILABILITY_DIGEST_URL)) {
      if ((opts.headers?.Authorization || '') !== 'Bearer digest_secret') return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => digest };
    }
    if (u.includes('/rest/v1/settings')) {
      if (opts.method === 'POST') {
        const row = JSON.parse(opts.body);
        settingsState[row.key] = row.value;
        return { ok: true, json: async () => ([]) };
      }
      const m = u.match(/key=eq\.([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : null;
      return { ok: true, json: async () => (key && settingsState[key] !== undefined ? [{ value: settingsState[key] }] : []) };
    }
    if (u.includes('/rest/v1/wa_messages')) {
      waMessages.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ([]) };
    }
    if (u.includes('/rest/v1/agents')) {
      agentPatches.push({ url: u, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ([]) };
    }
    if (u.includes('graph.facebook.com')) {
      const body = JSON.parse(opts.body || '{}');
      metaSends.push({
        templateName: body.template?.name,
        params: (body.template?.components?.[0]?.parameters || []).map(p => p.text),
      });
      return { ok: waSendOk, status: waSendOk ? 200 : 400, json: async () => ({ messages: [{ id: 'wamid.fake' }] }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return { settingsState, agentPatches, waMessages, metaSends };
}

const SB_HEADERS = { 'Authorization': 'Bearer sb', 'apikey': 'sb', 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };

function ctx(overrides) {
  return {
    now: new Date('2026-06-12T01:00:00Z'),  // a Friday (UTC day=5)
    sbHeaders: SB_HEADERS, supabaseUrl: 'http://sb',
    agents: [makeAgent()], templatesMap: TEMPLATES,
    waToken: 'wa', waPhoneId: 'phone',
    results: [],
    ...overrides,
  };
}

// ── 1. Kill switch off ─────────────────────────────────────────────
let env = makeMockEnv({ digest: makeDigest() });
let summary = await runAvailabilityNotifications(ctx());
check('kill switch off → no send, no errors', !summary.enabled && summary.event_alerts_sent === 0 && summary.errors.length === 0);
check('kill switch off → no settings written', !env.settingsState.samba_availability_snapshot);

// ── 2. First run with snapshot absent ──────────────────────────────
env = makeMockEnv({ digest: makeDigest(), settings: { samba_availability: { enabled: true } } });
summary = await runAvailabilityNotifications(ctx());
check('first run → no alerts sent (no baseline)', summary.event_alerts_sent === 0 && summary.enabled);
check('first run → snapshot saved for next time', !!env.settingsState.samba_availability_snapshot);
check('first-run snapshot has property entries', Object.keys(env.settingsState.samba_availability_snapshot).length === 3);

// ── 3. Day 2 — property becomes available, eligible agent gets alert
const yesterdaySnap = {
  '11621510': { availableToday: false, nextLongWindowFrom: addDays(T0, 30), monthly: '27jt' },
  '11621511': { availableToday: false, nextLongWindowFrom: addDays(T0, 14), monthly: '27jt' },
  'c_villa-sunrise': { availableToday: true, nextLongWindowFrom: T0, monthly: '35jt' },
};
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
check('day 2 with improvement → alert sent', summary.event_alerts_sent === 1, JSON.stringify(summary));
check('wa_messages logged with category', env.waMessages[0]?.category === 'availability_alert');
check('agent last_availability_alert_at updated', env.agentPatches.some(p => p.body.last_availability_alert_at));
check('snapshot updated post-send', env.settingsState.samba_availability_snapshot['11621510'].availableToday === true);

// ── 4. Frequency cap: agent who got alerted 2 hours ago is skipped
const recentlyAlerted = makeAgent({ last_availability_alert_at: new Date('2026-06-11T23:00:00Z').toISOString() });
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [recentlyAlerted] }));
check('frequency cap respected', summary.event_alerts_sent === 0 && summary.skipped_freq_cap === 1);

// ── 5. Opt-out skip
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ samba_alerts_opt_out: true })],
}));
check('opt-out agent skipped', summary.event_alerts_sent === 0 && summary.skipped_opt_out === 1);

// ── 6. Monday → weekly digest fires regardless of changes
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  now: new Date('2026-06-15T01:00:00Z'),  // Monday UTC
}));
check('Monday → digest sent regardless of changes', summary.weekly_digest_sent === 1 && summary.event_alerts_sent === 0, JSON.stringify(summary));
check('Monday wa_messages logged as digest', env.waMessages[0]?.category === 'availability_digest');

// ── 7. Missing template → loud error, no sends
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: {} }));
check('missing template logs error', summary.errors.some(e => e.includes('templates missing')), summary.errors.join(' | '));
check('missing template sends nothing', summary.event_alerts_sent === 0);

// ── 8. Not eligible: agent not on Samba pipeline
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ campaign_engagement: { kaya: { status: 'opted_in' } } })],
}));
check('non-Samba agent not in recipients', summary.recipients === 0);

// ── 9. test_agents_only cohort
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true, test_agents_only: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ is_test: false }), makeAgent({ id: '2', is_test: true })],
}));
check('test_agents_only filters to is_test=true', summary.recipients === 1 && summary.event_alerts_sent === 1, JSON.stringify(summary));

// ── 10. No changes on non-Monday → no send, but snapshot persisted
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: makeSnapshotFrom(makeDigest()) },
});
summary = await runAvailabilityNotifications(ctx());
check('no changes → no alerts', summary.event_alerts_sent === 0 && summary.skipped_no_changes === 1);

function makeSnapshotFrom(digest) {
  const out = {};
  for (const p of digest.properties) {
    out[p.id] = {
      availableToday: !!p.availability?.availableToday,
      nextLongWindowFrom: p.availability?.nextLongWindowFrom || null,
      monthly: p.monthly || null,
    };
  }
  return out;
}

// ── 11. Price drop triggers an alert
const priceDrop = makeDigest([{ id: '11621510', monthly: '24jt' }]);
env = makeMockEnv({
  digest: priceDrop,
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: makeSnapshotFrom(makeDigest()) },
});
summary = await runAvailabilityNotifications(ctx());
check('price drop triggers alert', summary.event_alerts_sent === 1);

// ── 12. Brand-new property triggers an alert
const newProp = makeDigest([{ id: 'c_new-villa', name: 'Brand New Villa', tag: 'Pererenan', monthly: '25jt', portalUrl: 'x', isCustom: true, isHidden: false,
  availability: { availableToday: true, nextAvailableFrom: T0, nextLongWindowFrom: T0, longWindowDays: 90 } }]);
env = makeMockEnv({
  digest: newProp,
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: makeSnapshotFrom(makeDigest()) },
});
summary = await runAvailabilityNotifications(ctx());
check('new property triggers alert', summary.event_alerts_sent === 1);

// ── 13. Digest fetch failure → graceful skip (Supabase still up)
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
const baseFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith(process.env.AVAILABILITY_DIGEST_URL)) throw new Error('econnrefused');
  return baseFetch(url, opts);
};
summary = await runAvailabilityNotifications(ctx());
check('digest fetch failure surfaces error, no send', summary.errors.some(e => e.includes('digest fetch')) && summary.event_alerts_sent === 0, JSON.stringify(summary));

// Restore baseFetch for the v2 tests
globalThis.fetch = baseFetch;

// ── 14. v2 template preferred when both available ──────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
check('v2 template selected when both v1 and v2 approved', summary.template_version === 'v2', summary.template_version);
check('v2 alert: 6 params per send', env.metaSends.every(s => s.params.length === 6), env.metaSends.map(s => s.params.length).join(','));
check('v2 alert: param 1 = first name', env.metaSends[0]?.params[0] === 'Era');
check('v2 alert: 3 bullet slots filled', env.metaSends[0]?.params.slice(1, 4).every(p => p && p.length > 0));
check('v2 alert: contains bold property name', env.metaSends[0]?.params.slice(1, 4).some(p => p.includes('*')));
check('v2 alert: URL passed as last param', env.metaSends[0]?.params[5]?.startsWith('https://sambarentals'));

// ── 15. v1 fallback when only v1 templates approved ────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: TEMPLATES_V1_ONLY }));
check('v1 fallback when v2 missing', summary.template_version === 'v1', summary.template_version);
check('v1 alert: 3 params per send', env.metaSends.every(s => s.params.length === 3));
check('v1 alert: 2nd param is bullet paragraph (no newlines)', env.metaSends[0]?.params[1] && !env.metaSends[0].params[1].includes('\n'));

// ── 16. Sparse improvements: empty slots padded with — ─────────────
// Snapshot includes entries for every property (all "available yesterday") so
// the only improvement is 11621510 going from unavailable → available.
const oneImprovementSnap = {
  '11621510': { availableToday: false, nextLongWindowFrom: null, monthly: '27jt' },
  '11621511': { availableToday: false, nextLongWindowFrom: addDays(T0, 14), monthly: '27jt' },
  'c_villa-sunrise': { availableToday: true, nextLongWindowFrom: T0, monthly: '35jt' },
};
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: oneImprovementSnap },
});
summary = await runAvailabilityNotifications(ctx());
check('sparse improvement still sends (v2)', summary.event_alerts_sent === 1, JSON.stringify(summary));
const sparseParams = env.metaSends[0]?.params || [];
const slot2Empty = sparseParams[2] === '—';
const slot3Empty = sparseParams[3] === '—';
check('v2 alert: empty bullet slots filled with —', slot2Empty && slot3Empty, sparseParams.slice(1, 4).join(' | '));

// ── 17. v2 digest on Monday: 9 params, 4 avail + 3 soon slots ──────
const mondayCtx = { now: new Date('2026-06-15T01:00:00Z') };
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx(mondayCtx));
check('v2 digest selected on Monday', summary.template_version === 'v2');
check('v2 digest sent 1', summary.weekly_digest_sent === 1, JSON.stringify(summary));
check('v2 digest: 9 params', env.metaSends[0]?.params.length === 9, env.metaSends[0]?.params.length);
check('v2 digest: param 1 = name', env.metaSends[0]?.params[0] === 'Era');
check('v2 digest: avail slots present', env.metaSends[0]?.params.slice(1, 5).every(p => p));
check('v2 digest: URL passed as last', env.metaSends[0]?.params[8]?.startsWith('https://'));

// ── 18. Bold marker survives compose pipeline ──────────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
const allBulletParams = env.metaSends[0]?.params.slice(1, 4) || [];
check('every populated bullet has *bold* property name', allBulletParams.filter(p => p !== '—').every(p => /\*[^*]+\*/.test(p)), allBulletParams.join(' | '));

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
