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

// 6 Sep 2026: the gate is OFF. Ikiel dropped it. It assumed he would hand
// every owner a portal invite before Maya wrote to them; in practice only
// one owner in nine had claimed an account after ten days, and statements
// and maintenance requests for the other eight were being held without
// anyone noticing. Maya now writes to owners directly; the portal link in
// her messages is the invitation. The gate can be turned back on with
// settings.owners = {"first_contact_gate": true} without a deploy.
const EVERYONE = { has: () => true, size: Infinity, __open: true };

export async function claimedGroupKeys(db = null) {
  const gateOn = await gateEnabled(db);
  if (!gateOn) return EVERYONE;
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

async function gateEnabled(db) {
  try {
    const url = db?.SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) return false;
    const r = await fetch(`${url}/rest/v1/settings?key=eq.owners&select=value`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    const v = r.ok ? (await r.json())?.[0]?.value : null;
    return v?.first_contact_gate === true;
  } catch { return false; }
}
