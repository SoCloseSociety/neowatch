import { Router } from 'express';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { safeFetch } from './netguard.js';
import { getByChannelId } from './catalog.js';
import { rateLimit } from './ratelimit.js';
import { readJsonArray } from './util.js';

// EPG (electronic program guide) from XMLTV sources. Most IPTV providers ship
// an XMLTV (epg.xml / xmltv.php, often gzipped) alongside their M3U; programmes
// map to channels by tvg-id (== our channel.channelId). Enables per-channel
// now/next and "search by programme" across channels.

// Accent-insensitive normaliser (matches catalog search, so "telediario" finds
// "Telediário"). Applied once per programme in reindex(), never per search request.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const EPG_FILE = join(config.dataDir, 'epg.json');
const MAX_XMLTV_BYTES = 80 * 1024 * 1024;
const MAX_PROGRAMMES = 600_000;
const EPG_REFRESH_MS = 6 * 60 * 60 * 1000; // re-fetch the hosted guide every 6h
const EPG_RETRY_MS = 15 * 60 * 1000;       // a failed source is retried sooner
const NAME_MAX = 80;
const URL_MAX = 2048;
// Whole fetch (headers + body): the agent's bodyTimeout only bounds the silence between
// chunks, so a provider dripping a byte every 20 s held the rebuild queue forever.
const FETCH_DEADLINE_MS = 180_000;
let refreshTimer = null;
let retryTimer = null;
// Last good parse per source id: a failed fetch (provider blip, a refresh racing the
// nightly grab's rewrite) keeps the guide we had instead of emptying it for 6h.
const lastGood = new Map(); // srcId -> Map(channelId -> programmes)

let epgSources = [];                 // [{ id, name, url, addedAt, count, lastError, lastFetched }]
let byChannel = new Map();           // channelId -> [{ start, stop, title, desc }] sorted by start
let flat = [];                       // [{ id(channelId), title, n(normalized title), start, stop }] for programme search
let loaded = false;
let storeBroken = false; // epg.json unreadable/corrupt at boot: never save over it

// The caller gets this write's outcome; the queue itself never stays rejected (one
// failed write must not skip every later save).
let writeChain = Promise.resolve();
function save() {
  if (storeBroken) return Promise.reject(new Error(`${EPG_FILE} was unreadable at boot; not overwriting it (repair it and restart)`));
  const p = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${EPG_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(epgSources, null, 2));
    await rename(tmp, EPG_FILE);
  });
  writeChain = p.catch(() => {});
  return p;
}

// Express 4 does not catch a rejected async handler (the request would hang).
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[epg] route failed:', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

function parseXmltvTime(s) {
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, Se, tz] = m;
  let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(Se || 0));
  if (tz) {
    const sign = tz[0] === '-' ? 1 : -1;
    ms += sign * ((+tz.slice(1, 3)) * 60 + (+tz.slice(3, 5))) * 60000;
  } else if (config.epgDefaultTzMinutes) {
    // Timezone-less timestamp: apply the configured default offset.
    ms -= config.epgDefaultTzMinutes * 60000;
  }
  return ms;
}

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

// EPG channel ids often carry a feed suffix (e.g. "Arte.fr@SD", "BabyTV.uk@UK")
// and vary in case, while the catalog tvg-id is the bare id ("Arte.fr"). Normalize
// both sides (strip the @feed suffix, lowercase) so now/next + search actually match.
export const normEpgId = (id) => String(id || '').split('@')[0].trim().toLowerCase();

// Text of the first <tag ...>...</tag> inside a programme body, by indexOf (linear:
// a body full of unclosed tags is scanned once, not once per tag). The raw slice is
// capped before decode() so a giant title cannot feed the entity regexes megabytes.
const isNameChar = (c) => /[A-Za-z0-9_:-]/.test(c || '');
function tagText(body, tag, cap) {
  let from = 0;
  for (;;) {
    const i = body.indexOf(`<${tag}`, from);
    if (i === -1) return null;
    if (isNameChar(body[i + tag.length + 1])) { from = i + tag.length + 1; continue; } // <titles>, not <title>
    const gt = body.indexOf('>', i);
    if (gt === -1) return null;
    const close = body.indexOf(`</${tag}>`, gt + 1);
    if (close === -1) return null;
    return body.slice(gt + 1, Math.min(close, gt + 1 + cap));
  }
}

// Parse an XMLTV document into per-channel programme lists. indexOf scanner, linear in
// the input: a missing </programme> ends the parse instead of making every later
// <programme> rescan the rest of the document (the old global regex was quadratic).
export function parseXmltv(xml) {
  const map = new Map();
  let total = 0;
  let pos = 0;
  for (;;) {
    if (total >= MAX_PROGRAMMES) break;
    const open = xml.indexOf('<programme', pos);
    if (open === -1) break;
    if (isNameChar(xml[open + 10])) { pos = open + 10; continue; } // <programmes>, not <programme>
    const gt = xml.indexOf('>', open);
    if (gt === -1) break;
    const close = xml.indexOf('</programme>', gt + 1);
    if (close === -1) break;
    const attrs = xml.slice(open + 10, gt);
    const body = xml.slice(gt + 1, close);
    pos = close + 12;
    const ch = normEpgId((attrs.match(/channel="([^"]*)"/) || [])[1]);
    const startRaw = (attrs.match(/start="([^"]*)"/) || [])[1];
    const stopRaw = (attrs.match(/stop="([^"]*)"/) || [])[1];
    if (!ch || !startRaw) continue;
    const start = parseXmltvTime(startRaw);
    const stop = stopRaw ? parseXmltvTime(stopRaw) : null;
    if (start === null) continue;
    const titleRaw = tagText(body, 'title', 2000);
    const descRaw = tagText(body, 'desc', 4000);
    const title = titleRaw !== null ? decode(titleRaw).slice(0, 300) : '(sans titre)';
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch).push({ start, stop, title, desc: descRaw !== null ? decode(descRaw).slice(0, 400) : null });
    total++;
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start);
  return { map, total };
}

async function fetchXmltv(url) {
  // One deadline for headers + body (the signal also aborts reader.read()).
  const signal = AbortSignal.timeout(FETCH_DEADLINE_MS);
  try {
    return await fetchXmltvBody(url, signal);
  } catch (e) {
    if (signal.aborted) throw new Error(`timed out after ${FETCH_DEADLINE_MS / 1000} s`);
    throw e;
  }
}

async function fetchXmltvBody(url, signal) {
  // safeFetch re-validates every redirect hop (SSRF).
  const res = await safeFetch(url, { headers: { 'User-Agent': 'NEOWATCH/1.0' }, signal }, { allowPrivate: config.allowPrivateSources });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_XMLTV_BYTES) {
    res.body?.cancel().catch(() => {});
    throw new Error('EPG file too large');
  }
  // Stream with an incremental byte cap (a chunked body has no content-length to check).
  const chunks = [];
  let bytes = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_XMLTV_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error('EPG file too large');
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const isGz = url.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b);
  // Bound the inflated size (decompression-bomb guard).
  const xml = (isGz ? gunzipSync(buf, { maxOutputLength: MAX_XMLTV_BYTES }) : buf).toString('utf8');
  if (!xml.includes('<tv') && !xml.includes('<programme')) throw new Error('not an XMLTV file');
  return xml;
}

function reindex(perSourceMaps) {
  const merged = new Map();
  for (const map of perSourceMaps) {
    for (const [ch, list] of map) {
      if (!merged.has(ch)) merged.set(ch, []);
      merged.get(ch).push(...list);
    }
  }
  const flatArr = [];
  // Reruns share a title: normalize each distinct title once and share the string.
  const normed = new Map();
  const nOf = (t) => {
    let n = normed.get(t);
    if (n === undefined) { n = norm(t); normed.set(t, n); }
    return n;
  };
  for (const [ch, raw] of merged) {
    raw.sort((a, b) => a.start - b.start);
    // Two sources (or two @feeds of one channel, which normEpgId folds together) list the
    // same show: keep it once (same start + same normalized title). The duplicates used
    // to fill the /epg/day and grid caps with past shows.
    const seen = new Set();
    const list = raw.filter((p) => {
      const k = `${p.start}|${nOf(p.title)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    merged.set(ch, list);
    for (const p of list) flatArr.push({ id: ch, title: p.title, n: nOf(p.title), start: p.start, stop: p.stop });
  }
  byChannel = merged;
  flat = flatArr;
}

const mapTotal = (map) => { let n = 0; for (const l of map.values()) n += l.length; return n; };

// Index from the CURRENT source list: a source deleted while a fetch ran must not come back.
function reindexCurrent() {
  const live = new Set(epgSources.map((s) => s.id));
  for (const id of lastGood.keys()) if (!live.has(id)) lastGood.delete(id);
  reindex(epgSources.map((s) => lastGood.get(s.id)).filter(Boolean));
}

// force = re-fetch URL sources; otherwise a source already parsed (lastGood) is reused,
// so a delete or an add never re-downloads the others. A failed fetch keeps the source's
// last good guide and records lastError.
async function doRebuild(force) {
  let failed = false;
  for (const src of epgSources) {
    let map = lastGood.get(src.id);
    if (src.inline) {
      if (!map) map = parseXmltv(src.inline).map;
    } else if (force || !map) {
      try {
        map = parseXmltv(await fetchXmltv(src.url)).map;
        src.lastError = null;
        src.lastFetched = Date.now();
      } catch (e) {
        src.lastError = String(e?.message || e);
        failed = true;
      }
    }
    if (!map) { src.count = 0; continue; }
    lastGood.set(src.id, map);
    src.count = mapTotal(map);
  }
  reindexCurrent();
  if (failed) scheduleRetry();
  if (!storeBroken) await save(); // a broken store refreshes in memory only
  return flat.length;
}

// Serialized (the last mutation wins, the queue survives a failed run).
let rebuildChain = Promise.resolve();
function rebuild(force = false) {
  const p = rebuildChain.then(() => doRebuild(force));
  rebuildChain = p.catch(() => {});
  return p;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    rebuild(true).catch(() => {});
  }, EPG_RETRY_MS);
  retryTimer.unref?.();
}
// Periodically re-fetch the hosted guide so the nightly grab's fresh XMLTV reaches
// users without a server restart (the guide updates daily; programmes are time-bound).
// Also started by the first admin-added source on an instance that booted without one.
function ensureRefreshTimer() {
  if (refreshTimer || !epgSources.length) return;
  refreshTimer = setInterval(() => {
    rebuild(true).then((n) => console.log(`[epg] refreshed ${n} programmes`)).catch(() => {});
  }, EPG_REFRESH_MS);
  refreshTimer.unref?.();
}

export async function initEpg() {
  if (!loaded) {
    // Only a missing file is "no sources"; a corrupt one is kept as is (never saved over).
    const { data } = await readJsonArray(EPG_FILE, 'epg');
    epgSources = data || [];
    storeBroken = !data;
    if (storeBroken) console.error(`  [epg] changes will NOT be saved (the file is kept as is) until it is repaired and the server restarted.\n`);
    loaded = true;
  }
  // Seed a default XMLTV source (operator-provided) if none configured yet.
  if (config.epgDefaultUrl && !epgSources.some((s) => s.url === config.epgDefaultUrl)) {
    epgSources.push({ id: randomUUID(), name: 'Default EPG', url: config.epgDefaultUrl, addedAt: Date.now(), count: 0 });
  }
  if (epgSources.length) {
    const n = await rebuild(true).catch(() => 0);
    console.log(`[epg] loaded ${epgSources.length} XMLTV source(s), ${n} programmes`);
  }
  ensureRefreshTimer();
}

export const epgEnabled = () => flat.length > 0;

function nowNext(channelId, now) {
  const list = byChannel.get(normEpgId(channelId));
  if (!list || !list.length) return null;
  // Merged sources overlap (a 18:00-20:00 block over an 18:30 show, two shows at the
  // same minute): the airing programme is the one that started last (shortest on a
  // tie), and next is the first one starting after now -- never the current one again.
  let current = null;
  let next = null;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.start > now) {
      next = p;
      break;
    }
    const end = p.stop || (list[i + 1]?.start ?? p.start + 3600000);
    if (now < end && (!current || p.start > current.start
      || (p.start === current.start && end - p.start < (current.stop || end) - current.start))) {
      current = p;
    }
  }
  return { now: current, next };
}

// ── Routes ─────────────────────────────────────────────────────
export const epgPublicRouter = Router();

// GET /api/epg/now?ids=CNN.us,BBC.uk
epgPublicRouter.get('/epg/now', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
  const now = Date.now();
  const out = {};
  for (const id of ids) {
    const nn = nowNext(id, now);
    if (nn) out[id] = nn;
  }
  res.json({ channels: out });
});

// Does this channelId have any guide data? (normalized match)
export const hasEpg = (channelId) => byChannel.has(normEpgId(channelId));

// Today's schedule (now -3h .. +26h) for one channel, capped. Shared by /epg/day + the grid.
// The cap keeps what is airing and coming up: at most a quarter of it goes to past shows
// (the newest ones), the rest fills forward from the first programme not yet over. Taking
// the first N from now -3h cut dense guides (15 min slots) before the current show.
export function epgDay(channelId, cap = 60) {
  const list = channelId ? byChannel.get(normEpgId(channelId)) : null;
  if (!list || !list.length) return [];
  const now = Date.now();
  const from = now - 3 * 3600000;
  const to = now + 26 * 3600000;
  const end = (p) => p.stop || p.start + 3600000;
  const win = list.filter((p) => end(p) > from && p.start < to);
  let first = 0;
  if (win.length > cap) {
    let cur = win.findIndex((p) => end(p) > now);
    if (cur === -1) cur = win.length;
    first = Math.max(0, Math.min(cur - Math.floor(cap / 4), win.length - cap));
  }
  return win
    .slice(first, first + cap)
    .map((p) => ({ start: p.start, stop: p.stop, title: p.title, desc: p.desc || null }));
}

// GET /api/epg/day?id=CNN.us  -> today's schedule for one channel (for the detail page)
epgPublicRouter.get('/epg/day', (req, res) => {
  res.json({ programmes: epgDay(String(req.query.id || '').trim()), enabled: epgEnabled() });
});

// Channel ids that currently have a guide (for coverage reporting).
export const epgChannelIds = () => new Set(byChannel.keys());

// GET /api/epg/search?q=...&window=now|soon  -> programmes airing now or upcoming
// Public, so throttled; titles are normalized once at index time (p.n).
const searchLimit = rateLimit({ windowMs: 60_000, max: 60, name: 'epg-search' });
epgPublicRouter.get('/epg/search', searchLimit, (req, res) => {
  const q = norm(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '').trim();
  if (q.length < 2 || !flat.length) return res.json({ results: [], enabled: epgEnabled() });
  const now = Date.now();
  const horizon = now + 7 * 24 * 3600 * 1000; // next 7 days
  // Every match within the scan cap is gathered, THEN sorted (live first, then by start)
  // and cut: cutting at 60 while walking `flat` (grouped by channel) kept the first
  // channel's reruns and dropped shows airing now elsewhere. At most PER_CHANNEL per
  // channel (its earliest: `flat` is sorted by start within a channel, so a live one is
  // among them), so one channel's week of reruns cannot fill the list or the sort.
  const RESULTS_MAX = 60;
  const PER_CHANNEL = 5;
  const matches = [];
  const perChannel = new Map();
  let scanned = 0;
  const MAX_SCAN = 200_000; // hard cap so a rare-term query can't pin a CPU
  for (const p of flat) {
    if (++scanned > MAX_SCAN) break;
    const end = p.stop || p.start + 3600000;
    if (end < now || p.start > horizon) continue;
    if (!p.n.includes(q)) continue;
    let c = perChannel.get(p.id);
    // Join to a catalog channel (once per channel) so the result is playable and labelled.
    if (!c) { c = { n: 0, ch: getByChannelId(p.id) }; perChannel.set(p.id, c); }
    if (!c.ch || c.n >= PER_CHANNEL) continue;
    c.n++;
    matches.push({ channelId: p.id, channel: c.ch, title: p.title, start: p.start, stop: p.stop, live: p.start <= now && now < end });
  }
  matches.sort((a, b) => Number(b.live) - Number(a.live) || a.start - b.start);
  const results = matches.slice(0, RESULTS_MAX);
  res.json({ results, enabled: epgEnabled() });
});

// Public projection: no url (provider guides carry credentials) and no error text.
epgPublicRouter.get('/epg/sources', (_req, res) =>
  res.json({
    enabled: epgEnabled(),
    sources: epgSources.map((s) => ({ id: s.id, name: s.name, count: s.count || 0, lastFetched: s.lastFetched || null, hasError: !!s.lastError })),
  })
);

export const epgAdminRouter = Router();

// A broken epg.json (kept as is at boot) refuses every change up front: indexing into
// memory and then failing the save showed a guide that vanished at the next restart.
const storeWritable = (_req, res, next) => (storeBroken
  ? res.status(503).json({ error: 'epg.json is unreadable: repair it and restart the server' })
  : next());

const pubEpg = () => epgSources.map((s) => ({
  id: s.id, name: s.name, url: s.url || null, count: s.count || 0, lastError: s.lastError || null, lastFetched: s.lastFetched || null,
}));

// Admin list, with urls + errors (GET /api/admin/epg).
epgAdminRouter.get('/epg', (_req, res) => res.json({ enabled: epgEnabled(), sources: pubEpg() }));

epgAdminRouter.post('/epg', storeWritable, wrap(async (req, res) => {
  const { name, url, text } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const label = name.trim().slice(0, NAME_MAX);
  try {
    if (typeof text === 'string' && text) {
      const { map, total } = parseXmltv(text);
      if (!total) return res.status(400).json({ error: 'no programmes found in the pasted XMLTV' });
      const src = { id: randomUUID(), name: label, url: null, inline: text, addedAt: Date.now(), count: total };
      lastGood.set(src.id, map);
      epgSources.push(src);
    } else if (typeof url === 'string' && url.length <= URL_MAX && /^https?:\/\//i.test(url)) {
      // Validate before saving; the parsed guide seeds the rebuild (no second download).
      const { map, total } = parseXmltv(await fetchXmltv(url));
      const src = { id: randomUUID(), name: label, url, addedAt: Date.now(), count: total, lastFetched: Date.now() };
      lastGood.set(src.id, map);
      epgSources.push(src);
    } else {
      return res.status(400).json({ error: 'provide a valid url or pasted XMLTV text' });
    }
  } catch (e) {
    return res.status(400).json({ error: `could not import EPG: ${String(e?.message || e)}` });
  }
  // The new guide is already parsed: index + save now, without queueing behind a refresh
  // that may still be downloading (a running rebuild indexes the current list when done).
  reindexCurrent();
  await save();
  ensureRefreshTimer();
  res.json({ sources: pubEpg() });
}));

epgAdminRouter.delete('/epg/:id', storeWritable, wrap(async (req, res) => {
  const before = epgSources.length;
  epgSources = epgSources.filter((s) => s.id !== req.params.id);
  if (epgSources.length === before) return res.status(404).json({ error: 'not found' });
  lastGood.delete(req.params.id);
  reindexCurrent(); // at once, not after a refresh still in flight
  await save();
  res.json({ ok: true });
}));

epgAdminRouter.post('/epg/refresh', wrap(async (_req, res) => {
  const n = await rebuild(true);
  res.json({ count: n });
}));
