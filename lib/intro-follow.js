// Intro follow-through — the second and third hello.
//
// The intro sweep sends one cold carousel and parks the contact at
// 'intro_sent': out of the daily stream until they answer. Right: a daily
// series off the back of an unsolicited message is what costs a number its
// quality rating. But "parked" had no exit. On 11 Sep 2026, 51 agents had
// been sitting at intro_sent since 19 Aug with no second touch of any kind.
//
// The ladder now: intro → (gap) question with buttons (lib/intro-question.js)
// → (gap) Monday digest → stalled. While the question template is not yet
// approved the digest follows the intro directly, so the ladder never waits
// on Meta.
// A reply at any rung promotes to opted_in (webhook). Stalled contacts are
// left alone by every sweep (the /stalled/ regex in the base gate) but a
// reply still promotes them.

import { sambaStatus, INTRO_SENT, INTRO_STALLED } from './tiers.js';

export const INTRO_FOLLOW_DEFAULTS = {
  intro_follow_max: 1,          // digests after the question before we stop
  intro_follow_gap_days: 13,    // min days between touches (a fortnight of Mondays)
  intro_follow_weekly_cap: 25,  // per Monday; 0 switches the rung off
};

export function introFollowConfig(config = {}) {
  const out = { ...INTRO_FOLLOW_DEFAULTS };
  for (const k of Object.keys(out)) {
    if (config[k] !== undefined && config[k] !== null && config[k] !== '') {
      const n = parseInt(config[k], 10);
      if (!Number.isNaN(n) && n >= 0) out[k] = n;
    }
  }
  return out;
}

const daysSince = (iso, now) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 8.64e7;
};

/** Last touch on the ladder: the most recent follow digest, else the intro. */
function lastRung(samba, agent) {
  const stamps = [samba.last_intro_digest_at, samba.intro_question_at, samba.intro_at, agent.last_availability_alert_at]
    .map(s => (s ? Date.parse(s) : NaN)).filter(n => !Number.isNaN(n));
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
}

/** Pure: is this introduced-but-silent contact due for the next digest? */
export function introFollowDue(agent, cfg, now = new Date(), { questionLive = false } = {}) {
  if (sambaStatus(agent) !== INTRO_SENT) return false;
  const samba = agent.campaign_engagement.samba;
  // Once the question template is live, the digest only follows the question.
  if (questionLive && !samba.intro_question_at) return false;
  if ((samba.intro_digests || 0) >= cfg.intro_follow_max) return false;
  return daysSince(lastRung(samba, agent), now) >= cfg.intro_follow_gap_days;
}

/** Pure: has this contact had every rung and stayed silent long enough? */
export function introStallDue(agent, cfg, now = new Date(), { questionLive = false } = {}) {
  if (sambaStatus(agent) !== INTRO_SENT) return false;
  const samba = agent.campaign_engagement.samba;
  if (questionLive && !samba.intro_question_at) return false;
  if ((samba.intro_digests || 0) < cfg.intro_follow_max) return false;
  return daysSince(lastRung(samba, agent), now) >= cfg.intro_follow_gap_days;
}

/**
 * Pure: the Monday's follow-through cohort, oldest intro first, capped.
 * `gate` is the caller's base eligibility (opt-out, dead number, marketing cap…).
 */
export function pickIntroFollowUps(agents, config, now, gate = () => true, opts = {}) {
  const cfg = introFollowConfig(config);
  if (cfg.intro_follow_weekly_cap <= 0 || cfg.intro_follow_max <= 0) return [];
  return agents
    .filter(a => introFollowDue(a, cfg, now, opts) && gate(a))
    .sort((a, b) => Date.parse(a.campaign_engagement.samba.intro_at || 0) - Date.parse(b.campaign_engagement.samba.intro_at || 0) || a.id - b.id)
    .slice(0, cfg.intro_follow_weekly_cap);
}

/** The samba record after a follow digest went out. */
export function stampIntroFollow(agent, now = new Date()) {
  const samba = agent.campaign_engagement?.samba || {};
  return {
    ...(agent.campaign_engagement || {}),
    samba: { ...samba, intro_digests: (samba.intro_digests || 0) + 1, last_intro_digest_at: now.toISOString() },
  };
}

/** Nightly: park exhausted, still-silent intros as stalled. */
export async function runIntroStall({ SUPABASE_URL, sbHeaders }, agents, config, now = new Date(), { dryRun = false, questionLive = false } = {}) {
  const cfg = introFollowConfig(config);
  const due = agents.filter(a => introStallDue(a, cfg, now, { questionLive }));
  const summary = { stalled: 0, due: due.length, errors: 0, dry_run: dryRun };
  if (dryRun) { summary.sample = due.slice(0, 10).map(a => ({ id: a.id, name: a.name })); return summary; }
  for (const a of due) {
    const samba = a.campaign_engagement.samba;
    const patch = { campaign_engagement: { ...a.campaign_engagement, samba: { ...samba, status: INTRO_STALLED, stalled_at: now.toISOString() } } };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${a.id}`, { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(patch) }).catch(() => null);
    if (r && r.ok) summary.stalled++; else summary.errors++;
  }
  return summary;
}
