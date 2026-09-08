// What Maya knows about reaching each housekeeper.
//
// Three people, three different channels, and until 8 Sep 2026 one policy:
// Ita answers everything; Gede reads and replies only after the 17:00
// chase; Putu's phone has delivered nothing since 4 Sep. Every cron
// treated them identically — templates in the morning, a chase at 17:00,
// an escalation at 19:00 — so a dead phone was chased and reported every
// day and the villa never showed as uncovered.
//
// The channel is derived hourly from wa_messages and staff_asks and kept
// in staff_channel (one row per person) so the sweeps read one fact:
//
//   mode  ok     messages land and get answered
//         quiet  messages are read, asks go unanswered (3+ ignored in 7 days)
//         dead   nothing delivered for two days
//
// Policy (applied by the callers):
//   dead   morning tasks are not sent; the visit is marked uncovered and
//          Era's brief lists it; the chase and the 19:00 line skip her;
//          Era is told once, then every third day.
//   quiet  the Monday week message and inspection asks are skipped (Era
//          arranges those by phone); daily tasks and the chase still go;
//          Era's brief says so once a week.
//
// Without the table the function still computes the mode; it just is not
// stored.

import { askStats } from './asks.js';

const nowIso = () => new Date().toISOString();
const digits = (n) => String(n || '').replace(/\D/g, '');
// Remembered for ten minutes, not for the life of the instance: the tables
// were created on 8 Sep 2026 while warm instances still believed them absent.
let _missingAt = 0;
const MISSING_MS = 10 * 60 * 1000;
const isMissing = () => Date.now() - _missingAt < MISSING_MS;
const markMissing = () => { _missingAt = Date.now(); };

async function sbGet(db, path) {
  const r = await fetch(`${db.SUPABASE_URL}/rest/v1/${path}`, { headers: db.sbHeaders });
  return r.ok ? r.json() : null;
}

// Pure: the mode from the facts.
export function modeOf({ undeliveredSince = null, lastReadAt = null, lastInboundAt = null, ignoredAsks7d = 0, asks7d = 0, now = new Date() } = {}) {
  const t = now.getTime();
  if (undeliveredSince && t - Date.parse(undeliveredSince) > 2 * 86400e3) return 'dead';
  if (asks7d >= 3 && ignoredAsks7d >= 3 && ignoredAsks7d / asks7d >= 0.6) return 'quiet';
  return 'ok';
}

// The facts for one number, from the log.
export async function channelFacts(db, num, { now = new Date() } = {}) {
  const n = digits(num);
  const since = new Date(now.getTime() - 7 * 86400e3).toISOString();
  const out = (await sbGet(db, `wa_messages?wa_num=eq.${n}&direction=eq.outbound&wa_message_id=not.is.null&timestamp=gte.${encodeURIComponent(since)}&select=status,timestamp&order=timestamp.desc&limit=60`)) || [];
  const inb = (await sbGet(db, `wa_messages?wa_num=eq.${n}&direction=eq.inbound&select=timestamp&order=timestamp.desc&limit=1`)) || [];
  const lastRead = out.find(m => ['read', 'delivered'].includes(m.status))?.timestamp || null;
  // Undelivered since: the oldest of the unbroken run of sent/failed at the top.
  let undeliveredSince = null;
  for (const m of out) { if (['sent', 'failed'].includes(m.status)) undeliveredSince = m.timestamp; else break; }
  // A run of one is a message in flight, not a dead phone.
  const run = out.findIndex(m => !['sent', 'failed'].includes(m.status));
  if ((run === -1 ? out.length : run) < 3) undeliveredSince = null;
  const stats = (await askStats(db, n).catch(() => null)) || { asks: 0, ignored: 0 };
  return { wa_num: n, last_inbound_at: inb[0]?.timestamp || null, last_read_at: lastRead, undelivered_since: undeliveredSince, asks_7d: stats.asks, ignored_asks_7d: stats.ignored };
}

// Refresh every active housekeeper's row. Returns the modes.
export async function refreshChannels(db, { now = new Date() } = {}) {
  const staff = (await sbGet(db, 'staff?active=is.true&select=id,name,wa_num,roles&limit=100')) || [];
  const modes = {};
  for (const s of staff) {
    if (!s.wa_num) continue;
    const f = await channelFacts(db, s.wa_num, { now });
    const mode = modeOf({ undeliveredSince: f.undelivered_since, lastReadAt: f.last_read_at, lastInboundAt: f.last_inbound_at, ignoredAsks7d: f.ignored_asks_7d, asks7d: f.asks_7d, now });
    modes[s.id] = { ...f, mode, name: s.name };
    if (isMissing()) continue;
    try {
      const r = await fetch(`${db.SUPABASE_URL}/rest/v1/staff_channel?on_conflict=staff_id`, {
        method: 'POST', headers: { ...db.sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ staff_id: s.id, wa_num: f.wa_num, mode, last_inbound_at: f.last_inbound_at, last_read_at: f.last_read_at, undelivered_since: f.undelivered_since, ignored_asks_7d: f.ignored_asks_7d, asks_7d: f.asks_7d, updated_at: nowIso() }),
      });
      if (!r.ok && r.status === 404) markMissing();
    } catch { /* optional */ }
  }
  return modes;
}

// What the sweeps read: staff_id → mode row. Falls back to a live derivation
// when the table is absent.
export async function channels(db, { now = new Date() } = {}) {
  if (!isMissing()) {
    const rows = await sbGet(db, 'staff_channel?select=*&limit=100');
    if (rows === null) markMissing();
    else if (rows.length) {
      // A row older than three hours is stale (the beat did not run); re-derive.
      const fresh = rows.every(r => now.getTime() - Date.parse(r.updated_at) < 3 * 3600e3);
      if (fresh) return Object.fromEntries(rows.map(r => [r.staff_id, r]));
    }
  }
  return refreshChannels(db, { now });
}

// Tell Era about a dead phone once, then every third day, via the caller.
export async function shouldTellEra(db, staffId, { now = new Date() } = {}) {
  if (isMissing()) return true;
  const row = (await sbGet(db, `staff_channel?staff_id=eq.${staffId}&select=era_told_at&limit=1`))?.[0];
  if (!row?.era_told_at) return true;
  return now.getTime() - Date.parse(row.era_told_at) > 3 * 86400e3;
}
export async function markEraTold(db, staffId) {
  if (isMissing()) return;
  await fetch(`${db.SUPABASE_URL}/rest/v1/staff_channel?staff_id=eq.${staffId}`, { method: 'PATCH', headers: db.sbHeaders, body: JSON.stringify({ era_told_at: nowIso() }) }).catch(() => {});
}
