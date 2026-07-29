// Logic test for runAvailabilityNotifications.
// Mocks Supabase REST + the availability_checker digest endpoint, drives the
// helper through every important branch, and asserts on the returned summary
// and the recorded side effects (PATCHes to agents, POSTs to wa_messages,
// settings upserts).
//
// Guards the July 2026 design:
//   - HIGH_SIGNAL_MIN = 3: non-Monday event alerts need ≥3 genuine
//     improvements; sparse days roll into the Monday digest (no send).
//   - Tier-based cadence: dormant/'cold'/unknown tiers are muted from the
//     daily event stream (Monday digest only); missing tier defaults to warm.
//   - 3-wave stagger: wave 0 diffs + stashes + advances the snapshot;
//     waves ≥1 reuse the stash and send to their id-modulo cohort only.
//   - v3 templates with per-agent intro on first-ever availability send.
//   - contact_frequency preference: weekly/monthly/paused throttles.
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

// Default = v1, v2, v3 templates all approved. Individual tests override
// by passing a subset. Each fixture includes placeholderCount matching
// what production's loadTemplatesMap computes from the body.
function tmplWithCount(name, body) {
  return { name, language: 'en', body, placeholderCount: (body.match(/\{\{(\d+)\}\}/g) || []).length };
}
const BODY_PARAGRAPH = 'Hi {{1}}\n{{2}}\n{{3}}';
const BODY_ALERT_SLOTS = 'Hi {{1}}\n• {{2}}\n• {{3}}\n• {{4}}\n{{5}}\n{{6}}';
const BODY_DIGEST_SLOTS = 'Hi {{1}}\n• {{2}}\n• {{3}}\n• {{4}}\n• {{5}}\n• {{6}}\n• {{7}}\n• {{8}}\n{{9}}';
const BODY_INTRO_SLOTS = 'Hi {{1}}, Maya here.\n• {{2}}\n• {{3}}\n• {{4}}\n{{5}}\n{{6}}';
const TEMPLATES_BOTH = {
  samba_availability_alert:     tmplWithCount('samba_availability_alert',     BODY_PARAGRAPH),
  samba_availability_digest:    tmplWithCount('samba_availability_digest',    BODY_PARAGRAPH),
  samba_availability_alert_v2:  tmplWithCount('samba_availability_alert_v2',  BODY_ALERT_SLOTS),
  samba_availability_digest_v2: tmplWithCount('samba_availability_digest_v2', BODY_DIGEST_SLOTS),
};
const TEMPLATES_V1_ONLY = {
  samba_availability_alert:  TEMPLATES_BOTH.samba_availability_alert,
  samba_availability_digest: TEMPLATES_BOTH.samba_availability_digest,
};
const TEMPLATES_V3 = {
  ...TEMPLATES_BOTH,
  samba_availability_intro_v3:  tmplWithCount('samba_availability_intro_v3',  BODY_INTRO_SLOTS),
  samba_availability_alert_v3:  tmplWithCount('samba_availability_alert_v3',  BODY_ALERT_SLOTS),
  samba_availability_digest_v3: tmplWithCount('samba_availability_digest_v3', BODY_DIGEST_SLOTS),
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
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') {
        // Return the introduced agents (those with availability_* messages logged)
        const rows = waMessages
          .filter(m => m.category && m.category.startsWith('availability_') && m.agent_id != null)
          .map(m => ({ agent_id: m.agent_id }));
        return { ok: true, json: async () => rows };
      }
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

// ── 3. Day 2 — three improvements clear the HIGH_SIGNAL_MIN=3 bar ──
// vs today's digest: 11621510 flips unavailable→available, 11621511 price
// drops 30jt→27jt, villa-sunrise flips unavailable→available. Exactly 3
// genuine improvements = the minimum that fires a non-Monday event alert.
const yesterdaySnap = {
  '11621510': { availableToday: false, nextLongWindowFrom: addDays(T0, 30), monthly: '27jt' },
  '11621511': { availableToday: false, nextLongWindowFrom: addDays(T0, 14), monthly: '30jt' },
  'c_villa-sunrise': { availableToday: false, nextLongWindowFrom: T0, monthly: '35jt' },
};
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
check('day 2 with ≥3 improvements → alert sent', summary.event_alerts_sent === 1, JSON.stringify(summary));
check('wa_messages logged with category', env.waMessages[0]?.category === 'availability_alert');
check('agent last_availability_alert_at updated', env.agentPatches.some(p => p.body.last_availability_alert_at));
check('snapshot updated post-send', env.settingsState.samba_availability_snapshot['11621510'].availableToday === true);

// ── 4. Frequency caps ──────────────────────────────────────────────
// 6h idempotency guard: alerted 2h ago → skipped whatever the tier.
const recentlyAlerted = makeAgent({ last_availability_alert_at: new Date('2026-06-11T23:00:00Z').toISOString() });
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [recentlyAlerted] }));
check('6h idempotency guard respected', summary.event_alerts_sent === 0 && summary.skipped_freq_cap === 1, JSON.stringify(summary));

// 72h tier cap: default (missing) tier normalises to warm → alerted 24h ago
// is still inside the 72h window → skipped.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ last_availability_alert_at: new Date('2026-06-11T01:00:00Z').toISOString() })],
}));
check('72h cap: alerted 24h ago skipped (warm default)', summary.event_alerts_sent === 0 && summary.skipped_freq_cap === 1, JSON.stringify(summary));

// …but alerted 80h ago is past the cap → sends.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ last_availability_alert_at: new Date('2026-06-08T17:00:00Z').toISOString() })],
}));
check('72h cap: alerted 80h ago sends', summary.event_alerts_sent === 1, JSON.stringify(summary));

// ── 5. Opt-out skip
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  agents: [makeAgent({ samba_alerts_opt_out: true })],
}));
check('opt-out agent skipped', summary.event_alerts_sent === 0, JSON.stringify(summary));

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
check('missing template logs error', summary.errors.some(e => e.includes('no template available')), summary.errors.join(' | '));
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

// ── 11. HIGH_SIGNAL_MIN bar: 1–2 improvements roll into the digest ─
// Single improvement (11621510 unavailable→available) → below the bar:
// nothing sends, but the snapshot still advances so tomorrow's diff is
// against today, not against the stale baseline.
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
check('1 improvement → below signal bar, no alert', summary.event_alerts_sent === 0 && summary.skipped_no_changes === 1 && summary.below_signal_bar === 1, JSON.stringify(summary));
check('below-bar day still advances snapshot', env.settingsState.samba_availability_snapshot['11621510'].availableToday === true);

// Two improvements → still below the bar.
const twoImprovementSnap = { ...oneImprovementSnap, '11621511': { availableToday: false, nextLongWindowFrom: addDays(T0, 14), monthly: '30jt' } };
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: twoImprovementSnap },
});
summary = await runAvailabilityNotifications(ctx());
check('2 improvements → still below signal bar', summary.event_alerts_sent === 0 && summary.below_signal_bar === 2, JSON.stringify(summary));

// ── 12. Price drops count as improvements ──────────────────────────
// Three simultaneous price drops clear the bar and render as 💰 bullets.
const priceSnap = makeSnapshotFrom(makeDigest());
priceSnap['11621510'].monthly = '30jt';
priceSnap['11621511'].monthly = '30jt';
priceSnap['c_villa-sunrise'].monthly = '40jt';
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: priceSnap },
});
summary = await runAvailabilityNotifications(ctx());
check('3 price drops → alert sent', summary.event_alerts_sent === 1, JSON.stringify(summary));
check('price-drop bullet mentions the drop', (env.metaSends[0]?.params || []).slice(1, 4).every(p => p.includes('price dropped')), env.metaSends[0]?.params?.join(' | '));

// ── 13. New property counts and sorts first ────────────────────────
// yesterdaySnap already yields 3 improvements; adding a brand-new listing
// makes 4 — the 🆕 item must render in bullet 1 (REASON_PRIORITY) and the
// 4th improvement overflows into the "+N more" slot.
const newProp = makeDigest([{ id: 'c_new-villa', slug: 'new-villa', name: 'Brand New Villa', tag: 'Pererenan', monthly: '25jt', portalUrl: 'x', isCustom: true, isHidden: false,
  availability: { availableToday: true, nextAvailableFrom: T0, nextLongWindowFrom: T0, longWindowDays: 90 } }]);
env = makeMockEnv({
  digest: newProp,
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
check('new property → alert sent', summary.event_alerts_sent === 1, JSON.stringify(summary));
check('new property sorts into bullet 1 with 🆕', (env.metaSends[0]?.params[1] || '').startsWith('🆕') && env.metaSends[0]?.params[1].includes('Brand New Villa'), env.metaSends[0]?.params[1]);
check('4th improvement overflows into "+1 more" slot', env.metaSends[0]?.params[4] === '+ 1 more on the portal', env.metaSends[0]?.params[4]);

// ── 14. Long-window direction: earlier = news, later = not ─────────
// Only change vs snapshot: 11621511's long window moves 14 days EARLIER
// (T0+28 → T0+14). That is 1 improvement (below bar, so no send — assert
// via the below_signal_bar count).
const earlierSnap = makeSnapshotFrom(makeDigest());
earlierSnap['11621511'].nextLongWindowFrom = addDays(T0, 28);
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: earlierSnap },
});
summary = await runAvailabilityNotifications(ctx());
check('window moving ≥7 days earlier counts as improvement', summary.below_signal_bar === 1, JSON.stringify(summary));

// Window moving LATER (T0 → T0+14, i.e. someone booked) is not news.
const laterSnap = makeSnapshotFrom(makeDigest());
laterSnap['11621511'].nextLongWindowFrom = T0;
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: laterSnap },
});
summary = await runAvailabilityNotifications(ctx());
check('window moving later is NOT an improvement', summary.below_signal_bar === 0, JSON.stringify(summary));

// ── 15. Digest fetch failure → graceful skip (Supabase still up)
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

// ── 16. v2 template preferred when both available ──────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
check('v2 template selected when both v1 and v2 approved', summary.template_version === 'v2', summary.template_version);
check('v2 alert: 6 params per send', env.metaSends.every(s => s.params.length === 6), env.metaSends.map(s => s.params.length).join(','));
check('v2 alert: param 1 = first name', env.metaSends[0]?.params[0] === 'Era');
check('v2 alert: 3 bullet slots filled', env.metaSends[0]?.params.slice(1, 4).every(p => p && p.length > 0 && p !== '—'));
check('v2 alert: contains bold property name', env.metaSends[0]?.params.slice(1, 4).some(p => p.includes('*')));
check('v2 alert: exactly 3 improvements → overflow slot padded with —', env.metaSends[0]?.params[4] === '—', env.metaSends[0]?.params[4]);
check('v2 alert: URL passed as last param', env.metaSends[0]?.params[5]?.startsWith('https://sambarentals'));

// ── 17. v1 fallback when only v1 templates approved ────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: TEMPLATES_V1_ONLY }));
check('v1 fallback when v2 missing', summary.template_version === 'v1', summary.template_version);
check('v1 alert sent', summary.event_alerts_sent === 1, JSON.stringify(summary));
check('v1 alert: 3 params per send', env.metaSends.length > 0 && env.metaSends.every(s => s.params.length === 3));
check('v1 alert: 2nd param is bullet paragraph (no newlines)', env.metaSends[0]?.params[1] && !env.metaSends[0].params[1].includes('\n'));

// ── 18. v2 digest on Monday: 9 params, 4 avail + 3 soon slots ──────
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

// ── 19. Bold marker survives compose pipeline ──────────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx());
const allBulletParams = env.metaSends[0]?.params.slice(1, 4) || [];
check('every populated bullet has *bold* property name', allBulletParams.filter(p => p !== '—').every(p => /\*[^*]+\*/.test(p)), allBulletParams.join(' | '));

// ── 20. Tier-based cadence ─────────────────────────────────────────
// Dormant tier is muted from the daily event stream…
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ engagement_tier: 'dormant' })] }));
check('dormant tier: no event alert, skipped_tier_cap', summary.event_alerts_sent === 0 && summary.skipped_tier_cap === 1, JSON.stringify(summary));

// …and legacy 'cold' vocabulary normalises to dormant…
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ engagement_tier: 'cold' })] }));
check("'cold' alias → dormant → muted", summary.event_alerts_sent === 0 && summary.skipped_tier_cap === 1, JSON.stringify(summary));

// …as does unknown vocabulary (mute-by-default, never full stream by accident)…
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ engagement_tier: 'vip' })] }));
check('unknown tier vocabulary → muted', summary.event_alerts_sent === 0 && summary.skipped_tier_cap === 1, JSON.stringify(summary));

// …while 'hot' normalises to active and gets the event stream…
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ engagement_tier: 'hot' })] }));
check("'hot' alias → active → gets event alert", summary.event_alerts_sent === 1, JSON.stringify(summary));

// …and the Monday digest still reaches dormant agents.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ engagement_tier: 'dormant' })], ...mondayCtx }));
check('dormant tier still gets Monday digest', summary.weekly_digest_sent === 1, JSON.stringify(summary));

// ── 21. contact_frequency preference (set by Maya on request) ──────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ contact_frequency: 'weekly' })] }));
check("contact_frequency 'weekly': no daily alert", summary.event_alerts_sent === 0 && summary.skipped_freq_cap === 1, JSON.stringify(summary));

env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ contact_frequency: 'weekly' })], ...mondayCtx }));
check("contact_frequency 'weekly': Monday digest still sends", summary.weekly_digest_sent === 1, JSON.stringify(summary));

env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: [makeAgent({ contact_frequency: 'paused' })], ...mondayCtx }));
check("contact_frequency 'paused': not even the digest", summary.weekly_digest_sent === 0 && summary.skipped_freq_cap === 1, JSON.stringify(summary));

// ── 22. 3-wave stagger ─────────────────────────────────────────────
// Wave 0 diffs, stashes today's improvements, sends to cohort id%3===0,
// and advances the snapshot. Waves ≥1 reuse the stash (a re-diff would see
// "no changes") and send to their own cohort without touching the snapshot.
const waveAgents = [makeAgent({ id: 3 }), makeAgent({ id: 4 }), makeAgent({ id: 5 })];
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: waveAgents, wave: 0, waveCount: 3 }));
check('wave 0: sends only to its cohort (1 of 3 agents)', summary.recipients === 1 && summary.event_alerts_sent === 1 && summary.wave === '1/3', JSON.stringify(summary));
check('wave 0: improvements stashed for later waves', env.settingsState.samba_availability_wave?.date === '2026-06-12' && env.settingsState.samba_availability_wave.items.length === 3, JSON.stringify(env.settingsState.samba_availability_wave));
check('wave 0: snapshot advanced', env.settingsState.samba_availability_snapshot['11621510'].availableToday === true);

// Wave 1 against the SAME settings state (snapshot already advanced).
const snapshotAfterWave0 = JSON.stringify(env.settingsState.samba_availability_snapshot);
summary = await runAvailabilityNotifications(ctx({ agents: waveAgents, wave: 1, waveCount: 3 }));
check('wave 1: reuses stash, sends to its cohort', summary.recipients === 1 && summary.event_alerts_sent === 1 && summary.wave === '2/3', JSON.stringify(summary));
check('wave 1: snapshot untouched', JSON.stringify(env.settingsState.samba_availability_snapshot) === snapshotAfterWave0);
check('waves covered both cohorts (agents 3 then 4)', env.metaSends.length === 2);

// Wave ≥1 with no stash for today (wave 0 never reached a send) → bail.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: waveAgents, wave: 2, waveCount: 3 }));
check('wave 2 without stash → skips with reason', summary.event_alerts_sent === 0 && /no wave stash/.test(summary.skipped_reason || ''), JSON.stringify(summary));

// Below-bar day: wave 0 writes no stash, so wave 1 bails too.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: oneImprovementSnap },
});
summary = await runAvailabilityNotifications(ctx({ agents: waveAgents, wave: 0, waveCount: 3 }));
check('wave 0 below bar → no send, no stash', summary.event_alerts_sent === 0 && !env.settingsState.samba_availability_wave, JSON.stringify(summary));
summary = await runAvailabilityNotifications(ctx({ agents: waveAgents, wave: 1, waveCount: 3 }));
check('wave 1 after below-bar wave 0 → bails on missing stash', summary.event_alerts_sent === 0 && /no wave stash/.test(summary.skipped_reason || ''), JSON.stringify(summary));

// ── 23. v3 INTRO ON FIRST SEND ─────────────────────────────────────
// Agent has zero prior availability messages → gets intro_v3 template.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: TEMPLATES_V3 }));
check('v3 template version reported', summary.template_version === 'v3', summary.template_version);
check('v3 intro: send recorded as intro', summary.intro_sent === 1 && summary.event_alerts_sent === 1, JSON.stringify(summary));
check('v3 intro: wa_messages logged with category availability_intro', env.waMessages[0]?.category === 'availability_intro');
check('v3 intro: intro template used', env.metaSends[0]?.templateName === 'samba_availability_intro_v3', env.metaSends[0]?.templateName);

// ── 24. v3 ALERT ON SECOND SEND ────────────────────────────────────
// Already-introduced agent (wa_messages has a prior availability_alert
// row) gets the regular alert template, not the intro.
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
  waMessages: [{ agent_id: '1', category: 'availability_alert', timestamp: '2026-06-10T01:00:00Z' }],
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: TEMPLATES_V3 }));
check('v3 alert for already-introduced agent', summary.event_alerts_sent === 1 && !summary.intro_sent, JSON.stringify(summary));
check('v3 alert: template name = alert_v3', env.metaSends[0]?.templateName === 'samba_availability_alert_v3', env.metaSends[0]?.templateName);
check('v3 alert: wa_messages category = availability_alert', env.waMessages.find(m => m.source === 'cron')?.category === 'availability_alert');

// ── 25. INTRO FALLBACK WHEN NOT APPROVED ───────────────────────────
// Only alert_v3 is approved (no intro_v3). First-timer gets the regular
// alert template — long-form intro skipped but rebrand wording preserved.
const TEMPLATES_V3_NO_INTRO = { ...TEMPLATES_V3 };
delete TEMPLATES_V3_NO_INTRO.samba_availability_intro_v3;
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({ templatesMap: TEMPLATES_V3_NO_INTRO }));
check('intro falls back to alert when intro_v3 missing', env.metaSends[0]?.templateName === 'samba_availability_alert_v3', env.metaSends[0]?.templateName);
check('intro fallback: still recorded as event_alerts_sent (not intro)', summary.event_alerts_sent === 1 && !summary.intro_sent, JSON.stringify(summary));

// ── 26. v3 DIGEST ON MONDAY ────────────────────────────────────────
env = makeMockEnv({
  digest: makeDigest(),
  settings: { samba_availability: { enabled: true }, samba_availability_snapshot: yesterdaySnap },
});
summary = await runAvailabilityNotifications(ctx({
  templatesMap: TEMPLATES_V3,
  now: new Date('2026-06-15T01:00:00Z'),
}));
check('v3 digest on Monday', env.metaSends[0]?.templateName === 'samba_availability_digest_v3' && summary.weekly_digest_sent === 1);
check('Monday digest: no intro path on Mondays', !summary.intro_sent);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
