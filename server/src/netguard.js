import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
// Use undici's own fetch + Agent together (no bundled-vs-installed mismatch).
import { fetch as uFetch, Agent } from 'undici';

// SSRF guard shared by the stream proxy and the health checker: never let a
// user-supplied URL resolve to an internal / loopback / cloud-metadata host.

export function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||            // link-local + cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||  // RFC 6598 CGNAT (cloud internal fabrics)
    a >= 224                                // multicast / reserved
  );
}

// Short-lived per-host verdict cache so we don't re-resolve DNS on every single
// segment request. The undici agent below still re-validates at connect time,
// so this cache cannot be used to defeat the rebinding protection.
const hostCache = new Map(); // host -> { ok: boolean, exp: number }
const HOST_TTL = 60_000;

export async function assertPublicHost(urlStr) {
  const host = new URL(urlStr).hostname;
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked private address');
    return;
  }
  const cached = hostCache.get(host);
  if (cached && cached.exp > Date.now()) {
    if (!cached.ok) throw new Error('blocked private address');
    return;
  }
  let ok = true;
  try {
    const addrs = await lookup(host, { all: true });
    ok = addrs.length > 0 && !addrs.some((a) => isPrivateIp(a.address));
  } catch {
    ok = false;
  }
  if (hostCache.size > 5000) hostCache.clear();
  hostCache.set(host, { ok, exp: Date.now() + HOST_TTL });
  if (!ok) throw new Error('blocked private address');
}

// A custom DNS lookup that re-validates the ACTUAL connected IP, defeating
// DNS-rebinding (the guard's lookup and the socket's lookup are otherwise
// independent — TOCTOU). Used by the pinned undici agent below.
function guardedLookup(hostname, options, cb) {
  dnsLookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
    if (list.some((a) => isPrivateIp(a.address))) return cb(new Error('blocked private address'));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// allowH2:false avoids undici's HTTP/2 stream-error path (a dropped h2 socket
// from a flaky CDN emits an unhandled 'error'); plain keep-alive HTTP/1.1 pools
// fine and is more robust here. Bounded timeouts prevent hung sockets.
const guardedAgent = new Agent({
  connect: { lookup: guardedLookup, timeout: 10000 },
  allowH2: false,
  headersTimeout: 20000,
  bodyTimeout: 30000,
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 30000,
});

// SSRF-safe fetch: re-validates EVERY redirect hop and pins the connect-time DNS
// resolution. Use this for any user-influenced URL instead of fetch(redirect:'follow').
// allowPrivate skips the guard (trusted LAN providers, opt-in only).
export async function safeFetch(url, init = {}, { maxHops = 5, allowPrivate = false } = {}) {
  let current = url;
  let res;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!/^https?:\/\//i.test(current)) throw new Error('blocked scheme');
    if (!allowPrivate) await assertPublicHost(current);
    res = await uFetch(current, {
      ...init,
      redirect: 'manual',
      ...(allowPrivate ? {} : { dispatcher: guardedAgent }),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      // Drain the redirect body or the socket stays checked-out of the pool.
      try { await res.body?.cancel(); } catch { /* ignore */ }
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    // Expose the final resolved URL for manifest base-URL rewriting.
    Object.defineProperty(res, 'finalUrl', { value: current, configurable: true });
    return res;
  }
  try { await res?.body?.cancel(); } catch { /* ignore */ }
  throw new Error('too many redirects');
}
