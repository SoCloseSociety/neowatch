import { Router } from 'express';
import { safeFetch } from './netguard.js';

// Films VOD from the Internet Archive's public-domain "feature_films" collection
// (legal, freely redistributable: classics, cult, genre, docs). Server-side fetch +
// cache; posters come from IA's image service (no extra calls) and the playable mp4
// URL is resolved lazily at play time (one metadata call), so the catalog stays light.

const TTL_MS = 6 * 3600 * 1000;
const SEARCH_TTL_MS = 6 * 3600 * 1000;
const playCache = new Map(); // identifier -> { at, url }
let cache = { at: 0, films: [] };

const IA = 'https://archive.org';
// Require an h.264 derivative so every listed film is browser-playable.
const SEARCH_URL =
  `${IA}/advancedsearch.php?q=` +
  encodeURIComponent('collection:(feature_films) AND mediatype:(movies) AND format:(h.264)') +
  '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description&fl[]=subject&fl[]=downloads' +
  '&sort[]=downloads+desc&rows=400&page=1&output=json';

// Drop obvious adult/exploitation titles (IA's public-domain set has a few).
const ADULT = /\b(sex|xxx|porn|nude|nudie|erotic|adult|hardcore|porno)\b/i;

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // safeFetch re-validates every redirect hop against assertPublicHost (archive.org
    // 302s /download + /metadata to its CDN) and pins connect-time DNS -- so the
    // user-influenced :id can never steer the request at a private/internal host.
    const res = await safeFetch(url, { headers: { 'User-Agent': 'NEOWATCH/1.0' }, signal: ctrl.signal });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } throw new Error(`HTTP ${res.status}`); }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

async function loadFilms() {
  if (cache.films.length && Date.now() - cache.at < SEARCH_TTL_MS) return cache.films;
  const data = await fetchJson(SEARCH_URL);
  const docs = data?.response?.docs || [];
  const films = docs
    .filter((d) => d.identifier && d.title && !ADULT.test(first(d.title)) && !(Array.isArray(d.subject) ? d.subject.join(' ') : d.subject || '').match(ADULT))
    .map((d) => ({
      id: d.identifier,
      title: first(d.title),
      year: d.year ? Number(d.year) || null : null,
      description: String(first(d.description) || '').replace(/<[^>]+>/g, '').trim().slice(0, 600),
      genres: (Array.isArray(d.subject) ? d.subject : [d.subject]).filter(Boolean).slice(0, 4),
      poster: `${IA}/services/img/${encodeURIComponent(d.identifier)}`,
    }));
  cache = { at: Date.now(), films };
  return films;
}

// Resolve a browser-playable mp4 for an IA item (prefer the h.264 derivative).
async function resolvePlayUrl(id) {
  const hit = playCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.url;
  const meta = await fetchJson(`${IA}/metadata/${encodeURIComponent(id)}`);
  const files = (meta?.files || []).filter((f) => f && typeof f.name === 'string');
  // Prefer h.264 mp4 (best browser support); fall back to any mp4, then webm/ogv.
  const pick =
    files.find((f) => /\.mp4$/i.test(f.name) && /h\.?264/i.test(f.format || '')) ||
    files.find((f) => /\.mp4$/i.test(f.name) && /512kb|mpeg4/i.test(f.format || '')) ||
    files.find((f) => /\.mp4$/i.test(f.name)) ||
    files.find((f) => /\.(webm|ogv|ogg)$/i.test(f.name));
  if (!pick) return null;
  const url = `${IA}/download/${encodeURIComponent(id)}/${encodeURIComponent(pick.name)}`;
  playCache.set(id, { at: Date.now(), url });
  return url;
}

export const filmsRouter = Router();

filmsRouter.get('/films', async (_req, res) => {
  try {
    res.json({ films: await loadFilms() });
  } catch {
    res.status(503).json({ films: [], error: 'films unavailable' });
  }
});

filmsRouter.get('/films/:id/play', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9._@-]{1,200}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const url = await resolvePlayUrl(id);
    if (!url) return res.status(404).json({ error: 'no playable file' });
    res.json({ url });
  } catch {
    res.status(503).json({ error: 'unavailable' });
  }
});
