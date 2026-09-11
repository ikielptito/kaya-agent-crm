import { normTier, tierSplit, planTierBackfill, inferTier } from '../lib/tiers.js';
import { introFollowDue, introStallDue, pickIntroFollowUps, stampIntroFollow, introFollowConfig } from '../lib/intro-follow.js';
let pass = 0, fail = 0;
const t = (name, got, expect) => { const ok = JSON.stringify(got) === JSON.stringify(expect); if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); } };
const now = new Date('2026-09-11T02:00:00Z');
const ago = (d) => new Date(now.getTime() - d * 8.64e7).toISOString();
const en = (id, tier, extra = {}) => ({ id, engagement_tier: tier, campaign_engagement: { samba: { status: 'enrolled' } }, ...extra });

// vocabulary
t('hot is active', normTier('hot'), 'active');
t('cold is dormant', normTier('cold'), 'dormant');
t('cooling is warm', normTier('Cooling '), 'warm');
t('canonical passes through', normTier('champion'), 'champion');
t('empty is empty', normTier(null), '');
t('typo is empty', normTier('actve'), '');

// the 11 Sep 2026 briefing: 347 enrolled, four buckets quoted summing to 236
const audience = [
  ...Array.from({ length: 32 }, (_, i) => en(i, 'hot')),
  ...Array.from({ length: 55 }, (_, i) => en(100 + i, 'active')),
  ...Array.from({ length: 65 }, (_, i) => en(200 + i, 'warm')),
  ...Array.from({ length: 84 }, (_, i) => en(300 + i, 'dormant')),
  ...Array.from({ length: 17 }, (_, i) => en(400 + i, 'new')),
  ...Array.from({ length: 3 }, (_, i) => en(500 + i, 'cold')),
  en(510, 'cooling'), en(511, 'champion'), en(512, 'champion'),
  ...Array.from({ length: 37 }, (_, i) => en(600 + i, null)),
  ...Array.from({ length: 51 }, (_, i) => ({ id: 700 + i, engagement_tier: null, campaign_engagement: { samba: { status: 'intro_sent', intro_at: ago(23) } } })),
];
const split = tierSplit(audience);
t('total is the enrolled count', split.total, 347);
t('buckets sum to the total', Object.values(split.tiers).reduce((s, n) => s + n, 0) + split.introduced + split.stalled, 347);
t('hot folds into active', split.tiers.active, 87);
t('cold folds into dormant', split.tiers.dormant, 87);
t('introduced-silent are their own stage', split.introduced, 51);
t('untagged counted, not dropped', split.tiers.untagged, 37);
t('line reads as a sum', split.line, '347 total = 296 opted in (2 champion, 87 active, 17 new, 66 warm, 87 dormant, 37 untagged) + 51 introduced, no reply yet');

// backfill
t('replied last month → active', inferTier({ last_inbound_at: ago(12) }, now).tier, 'active');
t('replied two months ago → warm', inferTier({ last_inbound_at: ago(60) }, now).tier, 'warm');
t('never replied → dormant', inferTier({}, now).tier, 'dormant');
const plan = planTierBackfill([
  en(1, null, { last_inbound_at: ago(3) }),
  en(2, 'hot'),
  en(3, 'warm'),
  en(4, 'cooling'),
  en(5, null, { is_test: true }),
  { id: 6, engagement_tier: null, campaign_engagement: { samba: { status: 'intro_sent' } } },
  { id: 7, engagement_tier: null },
], now);
t('backfill touches only empty and alias rows', plan.map(p => [p.id, p.to]), [[1, 'active'], [2, 'active'], [4, 'warm']]);
t('a tier Maya chose is kept', plan.find(p => p.id === 3), undefined);
t('introduced contacts are not tiered', plan.find(p => p.id === 6), undefined);

// intro follow-through
const cfg = introFollowConfig({});
const intro = (id, daysAgo, extra = {}) => ({ id, campaign_engagement: { samba: { status: 'intro_sent', intro_at: ago(daysAgo), ...extra } } });
t('defaults', cfg, { intro_follow_max: 2, intro_follow_gap_days: 13, intro_follow_weekly_cap: 25 });
t('settings override', introFollowConfig({ intro_follow_weekly_cap: '10', intro_follow_max: 3 }).intro_follow_weekly_cap, 10);
t('23 days after the intro → due', introFollowDue(intro(1, 23), cfg, now), true);
t('6 days after the intro → not yet', introFollowDue(intro(2, 6), cfg, now), false);
t('digest 7 days ago → not yet', introFollowDue(intro(3, 30, { intro_digests: 1, last_intro_digest_at: ago(7) }), cfg, now), false);
t('digest 14 days ago, one rung left → due', introFollowDue(intro(4, 30, { intro_digests: 1, last_intro_digest_at: ago(14) }), cfg, now), true);
t('two digests sent → never due again', introFollowDue(intro(5, 60, { intro_digests: 2, last_intro_digest_at: ago(14) }), cfg, now), false);
t('two digests, 14 quiet days → stall', introStallDue(intro(6, 60, { intro_digests: 2, last_intro_digest_at: ago(14) }), cfg, now), true);
t('two digests, 3 quiet days → not yet stalled', introStallDue(intro(7, 60, { intro_digests: 2, last_intro_digest_at: ago(3) }), cfg, now), false);
t('an opted-in agent is never on the ladder', introFollowDue(en(8, 'warm'), cfg, now), false);
const pool = [intro(10, 20), intro(11, 40), intro(12, 2), intro(13, 30), en(14, 'active')];
t('oldest intro first, capped, gated', pickIntroFollowUps(pool, { intro_follow_weekly_cap: 2 }, now, a => a.id !== 11).map(a => a.id), [13, 10]);
t('cap 0 switches the rung off', pickIntroFollowUps(pool, { intro_follow_weekly_cap: 0 }, now).length, 0);
t('stamp bumps the count and keeps the record', stampIntroFollow(intro(15, 20), now).samba, { status: 'intro_sent', intro_at: ago(20), intro_digests: 1, last_intro_digest_at: now.toISOString() });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
