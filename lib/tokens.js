// Signed link tokens shared with the portal (sambarentals.com). Both apps
// derive the same signatures from LISTING_SYNC_SECRET, so either side can
// mint a link the other verifies without any storage.
//
// KEEP IN SYNC with the portal's lib/tokens.js — same algorithms, same
// message formats. There is no shared package (two repos, no build step),
// so the two copies are the contract.
//
//   reportSig(slug)                weekly report:  /r/<slug>~<sig16>
//   statementSig(groupKey, period) monthly payout: /st/<groupKey>.<period>~<sig16>
//
// The statement message is prefixed 'stmt:' so a weekly token can never be
// replayed as a statement token (and vice versa), and it embeds the period so
// one leaked link exposes exactly one month of one property group.

import crypto from 'node:crypto';

const safeEq = (a, b) => {
  if (String(a).length !== String(b).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); }
  catch { return false; }
};

const hmac16 = (msg) =>
  crypto.createHmac('sha256', process.env.LISTING_SYNC_SECRET || '')
    .update(String(msg)).digest('hex').slice(0, 16);

export function reportSig(slug) {
  return hmac16(slug);
}
export function reportToken(slug) {
  return `${slug}~${reportSig(slug)}`;
}

export function statementSig(groupKey, period) {
  return hmac16(`stmt:${groupKey}:${period}`);
}
export function statementToken(groupKey, period) {
  return `${groupKey}.${period}~${statementSig(groupKey, period)}`;
}

export function inviteSig(groupKey) {
  return hmac16(`invite:${groupKey}`);
}
// Owner-onboarding invite: /portal?invite=<groupKey>~<sig16>. Whoever opens
// it and signs in with Google claims the group's catalog listings — refused
// if another account already holds them, so the link is single-owner.
export function inviteToken(groupKey) {
  return `${groupKey}~${inviteSig(groupKey)}`;
}
export function verifyInviteToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)~([0-9a-f]+)$/);
  if (!m) return null;
  if (!safeEq(m[2], inviteSig(m[1]))) return null;
  return m[1];
}

export function previewSig(groupKey) {
  return hmac16(`preview:${groupKey}`);
}
// Admin read-only preview: /portal?preview=<groupKey>~<sig16> renders the
// owner portal exactly as that group's owner will see it, without touching
// ownership. Mintable only by whoever holds the shared secret.
export function previewToken(groupKey) {
  return `${groupKey}~${previewSig(groupKey)}`;
}
export function verifyPreviewToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)~([0-9a-f]+)$/);
  if (!m) return null;
  if (!safeEq(m[2], previewSig(m[1]))) return null;
  return m[1];
}
