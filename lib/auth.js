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

// Returns true when the request is allowed to proceed.
export function consoleAuthorized(req) {
  const secret = process.env.CONSOLE_SECRET;
  if (!secret) return true;                       // not configured → open (legacy)
  const hdr = req.headers['x-console-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEq(hdr, secret);
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
