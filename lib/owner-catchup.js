// Owners Maya still owes a reply — the owner-side twin of the agent catch-up.
//
// An owner's reply generation can fail (the API usage cap on 31 Aug 2026,
// an overload, a bad response) and the webhook then leaves a marker in the
// draft slot: "[Maya (owner) failed: … — reply manually.]". Two safety nets
// catch an AGENT in that state — the nightly catch-up and the overdue sweep —
// and neither looked at owners: the catch-up read only the agents table, and
// the sweep skips owners on purpose (they must never get the agent holding
// line). So Dony Bambang's "May I know fee rent for villa?" sat behind that
// marker for five days.
//
// These are the pure parts: who is a candidate, and what happened after a
// pass. The pass itself (in api/supabase.js, action resume_unanswered) hands
// each candidate to the webhook's own handleOwnerConversation, so the reply
// follows the same mode rules, prompt and send path as a live message.

export const FAILED_MARKER = /^\[Maya \(owner\) failed/;

// A listed or prospect owner who is not paused, wrote recently, and either
// has an unread message or a failed-generation marker sitting in the draft.
export function isOwnerCatchupCandidate(o, sinceIso) {
  if (!o || o.paused) return false;
  if (!o.last_inbound_at || new Date(o.last_inbound_at) < new Date(sinceIso)) return false;
  return (o.unread_count || 0) > 0 || FAILED_MARKER.test(String(o.suggested_reply || ''));
}

// WhatsApp delivers free text only within 24h of the owner's last message.
// Outside it the reply can still be DRAFTED for a human (or for when the
// owner writes again), but must not be sent — Meta accepts and then fails it.
export function windowOpen(lastInboundIso, now = Date.now()) {
  return lastInboundIso ? now - Date.parse(lastInboundIso) <= 24 * 3600e3 : false;
}

// Read the owner row after the pass and say what the pass did.
export function catchupOutcome(after) {
  const draft = String(after?.suggested_reply || '');
  if (FAILED_MARKER.test(draft)) return 'failed_again';
  if (draft.trim()) return 'drafted';
  if (!(after?.unread_count || 0)) return 'sent';
  return 'unchanged';
}
