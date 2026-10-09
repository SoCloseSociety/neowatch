import { Router } from 'express';
import { safeFetch, readCapped } from './netguard.js';
import { rateLimit } from './ratelimit.js';
import { config } from './config.js';
import { getLogoMeta } from './catalog.js';
import { isKnownRadioIcon } from './radio.js';

// Image relay for logos: GET /api/img?u=<url>.
//
// Channel logos and radio favicons live on thousands of third-party hosts. Some refuse
// to be embedded (Cross-Origin-Resource-Policy, ORB on a wrong label), some are plain
// http on our https page, and every viewer used to download the same full-size PNGs.
// The relay serves them from our origin, cached.
//
// It is NOT an open relay and it never serves an upstream's bytes as they came:
//  - only URLs the server itself vends (a catalog channel logo, a listed radio favicon)
//    are fetched; anything else is a 404 without a request;
//  - safeFetch: SSRF guard on every redirect hop + connect-time DNS pinning. A custom
//    (M3U) source's logo may sit on the operator's LAN when ALLOW_PRIVATE_SOURCES=true,
//    for that one host only (a redirect elsewhere is guarded again);
//  - 10 s for the whole fetch, 1 MB cap, a raster image only: the type is SNIFFED from
//    the magic bytes (png, jpeg, gif, webp, avif, ico). The upstream label is only used
//    to refuse early (html, json, svg...). SVG is refused (415): it can carry script,
//    and it is ~1 % of the channel logos, ~4 % of the radio favicons (they show the
//    monogram). An <img> gets a 204 for any refused/dead logo (see noImage);
//  - the response carries OUR headers only (no upstream header is ever copied):
//    the sniffed Content-Type, nosniff, a sandboxing CSP, CORP same-origin, and a
//    public 24 h cache;
//  - bounded memory: an LRU of 32 MB / 1000 images, a 10 min negative cache so a dead
//    logo host is asked once, at most 16 upstream fetches at a time (queued fairly per
//    client), a hanging host skipped for a minute, a per-IP rate limit.
//
// Mounted before `authenticate` (index.js): an <img> sends no Authorization, and a
// response that is publicly cacheable must never carry a renewed session token.

export const imgRouter = Router();

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_URL = 2048;
const CACHE_BUDGET = 32 * 1024 * 1024;
const CACHE_MAX = 3000; // entries; the byte budget above is the real bound
const CACHE_TTL_MS = 24 * 3600 * 1000;
const NEG_TTL_MS = 10 * 60 * 1000;
const NEG_MAX = 5000;
const MAX_ACTIVE = 16;  // concurrent upstream fetches
const MAX_QUEUED = 256; // waiting beyond this: 503 (not negatively cached)
const UA = 'Mozilla/5.0 (compatible; NEOWATCH/1.0; +https://neowatch.soclose.co)';
// One cached copy serves every viewer: AVIF is refused at negotiation (older TV
// browsers cannot decode it); WebP is already required by the app's own artwork.
const ACCEPT = 'image/webp,image/png,image/jpeg,image/gif,image/avif;q=0,image/*;q=0.8,*/*;q=0.5';

const imgLimit = rateLimit({ windowMs: 60_000, max: 600, name: 'img' });

// ── sniffing ──────────────────────────────────────────────────────────────
const ascii = (b, from, to) => b.toString('latin1', from, to);
export function sniffImage(b) {
  if (!b || b.length < 4) return null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 16 && ascii(b, 4, 8) === 'ftyp') {
    // ISO-BMFF: major brand, then the compatible brands up to the end of the box.
    const end = Math.min(b.readUInt32BE(0), b.length, 64);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, i + 4));
    return brands.some((x) => x === 'avif' || x === 'avis') ? 'image/avif' : null;
  }
  // ICO: reserved 0, type 1, at least one image.
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] | (b[5] << 8)) > 0) return 'image/x-icon';
  return null;
}
function looksSvg(b) {
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<') && head.includes('<svg'));
}
// The upstream label may be wrong (octet-stream, image/jpg...), never trusted, but an
// explicit non-image label is refused before reading the body.
function labelAllowed(ct) {
  const mime = String(ct || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') return 'ok';
  if (mime === 'image/svg+xml') return 'svg';
  return mime.startsWith('image/') ? 'ok' : 'no';
}

// ── caches ────────────────────────────────────────────────────────────────
const cache = new Map(); // url -> { body, type, exp } (Map order = LRU order)
let cacheBytes = 0;
function cacheDelete(url) {
  const e = cache.get(url);
  if (e) { cacheBytes -= e.body.length; cache.delete(url); }
}
function cacheGet(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (e.exp <= Date.now()) { cacheDelete(url); return null; }
  cache.delete(url); // refresh recency
  cache.set(url, e);
  return e;
}
function cacheSet(url, entry) {
  cacheDelete(url);
  while (cache.size && (cache.size >= CACHE_MAX || cacheBytes + entry.body.length > CACHE_BUDGET)) {
    cacheDelete(cache.keys().next().value);
  }
  cache.set(url, entry);
  cacheBytes += entry.body.length;
}
const neg = new Map(); // url -> { status, exp } (same TTL for all: insertion order = expiry order)
function negGet(url) {
  const e = neg.get(url);
  if (!e) return 0;
  if (e.exp <= Date.now()) { neg.delete(url); return 0; }
  return e.status;
}
function negSet(url, status) {
  neg.delete(url);
  while (neg.size >= NEG_MAX) neg.delete(neg.keys().next().value);
  neg.set(url, { status, exp: Date.now() + NEG_TTL_MS });
}

// ── upstream concurrency ──────────────────────────────────────────────────
// At most MAX_ACTIVE fetches run; the rest wait in one FIFO per client, served round
// robin. When the waiting room is full, the client holding the most waiting fetches gives
// up its newest one: a single client (a page full of logos on hanging hosts) can no
// longer fill the queue and turn every other viewer's uncached logos into 503s.
let active = 0;
let waiting = 0;
const queues = new Map(); // client -> [{ resolve, reject }] (Map order = round-robin turn)
const busy = () => Object.assign(new Error('busy'), { status: 503, transient: true });
function acquire(client) {
  if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
  if (waiting >= MAX_QUEUED) {
    let heavy = null;
    for (const [c, q] of queues) if (!heavy || q.length > queues.get(heavy).length) heavy = c;
    const mine = queues.get(client)?.length || 0;
    if (heavy === null || queues.get(heavy).length <= mine + 1) return Promise.reject(busy());
    const hq = queues.get(heavy);
    hq.pop().reject(busy());
    waiting--;
    if (!hq.length) queues.delete(heavy);
  }
  return new Promise((resolve, reject) => {
    let q = queues.get(client);
    if (!q) queues.set(client, (q = []));
    q.push({ resolve, reject });
    waiting++;
  });
}
function release() {
  for (const [c, q] of queues) {
    const next = q.shift();
    waiting--;
    queues.delete(c);
    if (q.length) queues.set(c, q); // to the back of the round robin
    next.resolve(); // the slot passes on
    return;
  }
  active--;
}

// A host whose fetches hit the 10 s deadline HOST_TRIP times in a row (no success in
// between) is not contacted for HOST_DOWN_MS: its queued logos fail at once instead of
// holding a slot 10 s each. One success resets the count (a busy healthy host never trips).
const HOST_TRIP = 3;
const HOST_DOWN_MS = 60_000;
const hosts = new Map(); // host -> { fails, until }
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
function hostDown(host) {
  const h = hosts.get(host);
  if (!h?.until) return false;
  if (h.until > Date.now()) return true;
  h.until = 0; // half open: the next fetch tries again (one more timeout re-trips it)
  h.fails = HOST_TRIP - 1;
  return false;
}
function hostResult(host, timedOut) {
  if (!timedOut) { hosts.delete(host); return; }
  const h = hosts.get(host) || { fails: 0, until: 0 };
  if (++h.fails >= HOST_TRIP) h.until = Date.now() + HOST_DOWN_MS;
  hosts.delete(host);
  hosts.set(host, h);
  while (hosts.size > NEG_MAX) hosts.delete(hosts.keys().next().value);
}
const unreachable = () => Object.assign(new Error('upstream unreachable'), { status: 504, transient: true });

const failure = (status, msg) => Object.assign(new Error(msg), { status });

// One GET, bounded and sniffed -> { body, type }, or a failure carrying its status.
async function fetchOnce(url, privateHost, signal) {
  let res;
  try {
    res = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: ACCEPT }, signal }, { maxHops: 4, privateHost });
  } catch {
    throw failure(502, 'upstream unavailable'); // SSRF refusal, DNS, timeout, too many redirects
  }
  const drop = () => res.body?.cancel().catch(() => {});
  if (!res.ok) { drop(); throw failure(502, 'upstream unavailable'); }
  const label = labelAllowed(res.headers.get('content-type'));
  if (label !== 'ok') { drop(); throw failure(label === 'svg' ? 415 : 502, label === 'svg' ? 'unsupported image type' : 'not an image'); }
  const len = res.headers.get('content-length');
  if (len && /^\d+$/.test(len) && Number(len) > MAX_BYTES && !res.headers.get('content-encoding')) { drop(); throw failure(502, 'image too large'); }
  let body;
  try {
    // Stop after the first bytes when they are not an image (an HTML error page).
    body = await readCapped(res, MAX_BYTES, { peek: (b) => !!sniffImage(b) || looksSvg(b) });
  } catch (e) {
    if (e?.code === 'TOO_LARGE') throw failure(502, 'image too large');
    throw failure(502, 'upstream unavailable');
  }
  if (body.length > MAX_BYTES) throw failure(502, 'image too large');
  const type = sniffImage(body);
  if (!type) throw failure(looksSvg(body) ? 415 : 502, looksSvg(body) ? 'unsupported image type' : 'not an image');
  return { body, type };
}

// imgur hosts ~70 % of the catalog logos, many as 2000 px PNGs (100-250 KB) shown at
// 300 px. It serves its own WebP renditions (alpha kept): <id>m.webp (320 px) and
// <id>l.webp (640 px); <id>t.webp does NOT exist (302 to an HTML page). Same host,
// derived from a vended URL; a failure keeps the original. No GIF (animation).
const IMGUR = /^https:\/\/i\.imgur\.com\/([A-Za-z0-9]{5,10})\.(?:png|jpe?g|webp)$/i;
const IMGUR_BIG = 48 * 1024;
export function imgurRendition(url, size = 'l') {
  const m = IMGUR.exec(url);
  return m ? `https://i.imgur.com/${m[1]}${size}.webp` : null;
}
// Wikimedia thumbnails (/thumb/<path>/<n>px-<name>) come at 960 px for a 130 px slot. Its
// standard thumbnail steps include 120 and 330 px; the path is only ever made SMALLER.
const WIKI = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[^?#]+\/thumb\/[^?#]+\/)(\d{2,4})px-([^/?#]+)$/;
const WIKI_STEP = { 96: 120, 320: 330 };

// Display-size hint from the page (?w=): 96 (guide, radios), 320 (cards), 640 (hero).
// Anything else = no hint (the legacy behaviour: imgur's 640 px rendition when big).
export const IMG_WIDTHS = [96, 320, 640];
export function renditionFor(url, w) {
  if (!w) return null;
  const imgur = imgurRendition(url, w <= 320 ? 'm' : 'l');
  if (imgur) return imgur;
  const m = WIKI.exec(url);
  const step = WIKI_STEP[w];
  return m && step && Number(m[2]) > step ? `${m[1]}${step}px-${m[3]}` : null;
}

async function fetchImage(url, privateHost, w, client) {
  const host = hostOf(url);
  if (hostDown(host)) throw unreachable();
  await acquire(client);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    if (hostDown(host)) throw unreachable(); // tripped while this one was waiting
    let img;
    try {
      img = await fetchOnce(url, privateHost, ctrl.signal);
      hostResult(host, false);
    } catch (e) {
      // Any answer (a 404, an SVG...) proves the host alive; only our deadline counts.
      hostResult(host, ctrl.signal.aborted);
      throw e;
    }
    // With a size hint the rendition is always tried; without one, only for a big imgur
    // original. The smaller of the two is kept (a rendition is never a GIF: animation).
    const smaller = w ? renditionFor(url, w) : img.body.length > IMGUR_BIG ? imgurRendition(url) : null;
    if (smaller) {
      try {
        const alt = await fetchOnce(smaller, null, ctrl.signal);
        if (alt.type !== 'image/gif' && alt.body.length < img.body.length) img = alt;
      } catch { /* keep the original */ }
    }
    return { ...img, exp: Date.now() + CACHE_TTL_MS };
  } finally {
    clearTimeout(timer);
    release();
  }
}

// One upstream fetch per URL at a time, shared by concurrent viewers.
const inflight = new Map();
function load(key, url, privateHost, w, client) {
  let p = inflight.get(key);
  if (!p) {
    p = fetchImage(url, privateHost, w, client).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// Which vended URL is this, and may it reach the LAN? null = not ours.
function sourceOf(url) {
  const logo = getLogoMeta(url);
  if (logo) {
    if (logo.custom && config.allowPrivateSources) {
      try { return { privateHost: new URL(url).host }; } catch { return null; }
    }
    return { privateHost: null };
  }
  return isKnownRadioIcon(url) ? { privateHost: null } : null;
}

// Our headers, set on every answer (image or error). Nothing upstream is copied.
function lockDown(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function fail(res, status, error) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error });
}
// A dead or refused logo is an expected outcome (the page shows a monogram instead),
// not a fault: an <img> (Sec-Fetch-Dest: image) gets 204 No Content, which fires its
// onerror WITHOUT a "Failed to load resource" console error. The real status rides in
// X-Img-Status; any other caller (curl, tests, monitoring) gets it as the status.
function noImage(req, res, status, error) {
  if (req.get('sec-fetch-dest') !== 'image') return fail(res, status, error);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Img-Status', String(status));
  return res.status(204).end();
}

imgRouter.get('/img', imgLimit, async (req, res) => {
  lockDown(res);
  const u = req.query.u;
  if (typeof u !== 'string' || !u || u.length > MAX_URL || !/^https?:\/\//i.test(u)) return fail(res, 400, 'bad request');
  const src = sourceOf(u);
  if (!src) return fail(res, 404, 'not found');
  // An unknown w is ignored (no hint), never an error: an old page keeps working.
  const wn = Number(typeof req.query.w === 'string' ? req.query.w : 0);
  const w = IMG_WIDTHS.includes(wn) ? wn : 0;
  const key = w ? `${w}|${u}` : u; // one cached copy per (url, size)
  let img = cacheGet(key);
  if (!img) {
    const known = negGet(u); // the original's failure: the same for every size
    if (known) return noImage(req, res, known, 'unavailable');
    try {
      img = await load(key, u, src.privateHost, w, req.ip || req.socket?.remoteAddress || '');
      cacheSet(key, img);
    } catch (e) {
      const status = e?.status || 502;
      if (!e?.transient) negSet(u, status);
      return noImage(req, res, status, e?.message || 'unavailable');
    }
  }
  res.setHeader('Content-Type', img.type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).send(img.body); // Express adds Content-Length + an ETag (304 on revalidation)
});

