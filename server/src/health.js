import { Router } from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeFetch } from './netguard.js';
import { rateLimit } from './ratelimit.js';
import { config } from './config.js';
import { getSweepTargets, isKnownStreamUrl, clearSelectCache } from './catalog.js';

const checkLimit = rateLimit({ windowMs: 60_000, max: 120, name: 'check' });

// Stream reachability so the UI shows real LIVE/OFFLINE badges, can filter dead
// channels, and surfaces working ones first. Results are cached (in memory +
// persisted to disk) and refreshed by an opt-in gentle background sweep.

const cache = new Map(); // url -> { online, status, ms, checkedAt }
const TTL_MS = 5 * 60 * 1000;        // on-demand re-check window
const SWEEP_TTL = config.healthSweepIntervalMs;
const TIMEOUT_MS = 6000;
const HEALTH_FILE = join(config.cacheDir, 'health.json');

const firstUri = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

async function fetchText(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { method: 'GET', headers, signal: ctrl.signal }, { allowPrivate: config.allowPrivateSources });
    const text = res.ok ? await res.text().catch(() => '') : '';
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } }
    return { ok: res.ok, status: res.status, text, finalUrl: res.finalUrl || url };
  } finally {
    clearTimeout(timer);
  }
}

// SHALLOW: is the manifest/stream reachable? (fast, one ranged GET)
async function shallowProbe(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-2047' }, signal: ctrl.signal }, { allowPrivate: config.allowPrivateSources });
    let online = res.ok || res.status === 206;
    const ct = res.headers.get('content-type') || '';
    if (online && /\.m3u8(\?|$)/i.test(url) && !/mpegurl/i.test(ct)) {
      const text = await res.text().catch(() => '');
      online = text.includes('#EXTM3U');
    } else {
      try { await res.body?.cancel(); } catch { /* */ }
    }
    return { online, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// DEEP: does a real video SEGMENT actually download? (manifest -> variant -> segment)
// This is what determines whether a channel truly plays, vs just having a 200 manifest.
async function deepProbe(url, headers) {
  const m = await fetchText(url, headers);
  if (!m.ok) return { online: false, status: m.status };
  if (!m.text.includes('#EXTM3U')) return { online: true, status: m.status }; // progressive/other: reachable = ok
  let mediaText = m.text, mediaUrl = m.finalUrl;
  if (/#EXT-X-STREAM-INF/i.test(m.text)) {
    const v = firstUri(m.text);
    if (!v) return { online: false, status: 'empty-master' };
    const variant = await fetchText(new URL(v, m.finalUrl).toString(), headers);
    if (!variant.ok || !variant.text.includes('#EXTM3U')) return { online: false, status: 'variant ' + variant.status };
    mediaText = variant.text; mediaUrl = variant.finalUrl;
  }
  const seg = firstUri(mediaText);
  if (!seg) return { online: false, status: 'empty-media' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await safeFetch(new URL(seg, mediaUrl).toString(), { method: 'GET', headers: { ...headers, Range: 'bytes=0-4095' }, signal: ctrl.signal }, { allowPrivate: config.allowPrivateSources });
    const ok = r.ok || r.status === 206;
    let bytes = 0;
    if (ok) { const b = await r.arrayBuffer().catch(() => null); bytes = b ? b.byteLength : 0; }
    else { try { await r.body?.cancel(); } catch { /* */ } }
    return { online: ok && bytes > 100, status: r.status };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url, ua, ref, deep = false) {
  const headers = { 'User-Agent': ua || 'Mozilla/5.0 (NEOWATCH)' };
  if (ref) headers['Referer'] = ref;
  const t0 = performance.now();
  try {
    const r = deep ? await deepProbe(url, headers) : await shallowProbe(url, headers);
    return { online: r.online, status: r.status, ms: Math.round(performance.now() - t0), checkedAt: Date.now(), deep };
  } catch (e) {
    return { online: false, status: String(e?.name === 'AbortError' ? 'timeout' : 'error'), ms: Math.round(performance.now() - t0), checkedAt: Date.now(), deep };
  }
}

async function checkOne({ url, ua, ref }, force = false, deep = false) {
  if (!url) return { online: false, status: 'no-url', ms: 0, checkedAt: Date.now() };
  const cached = cache.get(url);
  // Reuse fresh cache; never let a shallow re-check overwrite a fresh deep verdict.
  if (!force && cached && Date.now() - cached.checkedAt < TTL_MS && (cached.deep || !deep)) return cached;
  const result = await probe(url, ua, ref, deep);
  cache.set(url, result);
  return result;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Lookups used by the catalog (sort online-first, expose `online`) ──
export function getHealth(url) {
  return cache.get(url) || null;
}
export function isOnline(url) {
  return cache.get(url)?.online === true;
}
export function healthStats() {
  let online = 0, offline = 0;
  for (const v of cache.values()) v.online ? online++ : offline++;
  return { checked: cache.size, online, offline };
}

// ── Persistence ────────────────────────────────────────────────
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(config.cacheDir, { recursive: true }).catch(() => {});
      const tmp = `${HEALTH_FILE}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify([...cache.entries()]));
      await rename(tmp, HEALTH_FILE);
    } catch { /* ignore */ }
  }, 5000);
}

// ── Gentle background sweep ─────────────────────────────────────
const SWEEP_BATCH = config.sweepBatch;
const SWEEP_CONCURRENCY = config.sweepConcurrency;
const SWEEP_PAUSE_MS = 1200;
// Pause between batches with jitter to avoid a synchronized outbound burst.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sweepPause = () => sleep(SWEEP_PAUSE_MS + Math.floor(Math.random() * 400) - 200);
let sweeping = false;

export async function runSweep(force = false, deep = false) {
  if (sweeping) return { started: false, reason: 'already running' };
  sweeping = true;
  let probed = 0;
  (async () => {
    try {
      // Probe priority (lower = sooner). On a DEEP pass, a fresh-but-shallow entry
      // (priority 2) is re-probed so its manifest-only "online" gets upgraded to a
      // real segment-download verdict -- this is what catches streams that badge
      // green but never actually play.
      const priority = (t) => {
        const c = cache.get(t.url);
        if (!c) return 0;                                   // never checked -> first
        if (Date.now() - c.checkedAt > SWEEP_TTL) return 1; // stale -> next
        if (deep && !c.deep) return 2;                      // shallow-only, deep pass upgrades it
        return 3;                                           // fresh + deep-enough -> skip
      };
      const targets = getSweepTargets().sort((a, b) => priority(a) - priority(b));
      for (let i = 0; i < targets.length; i += SWEEP_BATCH) {
        const batch = targets.slice(i, i + SWEEP_BATCH).filter((t) => force || priority(t) < 3);
        if (!batch.length) continue; // nothing needs probing in this batch -> no pause
        await mapLimit(batch, SWEEP_CONCURRENCY, (t) => checkOne(t, force, deep));
        probed += batch.length;
        scheduleSave();
        // Invalidate cached selections so channels this batch just flipped
        // online/offline reorder/filter immediately (the smart sort + hideOffline
        // read live health). Without this the 60s _selCache served stale verdicts.
        clearSelectCache();
        await sweepPause();
      }
      console.log(`[health] ${deep ? 'deep' : 'shallow'} sweep pass complete (${probed} probed, ${cache.size} cached)`);
    } finally {
      sweeping = false;
    }
  })();
  return { started: true };
}

export async function initHealth() {
  try {
    const data = JSON.parse(await readFile(HEALTH_FILE, 'utf8'));
    for (const [url, result] of data) cache.set(url, result);
    console.log(`[health] loaded ${cache.size} cached results`);
  } catch { /* none yet */ }
  if (config.healthSweep) {
    // Boot: a quick SHALLOW pass fills the "online" badge across all channels fast.
    // Then periodic DEEP passes (real segment download) upgrade those verdicts so a
    // stream that serves a 200 manifest but never streams gets correctly marked
    // offline -- the difference between "looks online" and "actually plays".
    runSweep(false, false);
    setInterval(() => runSweep(false, true), config.healthSweepIntervalMs);
  }
}

// ── Routes ─────────────────────────────────────────────────────
export const healthRouter = Router();

healthRouter.post('/catalog/check', checkLimit, async (req, res) => {
  try {
    const { items, force } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    // Only probe well-formed items whose URL is a real catalog stream. This stops a
    // null/undefined item from crashing the worker (hang) and prevents the endpoint
    // from being used as an arbitrary-URL request emitter / port scanner.
    const batch = items
      .filter((it) => it && typeof it === 'object' && isKnownStreamUrl(it.url))
      .slice(0, 40);
    const results = await mapLimit(batch, 8, async (it) => ({ id: it.id, ...(await checkOne(it, !!force)) }));
    scheduleSave();
    res.json({ results });
  } catch {
    res.status(500).json({ error: 'check failed' });
  }
});

export const healthAdminRouter = Router();
healthAdminRouter.post('/health/sweep', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const deep = req.query.deep === '1' || req.query.deep === 'true'; // opt-in real-play audit (heavier)
  const r = await runSweep(force, deep);
  res.json({ ...r, ...healthStats() });
});
healthAdminRouter.get('/health/stats', (_req, res) => res.json(healthStats()));
