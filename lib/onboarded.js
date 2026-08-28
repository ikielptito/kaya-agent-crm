// Which owners have actually claimed their Samba account?
//
// Maya must never be the first thing an owner hears about the portal. Until
// Ikiel has onboarded them and they've claimed their account, statements and
// maintenance requests stay queued rather than being sent — and because the
// queues are "not yet notified" columns rather than a one-shot, whatever was
// waiting goes out on the next daily pass the moment they do claim.
//
// The portal's KV is the authority on account ownership, so we ask it. Fail
// CLOSED: if the portal can't be reached we treat nothing as claimed, which
// delays a message by a day instead of sending one to someone who has no
// idea what Samba Realty's portal is.

const PORTAL_BASE = process.env.PORTAL_BASE_URL || 'https://sambarentals.com';

export async function claimedGroupKeys() {
  const secret = process.env.LISTING_SYNC_SECRET;
  if (!secret) return new Set();
  try {
    const r = await fetch(`${PORTAL_BASE}/api/statements?action=claimed-groups`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set(Array.isArray(d.claimed) ? d.claimed : []);
  } catch {
    return new Set();
  }
}
