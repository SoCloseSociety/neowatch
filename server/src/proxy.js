import { Router } from 'express';
import { safeFetch, startsWithHls } from './netguard.js';
import { verifyTarget, proxyLink, rootTag } from './signing.js';
import { streamMeta } from './health.js';
import { rateLimit } from './ratelimit.js';
import { config } from './config.js';
import { isBlocked, getBlocklist } from './catalog.js';

const proxyLimit = rateLimit({ windowMs: 60_000, max: 3000, name: 'proxy' });

// Streaming proxy: defeats CORS / referrer locks and lets us set the custom
// User-Agent / Referrer some streams require. It ONLY fetches URLs the server
// itself signed (HMAC + TTL), so it is not an open relay and premium/SaaS access
// is enforced at vend time, not via a credential in the query string.
//
// Whatever an upstream sends is served on OUR origin, next to the app's
// localStorage session. So the response is rebuilt, never copied: an ALLOWLIST of
// upstream headers, a media-only Content-Type, and a sandboxing CSP + nosniff set
// last so no upstream value can override them.

export const proxyRouter = Router();

const DEFAULT_UA = 'Mozilla/5.0 (NEOWATCH)';

// The only upstream headers relayed (content-length is handled apart: it is wrong
// once undici has decoded a content-encoding). Never set-cookie, clear-site-data,
// CSP, HSTS, ACAO/ACAC, link, refresh, x-content-type-options or x-renewed-token
// (a CDN must not be able to hand our client a "renewed" session token).
const RELAY_HEADERS = ['content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];

// Media labels a stream may keep. Anything else (html, svg, xml, js, json, text,
// image/* used to disguise segments) becomes application/octet-stream: hls.js
// and <video>/<audio> ignore the label, a browser tab never renders it.
const MEDIA_TYPE = /^(?:video\/[\w.+-]+|audio\/[\w.+-]+|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl|octet-stream|mp4|ogg|dash\+xml)|binary\/octet-stream|text\/vtt)$/;
const mediaType = (ct) => {
  const mime = String(ct || '').split(';')[0].trim().toLowerCase();
  return MEDIA_TYPE.test(mime) ? mime : 'application/octet-stream';
};

// Set LAST on every proxy response (after any upstream value).
function lockDown(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Never send the (signed) target URL to upstream/CDN via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

// Manifest bounds: a real live playlist is a few KB, a long VOD a few thousand
// URIs. Past these the upstream is broken or hostile -> 502, nothing buffered more.
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_URIS = 20_000;
const SNIFF_BYTES = 32; // enough for a BOM + whitespace + "#EXTM3U"
const tooLarge = () => Object.assign(new Error('manifest too large'), { code: 'TOO_LARGE' });

// Tiny manifest cache: many viewers of the same channel re-fetch the live
// playlist every few seconds; serving a ~1.5s-cached rewritten body collapses
// that thundering herd into one upstream hit. Segments are never cached.
// Bounded by bytes; every entry has the same TTL, so insertion order == expiry
// order and eviction walks from the oldest.
const mfCache = new Map(); // key -> { body, exp }
const MF_TTL = 1500;
const MF_BUDGET = 32 * 1024 * 1024;
const MF_ITEM_MAX = 1024 * 1024;
let mfBytes = 0;
const mfDelete = (key) => {
  const e = mfCache.get(key);
  if (e) { mfBytes -= e.body.length; mfCache.delete(key); }
};
function mfGet(key) {
  const e = mfCache.get(key);
  if (!e) return null;
  if (e.exp > Date.now()) return e.body;
  mfDelete(key);
  return null;
}
function mfSet(key, body) {
  if (body.length > MF_ITEM_MAX) return;
  mfDelete(key);
  const now = Date.now();
  for (const [k, e] of mfCache) {
    if (e.exp > now && mfBytes + body.length <= MF_BUDGET) break;
    mfDelete(k);
  }
  mfCache.set(key, { body, exp: now + MF_TTL });
  mfBytes += body.length;
}

// Takedown at SERVE time: links vended before an operator blocklisted a stream
// must stop too. The direct check is catalog.isBlocked; the root-tag check
// (children of a blocked master) uses a 2s snapshot of the list.
let blockSnap = { at: 0, roots: new Set() };
const tagMemo = new Map();
function blockSnapshot() {
  if (Date.now() - blockSnap.at < 2000) return blockSnap;
  const list = getBlocklist();
  const roots = new Set();
  for (const u of list) {
    let t = tagMemo.get(u);
    if (!t) { t = rootTag(u); tagMemo.set(u, t); }
    roots.add(t);
  }
  if (tagMemo.size > list.length * 2 + 1000) tagMemo.clear();
  blockSnap = { at: Date.now(), roots };
  return blockSnap;
}
function isTakenDown(url, root) {
  return isBlocked(url) || (!!root && blockSnapshot().roots.has(root));
}

// Rewrite every URI inside an HLS manifest so segments/keys/sub-playlists also
// flow through the proxy. Each child URL is freshly SIGNED (no credential) and
// inherits ua/ref/root/lan. Only http(s) is wrapped: data:, skd: (FairPlay key
// ids) and anything unparseable are left as they are.
function rewriteManifest(text, baseUrl, link) {
  const base = new URL(baseUrl);
  let uris = 0;
  const wrap = (uri) => {
    let abs;
    try { abs = new URL(uri, base); } catch { return uri; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
    if (++uris > MANIFEST_MAX_URIS) throw tooLarge();
    return proxyLink(abs.toString(), link);
  };
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." AND URI='...' (some non-spec streams single-quote) so
        // EXT-X-KEY / MEDIA / MAP / PART sub-resources all route back through us.
        return line.replace(/URI=(["'])([^"']+)\1/g, (_, q, uri) => `URI=${q}${wrap(uri)}${q}`);
      }
      return wrap(trimmed);
    })
    .join('\n');
}

proxyRouter.get('/proxy', proxyLimit, async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'bad request' });
  }
  const param = (k) => (typeof req.query[k] === 'string' ? req.query[k] : '');
  const uaParam = param('ua'), refParam = param('ref'), root = param('r'), lanParam = param('lan') === '1';
  // Only serve URLs the server signed (closes open-proxy + paywall bypass). The
  // signature covers ua/ref/r/lan too, so none of them can be swapped.
  const signed = verifyTarget(target, req.query.exp, req.query.sig, { ua: uaParam, ref: refParam, r: root, lan: lanParam });
  if (!signed) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (isTakenDown(target, root)) return res.status(410).json({ error: 'gone' });

  const ua = uaParam || DEFAULT_UA;
  const ref = refParam || undefined;
  // ALLOW_PRIVATE_SOURCES only opens the SSRF guard for an operator's custom
  // (M3U) streams and their children (lan=1, signed), never for third-party
  // iptv-org / radio URLs. A legacy v1 link keeps the pre-v2 behaviour for its
  // remaining lifetime (at most one TTL after the deploy).
  const lan = config.allowPrivateSources && (signed === 'legacy' || lanParam || streamMeta(target)?.custom === true);
  const childLink = { ua: uaParam, ref: refParam, r: root || rootTag(target), lan };

  // Serve a fresh cached manifest if we have one (absorbs concurrent viewers).
  const cacheKey = `${target}|${uaParam}|${refParam}|${childLink.r}|${lan ? 1 : 0}`;
  const cachedMf = mfGet(cacheKey);
  if (cachedMf) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    lockDown(res);
    return res.send(cachedMf);
  }

  const headers = { 'User-Agent': ua };
  if (ref) headers['Referer'] = ref;
  if (req.headers.range) headers['Range'] = req.headers.range;

  const controller = new AbortController();
  let clientGone = false;
  const onClose = () => { clientGone = true; controller.abort(); };
  req.on('close', onClose);
  // Covers connect + headers + the manifest body (a slow-drip playlist cannot
  // hold the request forever); cleared before a media body is streamed.
  const connectTimer = setTimeout(() => controller.abort(), 20000);

  // One transient retry for the initial connection (flaky CDNs).
  const connect = async () => {
    const opts = [{ headers, signal: controller.signal }, { maxHops: 5, allowPrivate: lan }];
    try {
      return await safeFetch(target, opts[0], opts[1]);
    } catch (e) {
      if (controller.signal.aborted) throw e;
      await new Promise((r) => setTimeout(r, 500));
      return safeFetch(target, opts[0], opts[1]);
    }
  };

  let reader;
  try {
    const upstream = await connect();
    const finalUrl = upstream.finalUrl || target;
    // A redirect that lands on a blocklisted stream is a takedown too.
    if (finalUrl !== target && isTakenDown(finalUrl)) {
      try { await upstream.body?.cancel(); } catch { /* ignore */ }
      clearTimeout(connectTimer);
      return res.status(410).json({ error: 'gone' });
    }
    reader = upstream.body ? upstream.body.getReader() : null;

    // Sniff the first bytes of a 2xx body: a playlist is whatever starts with
    // #EXTM3U, whatever its label (text/plain, octet-stream, .php URLs). A non-2xx
    // body or a 206 slice is relayed as media, never rewritten (or re-signed).
    const head = [];
    let headBytes = 0;
    let ended = false;
    if (reader && upstream.ok && upstream.status !== 206) {
      while (headBytes < SNIFF_BYTES) {
        const { done, value } = await reader.read();
        if (done) { ended = true; break; }
        head.push(Buffer.from(value));
        headBytes += value.byteLength;
      }
    }

    if (headBytes && startsWithHls(Buffer.concat(head))) {
      let total = headBytes;
      while (!ended) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MANIFEST_MAX_BYTES) throw tooLarge();
        head.push(Buffer.from(value));
      }
      clearTimeout(connectTimer);
      const rewritten = rewriteManifest(Buffer.concat(head).toString('utf8'), finalUrl, childLink);
      mfSet(cacheKey, rewritten);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      lockDown(res);
      return res.status(upstream.status).send(rewritten);
    }
    clearTimeout(connectTimer);

    for (const key of RELAY_HEADERS) {
      const v = upstream.headers.get(key);
      if (v) res.setHeader(key, v);
    }
    // undici decodes gzip/br bodies: the upstream length is only true unencoded.
    const len = upstream.headers.get('content-length');
    if (len && /^\d+$/.test(len) && !upstream.headers.get('content-encoding')) res.setHeader('Content-Length', len);
    if (!upstream.headers.get('cache-control')) res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', mediaType(upstream.headers.get('content-type')));
    lockDown(res);
    res.status(upstream.status);

    if (reader) {
      let aborted = false;
      const stop = () => { aborted = true; reader.cancel().catch(() => {}); };
      req.on('close', stop);
      res.on('error', stop);
      const send = async (chunk) => {
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const onDrain = () => { res.off('drain', onDrain); res.off('close', onDrain); resolve(); };
            res.once('drain', onDrain);
            res.once('close', onDrain);
          });
        }
      };
      for (const chunk of head) {
        if (aborted) break;
        await send(chunk);
      }
      while (!ended && !aborted) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        await send(Buffer.from(value));
      }
    }
    res.end();
  } catch {
    clearTimeout(connectTimer);
    try { reader?.cancel().catch(() => {}); } catch { /* ignore */ }
    // Upstream died after our headers left: cut the connection so the player
    // sees a network error and retries now, instead of waiting on a response
    // that will never end. Client gone: nothing to answer. Our own timeout (or a
    // too-large manifest) still gets an answer.
    if (res.headersSent) { res.destroy(); return; }
    if (clientGone) return;
    res.status(502).json({ error: 'upstream unavailable' });
  } finally {
    req.off('close', onClose);
  }
});
