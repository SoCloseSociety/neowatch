import { Router } from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { stableId, classifyKind } from './util.js';
import { setCustomItems } from './catalog.js';
import { safeFetch } from './netguard.js';

const MAX_PLAYLIST_BYTES = 25 * 1024 * 1024; // 25 MB hard cap on a remote playlist
const REFRESH_MS = 6 * 60 * 60 * 1000;      // re-fetch URL playlists every 6h
const RETRY_MS = 15 * 60 * 1000;            // a failed source is retried sooner
const NAME_MAX = 80;
const URL_MAX = 2048;
const NSFW_RE = /\b(xxx|porn|adult|18\+|sex|erotic|hot ?cam|brazzers)\b/i;

// User-supplied M3U / M3U8 playlists (e.g. the user's own IPTV provider).
// Parsed into the same normalized Channel shape and merged into the catalog,
// so every filter / search / health-check / player works on them too.

const SOURCES_FILE = join(config.dataDir, 'sources.json');
let sources = [];   // [{ id, name, url, addedAt, count, lastError, lastFetched }]
let loaded = false;
// Last good parse per source id: a provider blip (timeout, 5xx, truncated body) keeps
// the channels we already had instead of removing them until the next refresh.
const lastGood = new Map(); // srcId -> items[]
let refreshTimer = null;
let retryTimer = null;

// The caller gets this write's outcome; the queue itself never stays rejected (one
// failed write must not skip every later save).
let writeChain = Promise.resolve();
function save() {
  const p = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${SOURCES_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(sources, null, 2));
    await rename(tmp, SOURCES_FILE);
  });
  writeChain = p.catch(() => {});
  return p;
}

// Express 4 does not catch a rejected async handler (the request would hang).
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[sources] route failed:', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

// Map a free-text group-title to a known category id when possible.
function inferCategory(group) {
  const g = (group || '').toLowerCase();
  if (/sport|foot|soccer|bein|espn|calcio|liga|ligue|football/.test(g)) return 'sports';
  if (/news|info|actu/.test(g)) return 'news';
  if (/movie|cine|film/.test(g)) return 'movies';
  if (/serie|tv show|vod/.test(g)) return 'series';
  if (/kid|enfant|cartoon|disney/.test(g)) return 'kids';
  if (/music|musique|hits|mtv/.test(g)) return 'music';
  if (/doc/.test(g)) return 'documentary';
  if (/relig|islam|christ|gospel/.test(g)) return 'religious';
  return null;
}

const attr = (line, key) => {
  const m = line.match(new RegExp(`${key}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
};

const unquote = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Channel';
  }
};

// Parse an M3U/M3U8 playlist into normalized channel items.
export function parseM3U(text, sourceName) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let cur = null;
  let group = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // Name = text after the first comma that ends the attribute list. Prefer
      // the position right after the last quoted attribute to survive commas
      // inside quoted values (e.g. group-title="A, B").
      let name = 'Channel';
      const q = line.lastIndexOf('",');
      if (q !== -1) name = line.slice(q + 2).trim();
      else {
        const c = line.indexOf(',');
        if (c !== -1) name = line.slice(c + 1).trim();
      }
      cur = {
        name: name || 'Channel',
        logo: attr(line, 'tvg-logo'),
        group: attr(line, 'group-title') || group,
        tvgId: attr(line, 'tvg-id') || null,
        userAgent: null,
        referrer: null,
      };
    } else if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim();
      if (cur && !cur.group) cur.group = group;
    } else if (/^#EXTVLCOPT:http-user-agent\s*=/i.test(line)) {
      if (cur) cur.userAgent = unquote(line.split('=').slice(1).join('='));
    } else if (/^#EXTVLCOPT:http-referr?er\s*=/i.test(line)) {
      if (cur) cur.referrer = unquote(line.split('=').slice(1).join('='));
    } else if (!line.startsWith('#')) {
      // A URL line: finalize the current entry.
      if (!/^https?:\/\//i.test(line) || seen.has(line)) {
        cur = null;
        continue;
      }
      seen.add(line);
      const nsfw = NSFW_RE.test(`${cur?.name || ''} ${cur?.group || ''}`);
      if (nsfw && config.hideNsfw) {
        cur = null;
        continue;
      }
      const inferred = inferCategory(cur?.group);
      const cats = inferred ? ['custom', inferred] : ['custom'];
      items.push({
        id: stableId(line),
        channelId: cur?.tvgId || null,
        name: cur?.name && cur.name !== 'Channel' ? cur.name : hostnameOf(line),
        url: line,
        kind: classifyKind(line),
        quality: null,
        label: sourceName ? `src:${sourceName}` : null,
        userAgent: cur?.userAgent || null,
        referrer: cur?.referrer || null,
        logo: cur?.logo || undefined,
        categories: cats,
        categoryNames: cats.map((c) => (c === 'custom' ? 'Mes sources' : c)),
        country: null,
        countryName: cur?.group || null,
        flag: '📺',
        languages: [],
        languageNames: [],
        website: null,
        nsfw,
        source: 'custom',
      });
      cur = null;
    }
  }
  return items;
}

async function fetchSource(src) {
  // safeFetch re-validates every redirect hop (SSRF); allowPrivate for LAN providers.
  const res = await safeFetch(src.url, { headers: { 'User-Agent': 'NEOWATCH/1.0' } }, { allowPrivate: config.allowPrivateSources });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_PLAYLIST_BYTES) throw new Error('playlist too large');

  // Stream with an incremental byte cap (chunked responses bypass content-length).
  const reader = res.body?.getReader();
  let text = '';
  if (reader) {
    const dec = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_PLAYLIST_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error('playlist too large');
      }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  } else {
    text = await res.text();
  }
  if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) throw new Error('not an M3U playlist');
  return parseM3U(text, src.name);
}

// Merge every source into the catalog. force = re-fetch URL sources; otherwise a source
// already parsed (lastGood) is reused, so a delete or an add never re-downloads the rest.
// On a failed fetch the source keeps its last good channels and records lastError.
async function doRebuild(force) {
  let failed = false;
  for (const src of sources) {
    let items = lastGood.get(src.id);
    if (src.inline) {
      if (!items) items = parseM3U(src.inline, src.name);
    } else if (force || !items) {
      try {
        items = await fetchSource(src);
        src.lastError = null;
        src.lastFetched = Date.now();
      } catch (e) {
        src.lastError = String(e?.message || e);
        failed = true;
      }
    }
    if (!items) { src.count = 0; continue; }
    lastGood.set(src.id, items);
    src.count = items.length;
  }
  // Merge from the CURRENT list: a source deleted while we were fetching must not come back.
  const live = new Set(sources.map((s) => s.id));
  for (const id of lastGood.keys()) if (!live.has(id)) lastGood.delete(id);
  const all = [];
  const seen = new Set();
  for (const src of sources) {
    for (const it of lastGood.get(src.id) || []) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      all.push(it);
    }
  }
  setCustomItems(all);
  if (failed) scheduleRetry();
  await save();
  return all.length;
}

// Serialized: rebuilds run one after the other, each reading `sources` when it starts,
// so the last mutation always wins (a slow refresh can no longer re-add a deleted
// source by finishing last). The queue survives a failed run.
let rebuildChain = Promise.resolve();
function rebuildCustom(force = false) {
  const p = rebuildChain.then(() => doRebuild(force));
  rebuildChain = p.catch(() => {});
  return p;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    rebuildCustom(true).catch(() => {});
  }, RETRY_MS);
  retryTimer.unref?.();
}
function ensureRefreshTimer() {
  if (refreshTimer || !sources.some((s) => s.url)) return;
  refreshTimer = setInterval(() => {
    rebuildCustom(true).then((n) => console.log(`[sources] refreshed, ${n} custom channels`)).catch(() => {});
  }, REFRESH_MS);
  refreshTimer.unref?.();
}

export async function initSources() {
  if (!loaded) {
    try {
      sources = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
    } catch {
      sources = [];
    }
    loaded = true;
  }
  if (sources.length) {
    const n = await rebuildCustom(true).catch(() => 0);
    console.log(`[sources] loaded ${sources.length} M3U source(s), ${n} custom channels`);
  }
  ensureRefreshTimer();
}

// Public projection: no url (provider playlists carry credentials, and the playlist
// itself would bypass the custom-channel lock) and no error text (it can echo hosts).
const publicSrc = (s) => ({
  id: s.id, name: s.name, count: s.count || 0, lastFetched: s.lastFetched || null, hasError: !!s.lastError,
});
// Admin projection: everything but the inline playlist body.
const adminSrc = (s) => ({
  id: s.id, name: s.name, url: s.url || null, addedAt: s.addedAt,
  count: s.count || 0, lastError: s.lastError || null, lastFetched: s.lastFetched || null,
});

// GET is readable by anyone allowed to see the catalog; mutations are admin-only (mounted under requireAdmin).
export const sourcesPublicRouter = Router();
sourcesPublicRouter.get('/sources', (_req, res) => res.json({ sources: sources.map(publicSrc) }));

export const sourcesAdminRouter = Router();

sourcesAdminRouter.get('/sources', (_req, res) => res.json({ sources: sources.map(adminSrc) }));

sourcesAdminRouter.post('/sources', wrap(async (req, res) => {
  const { name, url, text } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const label = name.trim().slice(0, NAME_MAX);

  try {
    if (typeof text === 'string' && text) {
      // Inline playlist text: store as an inline source (size bounded by the JSON body limit).
      const items = parseM3U(text, label);
      if (!items.length) return res.status(400).json({ error: 'no channels found in playlist text' });
      const src = { id: randomUUID(), name: label, url: null, inline: text, addedAt: Date.now(), count: items.length };
      lastGood.set(src.id, items);
      sources.push(src);
    } else if (typeof url === 'string' && url.length <= URL_MAX && /^https?:\/\//i.test(url)) {
      const src = { id: randomUUID(), name: label, url, addedAt: Date.now(), count: 0 };
      // Validate before saving; the parsed result seeds the rebuild (no second download).
      const items = await fetchSource(src);
      src.lastFetched = Date.now();
      lastGood.set(src.id, items);
      sources.push(src);
    } else {
      return res.status(400).json({ error: 'provide a valid url or playlist text' });
    }
  } catch (e) {
    return res.status(400).json({ error: `could not import: ${String(e?.message || e)}` });
  }
  await rebuildCustom();
  ensureRefreshTimer();
  res.json({ sources: sources.map(adminSrc) });
}));

sourcesAdminRouter.delete('/sources/:id', wrap(async (req, res) => {
  const before = sources.length;
  sources = sources.filter((s) => s.id !== req.params.id);
  if (sources.length === before) return res.status(404).json({ error: 'not found' });
  lastGood.delete(req.params.id);
  await rebuildCustom();
  res.json({ sources: sources.map(adminSrc) });
}));

sourcesAdminRouter.post('/sources/refresh', wrap(async (_req, res) => {
  const n = await rebuildCustom(true);
  res.json({ count: n, sources: sources.map(adminSrc) });
}));
