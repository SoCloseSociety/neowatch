import { Router } from 'express';
import { safeFetch } from './netguard.js';
import { verifyTarget, signTarget } from './signing.js';
import { rateLimit } from './ratelimit.js';
import { config } from './config.js';

const proxyLimit = rateLimit({ windowMs: 60_000, max: 3000, name: 'proxy' });

// Streaming proxy: defeats CORS / referrer locks and lets us set the custom
// User-Agent / Referrer some streams require. It ONLY fetches URLs the server
// itself signed (HMAC + TTL), so it is not an open relay and premium/SaaS access
// is enforced at vend time, not via a credential in the query string.

export const proxyRouter = Router();

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length',
]);

const isPlaylist = (url, ct) => {
  const c = (ct || '').toLowerCase();
  return /\.m3u8(\?|$)/i.test(url) || c.includes('mpegurl') || c.includes('vnd.apple');
};

// Tiny manifest cache: many viewers of the same channel re-fetch the live
// playlist every few seconds; serving a ~1.5s-cached rewritten body collapses
// that thundering herd into one upstream hit. Segments are never cached.
const mfCache = new Map(); // key -> { body, exp }
const MF_TTL = 1500;

// Rewrite every URI inside an HLS manifest so segments/keys/sub-playlists also
// flow through the proxy. Each child URL is freshly SIGNED (no credential).
function rewriteManifest(text, baseUrl, ua, ref) {
  const base = new URL(baseUrl);
  const wrap = (abs) => {
    const { exp, sig } = signTarget(abs);
    let u = `/api/proxy?url=${encodeURIComponent(abs)}`;
    if (ua) u += `&ua=${encodeURIComponent(ua)}`;
    if (ref) u += `&ref=${encodeURIComponent(ref)}`;
    u += `&exp=${exp}&sig=${sig}`;
    return u;
  };
  const toAbs = (uri) => {
    try {
      return new URL(uri, base).toString();
    } catch {
      return uri;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." AND URI='...' (some non-spec streams single-quote) so
        // EXT-X-KEY / MEDIA / MAP / PART sub-resources all route back through us.
        return line.replace(/URI=(["'])([^"']+)\1/g, (_, q, uri) => `URI=${q}${wrap(toAbs(uri))}${q}`);
      }
      return wrap(toAbs(trimmed));
    })
    .join('\n');
}

proxyRouter.get('/proxy', proxyLimit, async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== 'string' || !/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'bad request' });
  }
  // Only serve URLs the server signed (closes open-proxy + paywall bypass).
  if (!verifyTarget(target, req.query.exp, req.query.sig)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const ua = typeof req.query.ua === 'string' ? req.query.ua : 'Mozilla/5.0 (NEOWATCH)';
  const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;

  // Serve a fresh cached manifest if we have one (absorbs concurrent viewers).
  const cacheKey = `${target}|${ua}|${ref || ''}`;
  const cachedMf = mfCache.get(cacheKey);
  if (cachedMf && cachedMf.exp > Date.now()) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(cachedMf.body);
  }

  const headers = { 'User-Agent': ua };
  if (ref) headers['Referer'] = ref;
  if (req.headers.range) headers['Range'] = req.headers.range;

  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on('close', onClose);
  let connectTimer = setTimeout(() => controller.abort(), 20000);

  // One transient retry for the initial connection (flaky CDNs).
  const connect = async () => {
    const opts = [{ headers, signal: controller.signal }, { maxHops: 5, allowPrivate: config.allowPrivateSources }];
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
    clearTimeout(connectTimer);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    // Never send the (signed) target URL to upstream/CDN via Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');

    const ct = upstream.headers.get('content-type') || '';

    if (isPlaylist(target, ct)) {
      const text = await upstream.text();
      const rewritten = rewriteManifest(text, upstream.finalUrl || target, ua, ref);
      if (upstream.ok) {
        if (mfCache.size > 2000) mfCache.clear();
        mfCache.set(cacheKey, { body: rewritten, exp: Date.now() + MF_TTL });
      }
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.status(upstream.status).send(rewritten);
    }

    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.status(upstream.status);

    if (upstream.body) {
      reader = upstream.body.getReader();
      let aborted = false;
      const stop = () => { aborted = true; reader.cancel().catch(() => {}); };
      req.on('close', stop);
      res.on('error', stop);
      for (;;) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => {
            const onDrain = () => { res.off('drain', onDrain); res.off('close', onDrain); resolve(); };
            res.once('drain', onDrain);
            res.once('close', onDrain);
          });
        }
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    clearTimeout(connectTimer);
    try { reader?.cancel(); } catch { /* ignore */ }
    if (controller.signal.aborted || res.headersSent) return;
    res.status(502).json({ error: 'upstream unavailable' });
  } finally {
    req.off('close', onClose);
  }
});
