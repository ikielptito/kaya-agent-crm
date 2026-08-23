// Maya's daily Claude spend allowance, with rollover.
//
// Base cap per WITA day: MAYA_DAILY_CAP_USD (default $10). Unused allowance
// from previous days accumulates in a "bank" and can be drawn on a busy day,
// up to MAYA_ROLLOVER_MAX_DAYS × base (default 3 days' worth) on top of the
// base — so a quiet week builds headroom without the number growing without
// bound. Days that overspent reduce the bank. The bank is computed from the
// last 30 days of settings.daily_usage on every check (no extra state).
//
// Ikiel, 23 Aug 2026: "if she doesn't hit the cap on one day, it can roll
// over to the next to cover more high-volume days."

export const BASE_CAP_USD = Number(process.env.MAYA_DAILY_CAP_USD) > 0 ? Number(process.env.MAYA_DAILY_CAP_USD) : 10.00;
export const ROLLOVER_MAX_DAYS = Number(process.env.MAYA_ROLLOVER_MAX_DAYS) >= 0 ? Number(process.env.MAYA_ROLLOVER_MAX_DAYS) : 3;
const LOOKBACK_DAYS = 30;

export function witaDateStr(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

// Pure: given the daily_usage map and today's key, return the allowance.
export function computeAllowance(usage, today = witaDateStr()) {
  const spentToday = Number(usage?.[today] || 0);
  let bank = 0;
  const t = new Date(today + 'T00:00:00Z').getTime();
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const day = new Date(t - i * 86400e3).toISOString().slice(0, 10);
    if (!(day in (usage || {}))) continue;   // no record → Maya wasn't running; nothing to bank
    bank += BASE_CAP_USD - Number(usage[day] || 0);
  }
  const rollover = Math.max(0, Math.min(bank, BASE_CAP_USD * ROLLOVER_MAX_DAYS));
  const cap = BASE_CAP_USD + rollover;
  return { base: BASE_CAP_USD, bank: +bank.toFixed(4), rollover: +rollover.toFixed(4), cap: +cap.toFixed(4), spentToday: +spentToday.toFixed(4), remaining: +Math.max(0, cap - spentToday).toFixed(4), over: spentToday >= cap };
}

// Read settings.daily_usage and compute. `db` = { SUPABASE_URL, sbHeaders }.
export async function getSpendAllowance(db) {
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/settings?key=eq.daily_usage&select=value`, { headers: db.sbHeaders });
    const usage = (await r.json())?.[0]?.value || {};
    return computeAllowance(usage);
  } catch {
    return computeAllowance({});
  }
}

export function describeAllowance(a) {
  return `$${a.spentToday.toFixed(2)} of $${a.cap.toFixed(2)} today (base $${a.base.toFixed(2)} + $${a.rollover.toFixed(2)} rolled over)`;
}
