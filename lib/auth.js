// Console authentication for the CRM's browser-facing API routers.
//
// Until 22 Aug 2026 /api/supabase, /api/whatsapp-send, /api/claude and
// /api/discover accepted any POST from anywhere (CORS *): anyone with the URL
// could read every agent's number, send WhatsApp from the business line, or
// spend the Anthropic key. This gate is deliberately simple for a two-person
// team: one shared secret (env CONSOLE_SECRET), sent by the consoles as the
// `x-console-key` header (or `Authorization: Bearer …`). The consoles keep it
// in localStorage and prompt for it once on a 401.
//
// Enforcement is ON whenever CONSOLE_SECRET is set. Machine-to-machine paths
// that carry their own secret (portal listing sync, cron) are checked by the
// callers before this gate is consulted.
import { timingSafeEqual } from 'node:crypto';

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// What a request's key is allowed to see. Three answers:
//   'full'  — Ikiel's console keys (CONSOLE_SECRET, CONSOLE_SECRET_2) and the
//             portal's listing-sync secret: everything.
//   'staff' — the staff console key (CONSOLE_SECRET_STAFF): Era's trimmed
//             Maya app. She sees and answers the housekeepers, the tukang and
//             the gardeners — the people in the staff roster — and nothing
//             else. Agents, owners, campaigns, the mode switch and the
//             assistant are not hers to see, and the router enforces that
//             per action (see staffActionAllowed), not the page.
//   null    — no valid key.
// Enforcement is ON whenever CONSOLE_SECRET is set; without it everything is
// open and answers 'full' (legacy, local dev).
export function consoleScope(req) {
  const secret = process.env.CONSOLE_SECRET;
  if (!secret) return 'full';                     // not configured → open (legacy)
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const hdr = req.headers['x-console-key'] || bearer;
  if (safeEq(hdr, secret)) return 'full';
  // Optional second console key (CONSOLE_SECRET_2): lets a second operator
  // hold their own key without sharing or rotating the primary one.
  const secret2 = process.env.CONSOLE_SECRET_2;
  if (secret2 && safeEq(hdr, secret2)) return 'full';
  // The portal (sambarentals.com) calls this router server-to-server with
  // the listing-sync secret it already shares with us.
  const sync = process.env.LISTING_SYNC_SECRET;
  if (sync && safeEq(bearer, sync)) return 'full';
  const staff = process.env.CONSOLE_SECRET_STAFF;
  if (staff && safeEq(hdr, staff)) return 'staff';
  return null;
}

// Returns true when the request is allowed to proceed with FULL access. Every
// router that has not been taught about the staff scope keeps calling this,
// so the staff key is refused everywhere by default — a new route cannot
// leak to Era by forgetting to check.
export function consoleAuthorized(req) {
  return consoleScope(req) === 'full';
}

// The /api/supabase actions the staff console may call. Reads are filtered
// to roster numbers inside the router; this list only says which verbs
// exist for that scope at all. Uploads are here because Era sends the
// housekeepers photos ("this is how the towels should look").
const STAFF_ACTIONS = new Set([
  'console_scope', 'get_staff', 'get_messages', 'get_number_messages',
  'upload_file', 'sign_upload',
  // Push: the router keys staff-scope subscriptions under
  // settings.push_subscriptions_staff, a separate list the agent/owner push
  // fan-out never reads — so Era's phone only ever hears about staff.
  'push_status', 'send_test_push', 'save_push_subscription', 'remove_push_subscription',
]);
export function staffActionAllowed(action) {
  return STAFF_ACTIONS.has(String(action || ''));
}

// Restrict CORS to our own origin (the consoles are same-origin pages), and
// allow the key header. Call before any early return so preflights pass.
export function setConsoleCors(req, res) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  // Same-origin requests send no Origin (or our own); anything else is denied
  // the CORS grant — the browser then blocks the response.
  if (origin && host && origin.replace(/^https?:\/\//, '') === host) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-console-key, Authorization');
  res.setHeader('Vary', 'Origin');
}

// Header for internal server-to-server calls to our own routers (cron →
// /api/supabase). Empty when no secret is configured.
export function consoleAuthHeaders() {
  const secret = process.env.CONSOLE_SECRET;
  return secret ? { 'x-console-key': secret } : {};
}
