import { Router } from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { stableId, classifyKind } from './util.js';
import { setCustomItems } from './catalog.js';
import { safeFetch } from './netguard.js';

const MAX_PLAYLIST_BYTES = 25 * 1024 * 1024; // 25 MB hard cap on a remote playlist
const NSFW_RE = /\b(xxx|porn|adult|18\+|sex|erotic|hot ?cam|brazzers)\b/i;

// User-supplied M3U / M3U8 playlists (e.g. the user's own IPTV provider).
// Parsed into the same normalized Channel shape and merged into the catalog,
// so every filter / search / health-check / player works on them too.

const SOURCES_FILE = join(config.dataDir, 'sources.json');
let sources = [];   // [{ id, name, url, addedAt, count, lastError, lastFetched }]
let loaded = false;

let writeChain = Promise.resolve();
function save() {
  writeChain = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${SOURCES_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(sources, null, 2));
    await rename(tmp, SOURCES_FILE);
  });
  return writeChain;
}

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

// Re-fetch every source and push the merged custom items into the catalog.
async function rebuildCustom() {
  const all = [];
  const seen = new Set();
  for (const src of sources) {
    try {
      const items = src.inline ? parseM3U(src.inline, src.name) : await fetchSource(src);
      src.count = items.length;
      src.lastError = null;
      src.lastFetched = Date.now();
      for (const it of items) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        all.push(it);
      }
    } catch (e) {
      src.count = 0;
      src.lastError = String(e?.message || e);
    }
  }
  setCustomItems(all);
  await save();
  return all.length;
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
    const n = await rebuildCustom().catch(() => 0);
    console.log(`[sources] loaded ${sources.length} M3U source(s), ${n} custom channels`);
  }
}

const publicSrc = (s) => ({
  id: s.id, name: s.name, url: s.url, addedAt: s.addedAt,
  count: s.count || 0, lastError: s.lastError || null, lastFetched: s.lastFetched || null,
});

// GET is readable by anyone allowed to see the catalog; mutations are admin-only (mounted under requireAdmin).
export const sourcesPublicRouter = Router();
sourcesPublicRouter.get('/sources', (_req, res) => res.json({ sources: sources.map(publicSrc) }));

export const sourcesAdminRouter = Router();

sourcesAdminRouter.post('/sources', async (req, res) => {
  const { name, url, text } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    if (text) {
      // Inline playlist text: store as an inline source.
      const items = parseM3U(text, name);
      if (!items.length) return res.status(400).json({ error: 'no channels found in playlist text' });
      const src = { id: randomUUID(), name, url: null, inline: text, addedAt: Date.now(), count: items.length };
      sources.push(src);
    } else if (url && /^https?:\/\//i.test(url)) {
      const src = { id: randomUUID(), name, url, addedAt: Date.now(), count: 0 };
      await fetchSource(src); // validate before saving
      sources.push(src);
    } else {
      return res.status(400).json({ error: 'provide a valid url or playlist text' });
    }
    await rebuildCustom();
    res.json({ sources: sources.map(publicSrc) });
  } catch (e) {
    res.status(400).json({ error: `could not import: ${String(e?.message || e)}` });
  }
});

sourcesAdminRouter.delete('/sources/:id', async (req, res) => {
  const before = sources.length;
  sources = sources.filter((s) => s.id !== req.params.id);
  if (sources.length === before) return res.status(404).json({ error: 'not found' });
  await rebuildCustom();
  res.json({ sources: sources.map(publicSrc) });
});

sourcesAdminRouter.post('/sources/refresh', async (_req, res) => {
  const n = await rebuildCustom();
  res.json({ count: n, sources: sources.map(publicSrc) });
});
