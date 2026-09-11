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
const cfg = introFollowConfig({ intro_follow_max: 2 });
const intro = (id, daysAgo, extra = {}) => ({ id, campaign_engagement: { samba: { status: 'intro_sent', intro_at: ago(daysAgo), ...extra } } });
t('defaults', introFollowConfig({}), { intro_follow_max: 1, intro_follow_gap_days: 13, intro_follow_weekly_cap: 25 });
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
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1);

// ── intro question (rung two) ──────────────────────────────────────
{
  const { introQuestionDue, pickIntroQuestions, classifyIntroButton, introTapPatch, introTapReply, pickOpeningCards, introQuestionConfig, INTRO_QUESTION_BODY, INTRO_QUESTION_BUTTONS } = await import('../lib/intro-question.js');
  let p2 = 0, f2 = 0;
  const t2 = (name, got, expect) => { const ok = JSON.stringify(got) === JSON.stringify(expect); if (ok) { p2++; console.log(`  ok  ${name}`); } else { f2++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); } };
  const qcfg = introQuestionConfig({});
  const intro = (id, daysAgo, extra = {}) => ({ id, name: 'Febri Astuti', campaign_engagement: { samba: { status: 'intro_sent', intro_at: ago(daysAgo), ...extra } } });
  t2('template body fits Meta and both variables are inside the text', [INTRO_QUESTION_BODY.length <= 1024, !/^\{\{|\}\}$/.test(INTRO_QUESTION_BODY)], [true, true]);
  t2('three buttons, each ≤ 25 chars', INTRO_QUESTION_BUTTONS.map(b => b.length <= 25), [true, true, true]);
  t2('23 days after the intro → asked', introQuestionDue(intro(1, 23), qcfg, now), true);
  t2('6 days after → not yet', introQuestionDue(intro(2, 6), qcfg, now), false);
  t2('already asked → never again', introQuestionDue(intro(3, 40, { intro_question_at: ago(10) }), qcfg, now), false);
  t2('daily cap, oldest first', pickIntroQuestions([intro(10, 20), intro(11, 40), intro(12, 30)], { intro_question_daily_cap: 2 }, now).map(a => a.id), [11, 12]);
  t2('cap 0 switches it off', pickIntroQuestions([intro(10, 20)], { intro_question_daily_cap: 0 }, now).length, 0);
  t2('tap: Yes, send them', classifyIntroButton('Yes, send them', 'Yes, send them'), 'yes');
  t2('tap: Not an agent', classifyIntroButton('Not an agent', 'Not an agent'), 'not_agent');
  t2('tap: Not now', classifyIntroButton('Not now', 'Not now'), 'not_now');
  t2('Maya quick-reply ids are not intro taps', classifyIntroButton('MAYA_QR_2', 'Check other dates'), null);
  t2('yes → opted in', introTapPatch(intro(4, 20), 'yes', now).campaign_engagement.samba.status, 'opted_in');
  t2('not an agent → declined + alerts off', [introTapPatch(intro(5, 20), 'not_agent', now).campaign_engagement.samba.status, introTapPatch(intro(5, 20), 'not_agent', now).samba_alerts_opt_out], ['declined_not_agent', true]);
  t2('not now → stalled', introTapPatch(intro(6, 20), 'not_now', now).campaign_engagement.samba.status, 'intro_stalled');
  t2('yes reply carries the personal link and commission', [/aid=4\b/.test(introTapReply(intro(4, 20), 'yes')), /10% commission/.test(introTapReply(intro(4, 20), 'yes')), /^Great, Febri,/.test(introTapReply(intro(4, 20), 'yes'))], [true, true, true]);
  t2('a phone-number name gets no greeting name', /^Great, here/.test(introTapReply({ id: 9, name: '+6281234', campaign_engagement: { samba: {} } }, 'yes')), true);
  t2('opening cards: available now first, three max', pickOpeningCards([{ slug: 'a', subtitle: 'x' }, { slug: 'b', subtitle: 'y · Available now' }, { slug: 'c', subtitle: 'z' }, { slug: 'd', subtitle: 'w' }]).map(c => c.slug), ['b', 'a', 'c']);

  // the digest waits for the question once the template is live
  const { introFollowDue, introStallDue, introFollowConfig: ifc } = await import('../lib/intro-follow.js');
  const c2 = ifc({});
  t2('default is one digest after the question', c2.intro_follow_max, 1);
  t2('question live, not asked → digest waits', introFollowDue(intro(20, 30), c2, now, { questionLive: true }), false);
  t2('question pending at Meta → digest follows the intro', introFollowDue(intro(21, 30), c2, now, { questionLive: false }), true);
  t2('asked 14 days ago → digest due', introFollowDue(intro(22, 40, { intro_question_at: ago(14) }), c2, now, { questionLive: true }), true);
  t2('asked 5 days ago → digest waits for the gap', introFollowDue(intro(23, 40, { intro_question_at: ago(5) }), c2, now, { questionLive: true }), false);
  t2('question + digest + 14 quiet days → stalled', introStallDue(intro(24, 60, { intro_question_at: ago(30), intro_digests: 1, last_intro_digest_at: ago(14) }), c2, now, { questionLive: true }), true);
  console.log(`\nintro question: ${p2} passed, ${f2} failed`); if (f2) process.exit(1);
}
