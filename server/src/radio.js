import { Router } from 'express';
import { safeFetch } from './netguard.js';
import { proxyLink } from './signing.js';

// Internet radio from the community radio-browser.info directory (open API, no
// key). Same aggregation model as iptv-org for TV: we index publicly available
// streams, we host none. One upstream fetch per TTL; browse/search/filter are
// served from the in-memory normalized list.

const API = 'https://all.api.radio-browser.info/json/stations/search';
const TTL_MS = 6 * 3600 * 1000;
const FETCH_COUNT = 800;   // top stations by clicks, worldwide
const PAGE_MAX = 200;

let cache = { at: 0, stations: [] };

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, { headers: { 'User-Agent': 'NEOWATCH/1.0' }, signal: ctrl.signal });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } throw new Error(`HTTP ${res.status}`); }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

async function loadStations() {
  if (cache.stations.length && Date.now() - cache.at < TTL_MS) return cache.stations;
  const url = `${API}?limit=${FETCH_COUNT}&order=clickcount&reverse=true&hidebroken=true`;
  const data = await fetchJson(url);
  const seen = new Set();
  const stations = (Array.isArray(data) ? data : [])
    .filter((s) => s && s.stationuuid && s.name && (s.url_resolved || s.url))
    .filter((s) => { if (seen.has(s.stationuuid)) return false; seen.add(s.stationuuid); return true; })
    .map((s) => {
      const streamUrl = s.url_resolved || s.url;
      return {
        id: s.stationuuid,
        name: String(s.name).trim().slice(0, 80),
        url: streamUrl,
        // HTTP streams are blocked on our HTTPS page (mixed content) -> the
        // player uses the signed proxy for those; HTTPS plays direct (no VPS load).
        proxyUrl: proxyLink(streamUrl),
        favicon: /^https:\/\//i.test(s.favicon || '') ? s.favicon : null,
        country: s.country || null,
        countryCode: s.countrycode || null,
        tags: String(s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
        codec: s.codec || null,
        bitrate: Number(s.bitrate) || null,
        clicks: Number(s.clickcount) || 0,
        _search: norm(`${s.name} ${s.country || ''} ${s.tags || ''}`),
      };
    });
  cache = { at: Date.now(), stations };
  return stations;
}

export const radioRouter = Router();

// GET /api/radios?q=&country=FR&tag=jazz&page=1&limit=60
radioRouter.get('/radios', async (req, res) => {
  try {
    let list = await loadStations();
    const q = norm(req.query.q).trim();
    const country = String(req.query.country || '').toUpperCase();
    const tag = norm(req.query.tag).trim();
    if (country) list = list.filter((s) => s.countryCode === country);
    if (tag) list = list.filter((s) => s.tags.some((t) => norm(t).includes(tag)));
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      list = list.filter((s) => tokens.every((tk) => s._search.includes(tk)));
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), PAGE_MAX);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const start = (page - 1) * limit;
    const items = list.slice(start, start + limit).map(({ _search, ...s }) => s);
    res.json({ total: list.length, page, limit, pages: Math.ceil(list.length / limit), items });
  } catch {
    res.status(503).json({ total: 0, items: [], error: 'radios unavailable' });
  }
});

// Facet: countries present in the cached list (for the filter dropdown).
radioRouter.get('/radios/countries', async (_req, res) => {
  try {
    const list = await loadStations();
    const byCode = new Map();
    for (const s of list) {
      if (!s.countryCode) continue;
      const e = byCode.get(s.countryCode) || { code: s.countryCode, name: s.country || s.countryCode, count: 0 };
      e.count++;
      byCode.set(s.countryCode, e);
    }
    res.json({ countries: [...byCode.values()].sort((a, b) => b.count - a.count) });
  } catch {
    res.status(503).json({ countries: [] });
  }
});
