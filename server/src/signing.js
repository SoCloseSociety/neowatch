import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

// HMAC-signed, TTL-bounded proxy targets. The proxy will ONLY fetch a URL that
// the server itself signed (when it vended the channel to an authorized user),
// which closes the open-proxy / paywall-bypass holes WITHOUT putting the auth
// JWT in the query string. A signature is scoped to one URL + expiry; it is not
// a credential and cannot be replayed for account access.
//
// v2 also covers everything the proxy acts on, so none of it can be swapped on a
// vended link: the User-Agent / Referer sent upstream (ua, ref), the root stream
// a child playlist/segment belongs to (r, checked against the takedown blocklist)
// and the private-network permission of a custom LAN source (lan).

// Long enough for a continuous viewing session, short enough to bound how long
// a downgraded/cancelled user keeps premium access on already-vended URLs.
const TTL_MS = 2 * 3600 * 1000;

// v1 links (HMAC over exp + url only) vended by the process that ran before this
// one stay playable until they expire, so a deploy does not cut every proxied
// stream mid-play. This process never issues v1, so the window closes by itself.
const BOOT_AT = Date.now();

const hmac = (msg) => createHmac('sha256', config.signingSecret).update(msg).digest('base64url');
// JSON array = unambiguous field boundaries (no "\n inside a value" confusion).
const v2Message = (exp, url, { ua, ref, r, lan } = {}) =>
  JSON.stringify(['v2', exp, url, ua || '', ref || '', r || '', lan ? 1 : 0]);

// Short, stable tag of a root stream URL: child links carry it so a takedown of
// the channel also stops the playlists + segments already handed to a player.
export const rootTag = (url) => createHash('sha256').update(String(url)).digest('base64url').slice(0, 11);

export function signTarget(url, opts = {}, ttlMs = TTL_MS) {
  const exp = Date.now() + ttlMs;
  return { exp, sig: hmac(v2Message(exp, url, opts)) };
}

const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// -> true (v2), 'legacy' (a v1 link from the previous process, inside its window;
// ua/ref/r/lan are then NOT covered by the signature) or false.
export function verifyTarget(url, exp, sig, opts = {}) {
  if (!url || !exp || !sig) return false;
  const e = Number(exp);
  // Reject expired AND implausibly-far-future expiries (defense-in-depth if the
  // signing secret ever leaks: signatures still can't outlive the TTL window).
  if (!Number.isFinite(e) || e < Date.now() || e - Date.now() > TTL_MS + 60_000) return false;
  try {
    if (same(hmac(v2Message(e, url, opts)), sig)) return true;
    if (e - TTL_MS < BOOT_AT && same(hmac(`${e}\n${url}`), sig)) return 'legacy';
  } catch { /* malformed sig */ }
  return false;
}

// Build a ready-to-use proxy URL for a stream (optionally carrying UA/Referrer,
// and for child links the root tag + LAN permission). Every param is signed.
export function proxyLink(url, { ua, ref, r, lan } = {}) {
  const { exp, sig } = signTarget(url, { ua, ref, r, lan });
  let u = `/api/proxy?url=${encodeURIComponent(url)}`;
  if (ua) u += `&ua=${encodeURIComponent(ua)}`;
  if (ref) u += `&ref=${encodeURIComponent(ref)}`;
  if (r) u += `&r=${encodeURIComponent(r)}`;
  if (lan) u += '&lan=1';
  u += `&exp=${exp}&sig=${sig}`;
  return u;
}
