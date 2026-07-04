import { Router } from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { safeFetch } from './netguard.js';
import { getByChannelId } from './catalog.js';

// EPG (electronic program guide) from XMLTV sources. Most IPTV providers ship
// an XMLTV (epg.xml / xmltv.php, often gzipped) alongside their M3U; programmes
// map to channels by tvg-id (== our channel.channelId). Enables per-channel
// now/next and "search by programme" across channels.

// Accent-insensitive normaliser (matches catalog search, so "telediario" finds
// "Telediário"). Cheap enough given the 200k programme scan cap below.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const EPG_FILE = join(config.dataDir, 'epg.json');
const MAX_XMLTV_BYTES = 80 * 1024 * 1024;
const MAX_PROGRAMMES = 600_000;
const EPG_REFRESH_MS = 6 * 60 * 60 * 1000; // re-fetch the hosted guide every 6h
let refreshTimer = null;

let epgSources = [];                 // [{ id, name, url, addedAt, count, lastError, lastFetched }]
let byChannel = new Map();           // channelId -> [{ start, stop, title, desc }] sorted by start
let flat = [];                       // [{ id(channelId), title, start, stop }] for programme search
let loaded = false;

let writeChain = Promise.resolve();
function save() {
  writeChain = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${EPG_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(epgSources, null, 2));
    await rename(tmp, EPG_FILE);
  });
  return writeChain;
}

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

// Parse an XMLTV document into per-channel programme lists.
export function parseXmltv(xml) {
  const map = new Map();
  let total = 0;
  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = progRe.exec(xml)) !== null) {
    if (total >= MAX_PROGRAMMES) break;
    const attrs = m[1];
    const body = m[2];
    const ch = normEpgId((attrs.match(/channel="([^"]*)"/) || [])[1]);
    const startRaw = (attrs.match(/start="([^"]*)"/) || [])[1];
    const stopRaw = (attrs.match(/stop="([^"]*)"/) || [])[1];
    if (!ch || !startRaw) continue;
    const start = parseXmltvTime(startRaw);
    const stop = stopRaw ? parseXmltvTime(stopRaw) : null;
    if (start === null) continue;
    const titleM = body.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const descM = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/);
    const title = titleM ? decode(titleM[1]) : '(sans titre)';
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch).push({ start, stop, title, desc: descM ? decode(descM[1]).slice(0, 400) : null });
    total++;
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start);
  return { map, total };
}

async function fetchXmltv(url) {
  // safeFetch re-validates every redirect hop (SSRF).
  const res = await safeFetch(url, { headers: { 'User-Agent': 'NEOWATCH/1.0' } }, { allowPrivate: config.allowPrivateSources });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_XMLTV_BYTES) throw new Error('EPG file too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_XMLTV_BYTES) throw new Error('EPG file too large');
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
  for (const [ch, list] of merged) {
    list.sort((a, b) => a.start - b.start);
    for (const p of list) flatArr.push({ id: ch, title: p.title, start: p.start, stop: p.stop });
  }
  byChannel = merged;
  flat = flatArr;
}

async function rebuild() {
  const maps = [];
  for (const src of epgSources) {
    try {
      const xml = src.inline ? src.inline : await fetchXmltv(src.url);
      const { map, total } = parseXmltv(xml);
      maps.push(map);
      src.count = total;
      src.lastError = null;
      src.lastFetched = Date.now();
    } catch (e) {
      src.count = 0;
      src.lastError = String(e?.message || e);
    }
  }
  reindex(maps);
  await save();
  return flat.length;
}

export async function initEpg() {
  if (!loaded) {
    try {
      epgSources = JSON.parse(await readFile(EPG_FILE, 'utf8'));
    } catch {
      epgSources = [];
    }
    loaded = true;
  }
  // Seed a default XMLTV source (operator-provided) if none configured yet.
  if (config.epgDefaultUrl && !epgSources.some((s) => s.url === config.epgDefaultUrl)) {
    epgSources.push({ id: randomUUID(), name: 'Default EPG', url: config.epgDefaultUrl, addedAt: Date.now(), count: 0 });
  }
  if (epgSources.length) {
    const n = await rebuild().catch(() => 0);
    console.log(`[epg] loaded ${epgSources.length} XMLTV source(s), ${n} programmes`);
  }
  // Periodically re-fetch the hosted guide so the nightly grab's fresh XMLTV reaches
  // users without a server restart (the guide updates daily; programmes are time-bound).
  if (!refreshTimer && epgSources.length) {
    refreshTimer = setInterval(() => {
      rebuild().then((n) => console.log(`[epg] refreshed ${n} programmes`)).catch(() => {});
    }, EPG_REFRESH_MS);
    refreshTimer.unref?.();
  }
}

export const epgEnabled = () => flat.length > 0;

function nowNext(channelId, now) {
  const list = byChannel.get(normEpgId(channelId));
  if (!list || !list.length) return null;
  let current = null;
  let next = null;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const end = p.stop || (list[i + 1]?.start ?? p.start + 3600000);
    if (p.start <= now && now < end) {
      current = p;
      next = list[i + 1] || null;
      break;
    }
    if (p.start > now) {
      next = p;
      break;
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
export function epgDay(channelId, cap = 60) {
  const list = channelId ? byChannel.get(normEpgId(channelId)) : null;
  if (!list || !list.length) return [];
  const now = Date.now();
  const from = now - 3 * 3600000;
  const to = now + 26 * 3600000;
  return list
    .filter((p) => (p.stop || p.start + 3600000) > from && p.start < to)
    .slice(0, cap)
    .map((p) => ({ start: p.start, stop: p.stop, title: p.title, desc: p.desc || null }));
}

// GET /api/epg/day?id=CNN.us  -> today's schedule for one channel (for the detail page)
epgPublicRouter.get('/epg/day', (req, res) => {
  res.json({ programmes: epgDay(String(req.query.id || '').trim()), enabled: epgEnabled() });
});

// Channel ids that currently have a guide (for coverage reporting).
export const epgChannelIds = () => new Set(byChannel.keys());

// GET /api/epg/search?q=...&window=now|soon  -> programmes airing now or upcoming
epgPublicRouter.get('/epg/search', (req, res) => {
  const q = norm(req.query.q).trim();
  if (!q || !flat.length) return res.json({ results: [], enabled: epgEnabled() });
  const now = Date.now();
  const horizon = now + 7 * 24 * 3600 * 1000; // next 7 days
  const results = [];
  let scanned = 0;
  const MAX_SCAN = 200_000; // hard cap so a rare-term query can't pin a CPU
  for (const p of flat) {
    if (++scanned > MAX_SCAN) break;
    const end = p.stop || p.start + 3600000;
    if (end < now || p.start > horizon) continue;
    if (!norm(p.title).includes(q)) continue;
    // Join to a catalog channel so the result is playable (and labelled).
    const ch = getByChannelId(p.id);
    if (!ch) continue;
    results.push({
      channelId: p.id,
      channel: ch,
      title: p.title,
      start: p.start,
      stop: p.stop,
      live: p.start <= now && now < end,
    });
    if (results.length >= 60) break;
  }
  results.sort((a, b) => Number(b.live) - Number(a.live) || a.start - b.start);
  res.json({ results, enabled: epgEnabled() });
});

epgPublicRouter.get('/epg/sources', (_req, res) =>
  res.json({
    enabled: epgEnabled(),
    sources: epgSources.map((s) => ({ id: s.id, name: s.name, url: s.url, count: s.count || 0, lastError: s.lastError || null })),
  })
);

export const epgAdminRouter = Router();

const pubEpg = () => epgSources.map((s) => ({ id: s.id, name: s.name, url: s.url || null, count: s.count || 0, lastError: s.lastError || null }));

epgAdminRouter.post('/epg', async (req, res) => {
  const { name, url, text } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    if (text) {
      const { total } = parseXmltv(text);
      if (!total) return res.status(400).json({ error: 'no programmes found in the pasted XMLTV' });
      epgSources.push({ id: randomUUID(), name, url: null, inline: text, addedAt: Date.now(), count: total });
    } else if (url && /^https?:\/\//i.test(url)) {
      await fetchXmltv(url); // validate before saving
      epgSources.push({ id: randomUUID(), name, url, addedAt: Date.now(), count: 0 });
    } else {
      return res.status(400).json({ error: 'provide a valid url or pasted XMLTV text' });
    }
    await rebuild();
    res.json({ sources: pubEpg() });
  } catch (e) {
    res.status(400).json({ error: `could not import EPG: ${String(e?.message || e)}` });
  }
});

epgAdminRouter.delete('/epg/:id', async (req, res) => {
  const before = epgSources.length;
  epgSources = epgSources.filter((s) => s.id !== req.params.id);
  if (epgSources.length === before) return res.status(404).json({ error: 'not found' });
  await rebuild();
  res.json({ ok: true });
});

epgAdminRouter.post('/epg/refresh', async (_req, res) => {
  const n = await rebuild();
  res.json({ count: n });
});
