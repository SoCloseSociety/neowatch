import { lookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { isIP } from 'node:net';
// Use undici's own fetch + Agent together (no bundled-vs-installed mismatch).
import { fetch as uFetch, Agent } from 'undici';

// SSRF guard shared by the stream proxy and the health checker: never let a
// user-supplied URL resolve to an internal / loopback / cloud-metadata host.

function parseV4(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x))) return null;
  const n = p.map(Number);
  return n.some((x) => x > 255) ? null : n;
}

function privateV4([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||            // link-local + cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||  // RFC 6598 CGNAT (cloud internal fabrics)
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    (a === 198 && b === 51 && c === 100) ||  // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||   // TEST-NET-3
    a >= 224                                // multicast / reserved
  );
}

// IPv6 text -> 8 hextets ("::" compression, a dotted IPv4 tail, a %zone), or null.
function parseV6(ip) {
  let s = String(ip).toLowerCase();
  if (s.includes('%')) s = s.slice(0, s.indexOf('%'));
  const last = s.lastIndexOf(':');
  if (s.indexOf('.', last) !== -1) {
    const v4 = parseV4(s.slice(last + 1));
    if (!v4) return null;
    s = `${s.slice(0, last + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return groups.map((h) => parseInt(h, 16));
}

function privateV6(g) {
  const v4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return true;                                          // ::/96: ::, ::1, IPv4-compatible
  if (zero(0, 5) && g[5] === 0xffff) return privateV4(v4(g[6], g[7]));  // ::ffff:0:0/96 IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    return zero(2, 6) ? privateV4(v4(g[6], g[7])) : true;              // NAT64 /96; 64:ff9b:1::/48 local-use
  }
  if (g[0] === 0x2002) return privateV4(v4(g[1], g[2]));               // 6to4 embeds the IPv4
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;  // Teredo, documentation
  if (g[0] === 0x100 && zero(1, 4)) return true;                       // 100::/64 discard
  if ((g[0] & 0xfe00) === 0xfc00) return true;                         // fc00::/7 unique-local
  return g[0] >= 0xfe80;                                                // link-local, site-local fec0::/10, multicast
}

const unbracket = (h) => String(h).replace(/^\[(.*)\]$/, '$1');

export function isPrivateIp(ip) {
  const v = unbracket(ip);
  const kind = isIP(v);
  if (kind === 6) {
    const g = parseV6(v);
    return !g || privateV6(g);
  }
  const p = kind === 4 ? parseV4(v) : null;
  return !p || privateV4(p);
}

// Short-lived per-host verdict cache so we don't re-resolve DNS on every single
// segment request. The undici agent below still re-validates at connect time,
// so this cache cannot be used to defeat the rebinding protection.
const hostCache = new Map(); // host -> { ok: boolean, exp: number }
const HOST_TTL = 60_000;

export async function assertPublicHost(urlStr) {
  // URL keeps the brackets of an IPv6 literal ("[2606:4700::1111]"): strip them,
  // or isIP() says "not an IP" and the literal goes to DNS (and always fails).
  const host = unbracket(new URL(urlStr).hostname);
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
// independent -- TOCTOU). Used by the pinned undici agent below.
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
// allowPrivate skips the guard (trusted LAN providers, opt-in only). privateHost
// (a URL `host`, e.g. "192.168.1.5:9981") skips it for that one host only: a hop
// that redirects anywhere else is guarded again.
export async function safeFetch(url, init = {}, { maxHops = 5, allowPrivate = false, privateHost = null } = {}) {
  let current = url;
  let res;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!/^https?:\/\//i.test(current)) throw new Error('blocked scheme');
    const open = allowPrivate || (!!privateHost && new URL(current).host === privateHost);
    if (!open) await assertPublicHost(current);
    res = await uFetch(current, {
      ...init,
      redirect: 'manual',
      ...(open ? {} : { dispatcher: guardedAgent }),
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

// ── Bounded body reads (proxy, health; sources/epg can adopt it) ──

// Does this body start like an HLS playlist? A UTF-8 BOM and leading whitespace
// are tolerated; the label (text/plain, octet-stream...) is not trusted either way.
export function startsWithHls(buf) {
  return buf.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

// Read a fetch Response body, at most maxBytes. Over the cap it throws (code
// TOO_LARGE), or with `truncate` returns the first maxBytes. `peek(buf)` is asked
// once the first bytes are in: false stops there (e.g. "this is not a playlist,
// do not download a live .ts for 6 seconds"). An unread rest is always cancelled.
export async function readCapped(res, maxBytes, { truncate = false, peek } = {}) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let peeked = !peek;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      chunks.push(Buffer.from(value));
      total += value.byteLength;
      if (!peeked && total >= 32) {
        peeked = true;
        if (!peek(Buffer.concat(chunks))) break;
      }
      if (total > maxBytes) {
        if (!truncate) throw Object.assign(new Error('body too large'), { code: 'TOO_LARGE' });
        break;
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBytes);
}
