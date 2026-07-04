import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// HMAC-signed, TTL-bounded proxy targets. The proxy will ONLY fetch a URL that
// the server itself signed (when it vended the channel to an authorized user),
// which closes the open-proxy / paywall-bypass holes WITHOUT putting the auth
// JWT in the query string. A signature is scoped to one URL + expiry; it is not
// a credential and cannot be replayed for account access.

// Long enough for a continuous viewing session, short enough to bound how long
// a downgraded/cancelled user keeps premium access on already-vended URLs.
const TTL_MS = 2 * 3600 * 1000;

export function signTarget(url, ttlMs = TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = createHmac('sha256', config.signingSecret).update(`${exp}\n${url}`).digest('base64url');
  return { exp, sig };
}

export function verifyTarget(url, exp, sig) {
  if (!url || !exp || !sig) return false;
  const e = Number(exp);
  // Reject expired AND implausibly-far-future expiries (defense-in-depth if the
  // signing secret ever leaks: signatures still can't outlive the TTL window).
  if (!Number.isFinite(e) || e < Date.now() || e - Date.now() > TTL_MS + 60_000) return false;
  const expected = createHmac('sha256', config.signingSecret).update(`${e}\n${url}`).digest('base64url');
  if (expected.length !== String(sig).length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch {
    return false;
  }
}

// Build a ready-to-use proxy URL for a stream (optionally carrying UA/Referrer).
export function proxyLink(url, { ua, ref } = {}) {
  const { exp, sig } = signTarget(url);
  let u = `/api/proxy?url=${encodeURIComponent(url)}`;
  if (ua) u += `&ua=${encodeURIComponent(ua)}`;
  if (ref) u += `&ref=${encodeURIComponent(ref)}`;
  u += `&exp=${exp}&sig=${sig}`;
  return u;
}
