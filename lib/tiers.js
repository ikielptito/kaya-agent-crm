// Engagement tiers — one vocabulary, one way to count them.
//
// The tier column has drifted: Maya's reply prompt wrote hot/warm/cold, the
// broadcast cadence speaks champion/active/new/warm/dormant, and a third of
// enrolled agents carry no tier at all. Every reader used to normalise (or
// not) on its own, so the morning briefing quoted four buckets that summed
// to 236 of 347 enrolled agents. This module is the single place that maps a
// raw value to the canonical tier, splits an audience so the buckets add up,
// and back-fills the untagged rows from reply history overnight.

export const CANONICAL_TIERS = ['champion', 'active', 'new', 'warm', 'dormant'];
const ALIASES = { hot: 'active', cold: 'dormant', cooling: 'warm' };

/** Raw column value → canonical tier, or '' when empty/unknown. */
export function normTier(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (!v) return '';
  if (CANONICAL_TIERS.includes(v)) return v;
  return ALIASES[v] || '';
}

export function sambaStatus(agent) {
  return String(agent?.campaign_engagement?.samba?.status || '').toLowerCase().trim();
}

// Introduced-but-silent contacts are in the Samba record (they count as
// "enrolled" everywhere) without ever having said yes. They are not untagged
// agents waiting for a tier — they are a stage of their own.
export const INTRO_SENT = 'intro_sent';
export const INTRO_STALLED = 'intro_stalled';

/**
 * Split an enrolled audience into buckets that sum to its size.
 * Returns { total, opted_in, tiers: {champion, active, new, warm, dormant, untagged},
 *           introduced, stalled, line }.
 */
export function tierSplit(enrolled) {
  const tiers = { champion: 0, active: 0, new: 0, warm: 0, dormant: 0, untagged: 0 };
  let introduced = 0, stalled = 0;
  for (const a of enrolled) {
    const st = sambaStatus(a);
    if (st === INTRO_SENT) { introduced++; continue; }
    if (st === INTRO_STALLED) { stalled++; continue; }
    const t = normTier(a.engagement_tier);
    tiers[t || 'untagged']++;
  }
  const total = enrolled.length;
  const opted_in = total - introduced - stalled;
  const parts = Object.entries(tiers).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  const extras = [];
  if (introduced) extras.push(`${introduced} introduced, no reply yet`);
  if (stalled) extras.push(`${stalled} introduced, went quiet (stalled)`);
  const line = `${total} total = ${opted_in} opted in (${parts.join(', ') || 'none'})${extras.length ? ' + ' + extras.join(' + ') : ''}`;
  return { total, opted_in, tiers, introduced, stalled, line };
}

// ── Backfill ────────────────────────────────────────────────────────
// A tier from reply recency, for rows Maya never tiered. Deliberately
// conservative: it only fills empty cells and canonicalises aliases; a tier
// Maya chose from a conversation is never overwritten.
const ACTIVE_DAYS = 30;
const WARM_DAYS = 90;

export function inferTier(agent, now = new Date()) {
  const t = agent.last_inbound_at ? Date.parse(agent.last_inbound_at) : NaN;
  if (Number.isNaN(t)) return { tier: 'dormant', reason: 'never replied' };
  const days = Math.floor((now.getTime() - t) / 8.64e7);
  if (days <= ACTIVE_DAYS) return { tier: 'active', reason: `replied ${days}d ago` };
  if (days <= WARM_DAYS) return { tier: 'warm', reason: `replied ${days}d ago` };
  return { tier: 'dormant', reason: `last reply ${days}d ago` };
}

/** Pure: which rows to patch and why. */
export function planTierBackfill(agents, now = new Date()) {
  const plan = [];
  for (const a of agents) {
    if (a.is_test) continue;
    if (!a.campaign_engagement?.samba) continue;
    const st = sambaStatus(a);
    if (st === INTRO_SENT || st === INTRO_STALLED) continue;
    const raw = String(a.engagement_tier || '').trim();
    const canon = normTier(raw);
    if (!raw || !canon) {
      // Empty or unknown vocabulary ('cooling' with no alias, a typo): infer.
      const { tier, reason } = inferTier(a, now);
      plan.push({ id: a.id, from: raw || null, to: tier, reason: `tier backfill: ${raw ? `unknown value "${raw}", ` : ''}${reason}` });
    } else if (canon !== raw.toLowerCase()) {
      plan.push({ id: a.id, from: raw, to: canon, reason: `tier vocabulary: ${raw} → ${canon}` });
    }
  }
  return plan;
}

/** Nightly: apply the plan. Logs each change to maya_updates (by_maya=false). */
export async function runTierBackfill({ SUPABASE_URL, sbHeaders }, { now = new Date(), dryRun = false } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id,engagement_tier,last_inbound_at,is_test,campaign_engagement&campaign_engagement=not.is.null`, { headers: sbHeaders });
  const agents = r.ok ? await r.json() : [];
  const plan = planTierBackfill(Array.isArray(agents) ? agents : [], now);
  const summary = { planned: plan.length, applied: 0, errors: 0, dry_run: dryRun, by_tier: {} };
  for (const p of plan) summary.by_tier[p.to] = (summary.by_tier[p.to] || 0) + 1;
  if (dryRun) { summary.sample = plan.slice(0, 10); return summary; }
  for (const p of plan) {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${p.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ engagement_tier: p.to }),
    }).catch(() => null);
    if (!pr || !pr.ok) { summary.errors++; continue; }
    summary.applied++;
    await fetch(`${SUPABASE_URL}/rest/v1/maya_updates`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ agent_id: p.id, field: 'engagement_tier', new_value: p.to, reason: p.reason, evidence: p.from ? `was "${p.from}"` : 'was empty', by_maya: false, created_at: now.toISOString() }),
    }).catch(() => {});
  }
  return summary;
}
