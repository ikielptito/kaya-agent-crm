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
