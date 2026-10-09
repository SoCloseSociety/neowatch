import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { stableId, hash32, classifyKind, writeFileAtomic } from './util.js';
import { proxyLink } from './signing.js';
import { getHealth, isOnline } from './health.js';

// iptv-org datasets we consume. https://iptv-org.github.io/api/
const DATASETS = ['channels', 'streams', 'categories', 'countries', 'languages', 'logos', 'feeds'];

// Accent/diacritic-insensitive, lowercased normalization for search
// ("tele" matches "Télé", "espana" matches "España").
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// In-memory catalog (built once, refreshed on TTL).
let state = {
  builtAt: 0,
  items: [],        // normalized playable channels (iptv-org + custom)
  categories: [],   // { id, name, count }
  countries: [],    // { code, name, flag, count }
  languages: [],    // { code, name, count }
  total: 0,
};
let baseItems = [];           // iptv-org items only
let customItems = [];         // items parsed from user M3U sources
let lookups = { catById: new Map(), countryByCode: new Map(), langByCode: new Map() };
let premiumUrls = new Set();  // stream URLs that require a premium plan
let channelIdIndex = new Map(); // normalized EPG tvg-id -> channel (O(1) lookup for programme search)
// Every stream URL in the catalog (guards the public health-check endpoint) -> the
// catalog's own headers + origin for it (probes and the proxy never take a client's).
let knownUrls = new Map();      // url -> { userAgent, referrer, source }
// Every logo URL the catalog vends (guards the /api/img relay: it fetches nothing else)
// -> { custom }: a custom (M3U) source's logo may live on the operator's LAN.
let knownLogos = new Map();     // logo url -> { custom: boolean }
let byId = new Map();           // primary id -> item (first in compose order wins a djb2 collision)
let altIdIndex = new Map();     // stableId(alternate url) -> item: an id whose URL became an alternate still resolves
let lastCollisionSig = '';      // logged once per distinct collision set, not on every compose
// EPG ids carry a @feed suffix and vary in case: index + look up on the bare lowercased id.
const normCid = (cid) => String(cid).split('@')[0].trim().toLowerCase();
let buildPromise = null;

// Refresh bookkeeping. The TTL clock is the age of the iptv-org DATA (oldest dataset
// timestamp), never state.builtAt: compose() runs on every blocklist/custom edit and
// must not postpone the base refresh.
let baseBuiltAt = 0;   // when the iptv-org base was last (re)built in memory
let baseDataAt = 0;    // oldest dataset timestamp behind the base in memory
let lastFailAt = 0;    // last failed (or degraded: served from a stale disk cache) build
let lastError = null;
const FETCH_TIMEOUT_MS = 30_000;     // per dataset, headers + body
const RETRY_MS = 10 * 60_000;        // warm: keep serving, retry the refresh every 10 min
const COLD_RETRY_MS = 30_000;        // cold (nothing to serve): retry sooner

// ── Takedown blocklist ─────────────────────────────────────────
// Operator-controlled list of stream URLs to hide instantly (e.g. a rights-holder
// retraction request). Filtered out of the catalog entirely, before facets +
// projection, so a blocked channel disappears everywhere (grid, home, search,
// random, EPG, proxy targets). This is the aggregator's core protection.
let blocklist = new Set();
const BLOCKLIST_FILE = join(config.dataDir, 'blocklist.json');
const BLOCK_URL_MAX = 4096;

export async function loadBlocklist() {
  let raw;
  try {
    raw = await readFile(BLOCKLIST_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[blocklist] cannot read ${BLOCKLIST_FILE}: ${err.message}`);
    return;
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('not a JSON array');
    blocklist = new Set(data.filter((u) => typeof u === 'string'));
  } catch (err) {
    // Never start silently empty: that would re-publish every takedown. Keep a copy,
    // salvage every quoted string we can still read, and say it loudly.
    const bak = `${BLOCKLIST_FILE}.corrupt-${Date.now()}.bak`;
    await copyFile(BLOCKLIST_FILE, bak).catch(() => {});
    const salvaged = [];
    for (const m of raw.match(/"(?:[^"\\]|\\.)*"/g) || []) {
      try { const u = JSON.parse(m); if (typeof u === 'string' && u) salvaged.push(u); } catch { /* skip */ }
    }
    blocklist = new Set(salvaged);
    console.error(`\n  [blocklist] CORRUPT ${BLOCKLIST_FILE} (${err.message}). Copy kept at ${bak}; salvaged ${salvaged.length} URL(s). Check the takedown list in the admin panel.\n`);
  }
}
// Serialized + atomic: two admin edits never interleave, a crash never truncates the
// file, and a failed write reaches the caller (the admin route answers 500).
let blockChain = Promise.resolve();
function saveBlocklist() {
  const run = blockChain.then(() => writeFileAtomic(BLOCKLIST_FILE, JSON.stringify([...blocklist])));
  blockChain = run.catch(() => {});
  return run;
}
function saveFailed(err) {
  console.error(`[blocklist] SAVE FAILED: ${err?.message || err}`);
  const e = new Error('blocklist not saved');
  e.status = 500;
  return e;
}
export function getBlocklist() { return [...blocklist]; }
// Used by the stream proxy too: a signed URL vended before a takedown must not play.
export function isBlocked(url) {
  return typeof url === 'string' && blocklist.has(url);
}
export async function addToBlocklist(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  let added = 0;
  for (const u of list) {
    const v = typeof u === 'string' ? u.trim() : '';
    if (v && v.length <= BLOCK_URL_MAX && !blocklist.has(v)) { blocklist.add(v); added++; }
  }
  if (!added) return { added, total: blocklist.size };
  compose(); // the takedown applies now, even if persisting it fails below
  try { await saveBlocklist(); } catch (err) { throw saveFailed(err); }
  return { added, total: blocklist.size };
}
export async function removeFromBlocklist(url) {
  const ok = blocklist.delete(url);
  if (!ok) return { removed: false, total: blocklist.size };
  try {
    await saveBlocklist();
  } catch (err) {
    blocklist.add(url); // not persisted -> keep it blocked (fail safe for a takedown)
    throw saveFailed(err);
  }
  compose();
  return { removed: true, total: blocklist.size };
}

// ── Id aliases ─────────────────────────────────────────────────
// The id formula (djb2 of the primary URL) is frozen, but iptv-org rotates and reorders
// feeds, so a saved id (Sentinel pin, /chaine/<id> link, recents) can lose its URL. Every
// vended id is remembered with its tvg-id; a miss resolves through it to the channel's
// current card. Bounded; live ids are never evicted (they resolve directly anyway).
const ALIAS_FILE = join(config.dataDir, 'id-aliases.json');
const ALIAS_CAP = 50_000;
const ID_RE = /^[0-9a-z]{1,13}$/;
let idAliases = new Map(); // id -> channelId (insertion order = age, for eviction)
let aliasesLoaded = false;
let aliasTimer = null;
let aliasChain = Promise.resolve();

export async function loadIdAliases() {
  try {
    const data = JSON.parse(await readFile(ALIAS_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [id, cid] of Object.entries(data)) if (ID_RE.test(id) && typeof cid === 'string' && cid) idAliases.set(id, cid);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[catalog] ${ALIAS_FILE} unreadable (${err.message}): starting a fresh id alias table`);
  }
  aliasesLoaded = true;
  if (state.items.length) recordAliases(state.items); // a compose that ran before the load
}
function recordAliases(items) {
  if (!aliasesLoaded) return; // never overwrite the file before it was read
  let changed = false;
  for (const it of items) {
    if (!it.channelId || idAliases.get(it.id) === it.channelId) continue;
    idAliases.delete(it.id); // re-insert = newest
    idAliases.set(it.id, it.channelId);
    changed = true;
  }
  if (!changed) return;
  if (idAliases.size > ALIAS_CAP) {
    for (const id of idAliases.keys()) {
      if (idAliases.size <= ALIAS_CAP) break;
      if (!byId.has(id)) idAliases.delete(id);
    }
  }
  if (!aliasTimer) aliasTimer = setTimeout(() => { aliasTimer = null; saveIdAliases(); }, 5000);
}
function saveIdAliases() {
  const run = aliasChain.then(() => writeFileAtomic(ALIAS_FILE, JSON.stringify(Object.fromEntries(idAliases))));
  aliasChain = run.catch((err) => console.error(`[catalog] id alias save failed: ${err.message}`));
  return aliasChain;
}
// Shutdown hook: write a pending (debounced) alias save now.
export function flushIdAliases() {
  if (!aliasTimer) return aliasChain;
  clearTimeout(aliasTimer);
  aliasTimer = null;
  return saveIdAliases();
}

// LEGAL SAFETY: publicly-listed third-party channels are NEVER gated by content
// category. Every iptv-org channel is free to watch for everyone -- Premium sells
// FEATURES (no ads, extended multi-screen, EPG, sync, your own playlists), not
// access to third-party content. Only an operator's OWN imported M3U playlists
// can be a paid feature (their curation, their call), and only if CUSTOM_PREMIUM
// is on. `premiumCategories` is intentionally ignored for locking.
function isPremiumItem(it) {
  return config.customIsPremium && it.source === 'custom';
}

async function fetchJson(name) {
  const url = `${config.apiBase}/${name}.json`;
  // A hanging iptv-org must not hold the build (and every request waiting on it) for
  // undici's 300s defaults: the timeout covers the headers AND the body download.
  const res = await fetch(url, { headers: { 'User-Agent': 'NEOWATCH/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${name}: not an array`);
  return data;
}

// Fresh disk cache first, then network (persisted atomically). When the network fails,
// `allowStale` serves the stale disk copy instead of failing: used when there is
// nothing in memory yet (boot), so an iptv-org outage never turns a usable cache into 503.
async function loadDataset(name, allowStale) {
  const file = join(config.cacheDir, `${name}.json`);
  let cached = null;
  try {
    const { ts, data } = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(data) && Number.isFinite(ts)) cached = { ts, data };
  } catch {
    /* no/invalid cache */
  }
  if (cached && Date.now() - cached.ts < config.catalogTtlMs) return { ...cached, stale: false };
  try {
    const data = await fetchJson(name);
    const ts = Date.now();
    await writeFileAtomic(file, JSON.stringify({ ts, data })).catch((err) => console.warn(`[catalog] cache write ${name}: ${err.message}`));
    return { ts, data, stale: false };
  } catch (err) {
    if (!allowStale || !cached) throw err;
    console.warn(`[catalog] ${name}: ${err.message} -- serving the stale disk cache (${Math.round((Date.now() - cached.ts) / 3600000)}h old)`);
    return { ...cached, stale: true };
  }
}

function pickLogo(list) {
  if (!list || !list.length) return undefined;
  // Prefer in-use, then square-ish reasonable size, then anything.
  const sorted = [...list].sort((a, b) => {
    if (!!b.in_use !== !!a.in_use) return b.in_use ? 1 : -1;
    const av = (a.width || 0) * (a.height || 0);
    const bv = (b.width || 0) * (b.height || 0);
    return bv - av;
  });
  return sorted[0]?.url;
}

function buildBaseItems(data) {
  const { channels, streams, categories, countries, languages, logos, feeds } = data;

  const chById = new Map(channels.map((c) => [c.id, c]));
  const catById = new Map(categories.map((c) => [c.id, c]));
  const countryByCode = new Map(countries.map((c) => [c.code, c]));
  const langByCode = new Map(languages.map((l) => [l.code, l.name]));
  lookups = { catById, countryByCode, langByCode };

  const logosByCh = new Map();
  for (const lg of logos) {
    if (!lg.channel || !lg.url) continue;
    if (!logosByCh.has(lg.channel)) logosByCh.set(lg.channel, []);
    logosByCh.get(lg.channel).push(lg);
  }

  const langsByCh = new Map();
  for (const f of feeds) {
    if (!f.channel || !f.languages?.length) continue;
    if (f.is_main || !langsByCh.has(f.channel)) langsByCh.set(f.channel, f.languages);
  }

  // Group every stream URL by channel so a dead feed can fall back to another.
  const feedsByCh = new Map();
  for (const s of streams) {
    if (!s.url || !s.channel) continue;
    if (!feedsByCh.has(s.channel)) feedsByCh.set(s.channel, []);
    feedsByCh.get(s.channel).push({ url: s.url, userAgent: s.user_agent || null, referrer: s.referrer || null });
  }

  const items = [];
  const seenUrl = new Set();
  const seenChannel = new Set(); // one card per channel; extra feeds become alts

  streams.forEach((s) => {
    if (!s.url || seenUrl.has(s.url)) return;
    seenUrl.add(s.url);

    const ch = s.channel ? chById.get(s.channel) : null;
    if (ch?.closed) return;
    // DASH (.mpd) can't be played by our HLS engine -> don't present it.
    if (classifyKind(s.url) === 'dash') return;

    const cats = ch?.categories?.length ? ch.categories : ['undefined'];
    const isNsfw = !!ch?.is_nsfw || cats.includes('xxx');
    if (config.hideNsfw && isNsfw) return;

    // Collapse multiple streams of the SAME channel into one card (the first
    // playable feed). The others are kept as `alts` for automatic fallback.
    if (s.channel) {
      if (seenChannel.has(s.channel)) return;
      seenChannel.add(s.channel);
    }

    const countryCode = ch?.country || null;
    const country = countryCode ? countryByCode.get(countryCode) : null;
    const langCodes = langsByCh.get(s.channel) || country?.languages || [];

    items.push({
      id: stableId(s.url),
      channelId: s.channel || null,
      name: ch?.name || s.title || 'Unknown channel',
      url: s.url,
      kind: classifyKind(s.url),
      quality: s.quality || null,
      label: s.label || null,
      userAgent: s.user_agent || null,
      referrer: s.referrer || null,
      logo: ch ? pickLogo(logosByCh.get(ch.id)) : undefined,
      categories: cats,
      categoryNames: cats.map((c) => catById.get(c)?.name || c),
      country: countryCode,
      countryName: country?.name || null,
      flag: country?.flag || null,
      languages: langCodes,
      languageNames: langCodes.map((c) => langByCode.get(c) || c),
      website: ch?.website || null,
      nsfw: isNsfw,
      source: 'iptv-org',
      // Precomputed accent-insensitive search blob (name + country + categories).
      _search: norm(`${ch?.name || s.title || ''} ${country?.name || ''} ${cats.map((c) => catById.get(c)?.name || c).join(' ')}`),
      // Other feeds of the same channel (for auto-fallback on failure). Exclude
      // youtube + dash (.mpd) -- the hls.js player can't play those as a fallback.
      alts: s.channel ? (feedsByCh.get(s.channel) || []).filter((f) => f.url !== s.url && classifyKind(f.url) !== 'youtube' && classifyKind(f.url) !== 'dash').slice(0, 4) : [],
    });
  });

  return items;
}

function categoryName(id) {
  if (id === 'undefined') return 'Uncategorized';
  if (id === 'custom') return 'Mes sources (M3U)';
  return lookups.catById.get(id)?.name || id;
}

// Merge base (iptv-org) + custom (user M3U) items, then (re)build facets + state.
function compose() {
  _selCache.clear(); // invalidate query cache on every rebuild
  let items = customItems.length ? [...customItems, ...baseItems] : baseItems;
  // Dedup by URL across base+custom (custom listed first, so it wins on collision).
  if (customItems.length) {
    const seen = new Set();
    items = items.filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)));
  }
  // Drop any operator-blocklisted stream (takedown / rights-holder retraction): the
  // card when its primary is blocked, and a blocked alternate from every other card
  // (else it would still be signed, promoted by liveAlt and probed). Copies only:
  // baseItems/customItems stay intact so an unblock restores the feed.
  if (blocklist.size) {
    items = items
      .filter((it) => !blocklist.has(it.url))
      .map((it) => (it.alts?.some((a) => blocklist.has(a.url)) ? { ...it, alts: it.alts.filter((a) => !blocklist.has(a.url)) } : it));
  }

  const catCount = new Map();
  const countryCount = new Map();
  const langCount = new Map();
  premiumUrls = new Set();
  let premiumCount = 0;
  for (const it of items) {
    it.tier = isPremiumItem(it) ? 'premium' : 'free';
    if (it.tier === 'premium') {
      premiumUrls.add(it.url);
      premiumCount++;
    }
    for (const c of it.categories) catCount.set(c, (catCount.get(c) || 0) + 1);
    if (it.country) countryCount.set(it.country, (countryCount.get(it.country) || 0) + 1);
    for (const l of it.languages) langCount.set(l, (langCount.get(l) || 0) + 1);
  }

  const categories = [...catCount.entries()]
    .map(([id, count]) => ({ id, name: categoryName(id), count }))
    .sort((a, b) => b.count - a.count);

  const countries = [...countryCount.entries()]
    .map(([code, count]) => {
      const c = lookups.countryByCode.get(code);
      return { code, name: c?.name || code, flag: c?.flag || '🏳️', count };
    })
    .sort((a, b) => b.count - a.count);

  const languages = [...langCount.entries()]
    .map(([code, count]) => ({ code, name: lookups.langByCode.get(code) || code, count }))
    .sort((a, b) => b.count - a.count);

  state = {
    // Strictly monotonic: back-to-back composes (base build + custom-source merge)
    // can land in the same millisecond, which would let the home cache (keyed on
    // builtAt) pin a stale base-only payload. +1 guarantees a fresh cache key.
    builtAt: Math.max(Date.now(), state.builtAt + 1),
    items,
    categories,
    countries,
    languages,
    total: items.length,
    premiumCount,
    freeCount: items.length - premiumCount,
  };
  // O(1) channelId lookup for EPG programme search. Ids normalized (strip @feed
  // suffix + lowercase) to match grabber ids like "Arte.fr@SD" against "arte.fr".
  channelIdIndex = new Map();
  knownUrls = new Map();
  knownLogos = new Map();
  byId = new Map();
  const collisions = [];
  for (const it of items) {
    // A primary's own headers win over the same URL listed as another card's alternate.
    if (it.url) knownUrls.set(it.url, { userAgent: it.userAgent || null, referrer: it.referrer || null, source: it.source });
    for (const a of it.alts || []) {
      if (a?.url && !knownUrls.has(a.url)) knownUrls.set(a.url, { userAgent: a.userAgent || null, referrer: a.referrer || null, source: it.source });
    }
    // First listing wins (custom sources are composed first, like knownUrls).
    if (typeof it.logo === 'string' && /^https?:\/\//i.test(it.logo) && !knownLogos.has(it.logo)) {
      knownLogos.set(it.logo, { custom: it.source === 'custom' });
    }
    const prev = byId.get(it.id);
    if (!prev) byId.set(it.id, it);
    else {
      // The loser of a djb2 collision was unreachable by id: give it a second hash of
      // its URL (FNV-1a, same lowercase-and-digits shape), derived, so it is stable.
      const alt = hash32(it.url).toString(36);
      if (alt !== it.id && !byId.has(alt)) {
        collisions.push(`${it.id}: "${prev.name}" keeps it, "${it.name}" -> ${alt}`);
        it.id = alt;
        byId.set(alt, it);
      } else collisions.push(`${it.id}: "${prev.name}" keeps it, "${it.name}" unreachable by id`);
    }
    if (!it.channelId) continue;
    const key = normCid(it.channelId);
    if (!channelIdIndex.has(key)) channelIdIndex.set(key, it);
  }
  // Second pass so a primary id always wins over an alternate's id.
  altIdIndex = new Map();
  for (const it of items) {
    for (const a of it.alts || []) {
      const aid = a?.url ? stableId(a.url) : null;
      if (aid && !byId.has(aid) && !altIdIndex.has(aid)) altIdIndex.set(aid, it);
    }
  }
  const sig = collisions.join('|');
  if (sig !== lastCollisionSig) {
    lastCollisionSig = sig;
    if (collisions.length) console.warn(`[catalog] ${collisions.length} djb2 id collision(s): ${collisions.slice(0, 5).join('; ')}${collisions.length > 5 ? '; ...' : ''}`);
  }
  recordAliases(items);
}

// Is this a stream URL that exists in the catalog? Used to keep the public health
// /catalog/check endpoint from being turned into an arbitrary-URL request emitter.
export function isKnownStreamUrl(url) {
  return typeof url === 'string' && knownUrls.has(url);
}
// -> { userAgent, referrer, source } for any primary or alternate URL, or null (O(1)).
export function getStreamMeta(url) {
  return (typeof url === 'string' && knownUrls.get(url)) || null;
}

// Is this a logo URL the catalog vends? The image relay (/api/img) fetches only these,
// so it can never be turned into an arbitrary-URL fetcher. O(1).
export function isKnownLogoUrl(url) {
  return typeof url === 'string' && knownLogos.has(url);
}
// -> { custom } for a vended logo URL, or null.
export function getLogoMeta(url) {
  return (typeof url === 'string' && knownLogos.get(url)) || null;
}

async function build(allowStale) {
  // allSettled: every dataset that does download is cached, even when another fails,
  // so the next attempt only refetches what is still missing.
  const settled = await Promise.allSettled(DATASETS.map((name) => loadDataset(name, allowStale)));
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  const loaded = {};
  let oldest = Infinity, stale = false;
  DATASETS.forEach((name, i) => {
    const v = settled[i].value;
    loaded[name] = v.data;
    oldest = Math.min(oldest, v.ts);
    stale ||= v.stale;
  });
  baseItems = buildBaseItems(loaded);
  baseBuiltAt = Date.now();
  baseDataAt = oldest;
  // A build served from a stale disk copy is degraded: retry the network on the
  // warm backoff instead of waiting a full TTL.
  if (stale) { lastFailAt = Date.now(); lastError = 'iptv-org unreachable, serving the disk cache'; }
  else { lastFailAt = 0; lastError = null; }
  compose();
  const age = Math.round((Date.now() - baseDataAt) / 60000);
  console.log(`[catalog] built ${state.total} channels (${baseItems.length} iptv-org + ${customItems.length} custom) across ${state.categories.length} categories, ${state.countries.length} countries (data ${age} min old${stale ? ', STALE' : ''})`);
  return state;
}

function startBuild() {
  // Nothing in memory yet -> a stale disk copy beats an empty catalog. Warm -> memory
  // already holds that data (or newer), so only a real download counts.
  buildPromise = build(!baseItems.length)
    .catch((err) => {
      lastFailAt = Date.now();
      lastError = String(err?.message || err);
      throw err;
    })
    .finally(() => { buildPromise = null; });
  return buildPromise;
}

// Stale-while-revalidate: once a base exists, callers get the current state at once and
// a due refresh runs in the background (a failure keeps the old state, retried every
// RETRY_MS). Only a cold start (or an admin force) waits for the build.
export async function ensureCatalog(force = false) {
  if (buildPromise) return !force && baseItems.length ? state : buildPromise;
  if (force) return startBuild();
  if (baseItems.length) {
    const now = Date.now();
    if (now - baseDataAt >= config.catalogTtlMs && now - lastFailAt >= RETRY_MS) {
      startBuild().catch((err) => console.error(`[catalog] background refresh failed: ${err?.message || err} -- keeping the current catalog, retry in ${RETRY_MS / 60000} min`));
    }
    return state;
  }
  if (lastFailAt && Date.now() - lastFailAt < COLD_RETRY_MS) throw new Error(lastError || 'catalog unavailable');
  return startBuild();
}

// Honest catalog status for /api/health (age = age of the iptv-org data, not of the
// last in-memory compose).
export function catalogStatus() {
  const now = Date.now();
  return {
    total: state.total,
    base: baseItems.length,
    custom: customItems.length,
    updatedAt: state.builtAt || null,
    builtAt: baseBuiltAt || null,
    dataAt: baseDataAt || null,
    ageMs: baseDataAt ? now - baseDataAt : null,
    building: !!buildPromise,
    stale: !!baseDataAt && now - baseDataAt >= config.catalogTtlMs,
    lastError,
    lastFailAt: lastFailAt || null,
  };
}

// Called by the sources module whenever custom M3U items change.
export function setCustomItems(items) {
  customItems = Array.isArray(items) ? items : [];
  // If a base (iptv-org) rebuild is in flight, recompose after it finishes so a
  // concurrent build can't clobber the custom merge; otherwise compose now.
  // Always compose (even with empty baseItems) so custom channels appear even
  // when the base catalog failed to build. (catch first: a failed build must not
  // become an unhandled rejection here.)
  if (buildPromise) buildPromise.catch(() => {}).then(() => compose());
  else compose();
}

export function getMeta() {
  // Count channels (not raw URLs -- the health cache also holds alternates) whose
  // primary or a known alternate is confirmed alive: the truthful "X online".
  let online = 0;
  for (const it of state.items) if (effectiveOnline(it)) online++;
  return {
    total: state.total,
    online,
    updatedAt: state.builtAt,
    customCount: customItems.length,
    premiumCount: state.premiumCount || 0,
    freeCount: state.freeCount || 0,
    categories: state.categories,
    countries: state.countries,
    languages: state.languages,
  };
}

// Football/soccer detection for the "⚽ Foot" quick filter.
const FOOT_RE = /\b(foot|football|soccer|futbol|fútbol|fussball|calcio|bein|espn|premier|liga|ligue|serie a|bundesliga|champions|uefa|fifa|matchday|sport ?[0-9]?)\b/i;

// Audience is primarily European: rank European channels higher everywhere
// (home category rails, grid, search) so the catalog feels local-first.
const EU_COUNTRIES = new Set([
  'FR', 'UK', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'IE', 'AT', 'CH', 'LU',
  'SE', 'NO', 'DK', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR',
  'HR', 'SI', 'RS', 'UA', 'EE', 'LV', 'LT',
]);

// When the primary feed is confirmed dead but one of the channel's alternates is
// confirmed alive, return that alternate -- the channel plays instead of erroring.
function liveAlt(it) {
  if (getHealth(it.url)?.online !== false) return null; // primary fine/unknown -> keep it
  return (it.alts || []).find((a) => getHealth(a.url)?.online === true) || null;
}

// A channel is effectively online if its primary OR any known alternate is alive.
function effectiveOnline(it) {
  return isOnline(it.url) || (getHealth(it.url)?.online === false && (it.alts || []).some((a) => isOnline(a.url)));
}

// Hide the playable URL of premium channels from non-premium users (paywall),
// and attach a signed proxy URL for the ones the user IS allowed to play.
function project(it, premiumOk) {
  const swap = liveAlt(it);
  if (it.tier === 'premium' && !premiumOk) {
    const { alts, _search, ...rest } = it;
    const lh = getHealth(swap ? swap.url : it.url);
    // Keep online/latency so locked cards still show a LIVE badge (URL stays hidden).
    return { ...rest, url: null, userAgent: null, referrer: null, proxyUrl: null, alternates: [], locked: true, online: lh ? lh.online : null, latency: lh?.ms ?? null, checkedAt: lh?.checkedAt ?? null };
  }
  // Live-alternate promotion: present the working feed as the playable URL; the
  // dead primary is demoted into `alternates` (still tried on failure).
  const url = swap ? swap.url : it.url;
  const ua = swap ? swap.userAgent : it.userAgent;
  const ref = swap ? swap.referrer : it.referrer;
  const kind = swap ? classifyKind(url) : it.kind;
  const proxyUrl = kind === 'youtube' ? null : proxyLink(url, { ua, ref });
  // Sign each alternate feed so the player can fall back when the primary dies.
  const altsSrc = swap
    ? [{ url: it.url, userAgent: it.userAgent, referrer: it.referrer }, ...(it.alts || []).filter((a) => a.url !== swap.url)]
    : (it.alts || []);
  const alternates = altsSrc.map((a) => ({
    url: a.url,
    proxyUrl: proxyLink(a.url, { ua: a.userAgent, ref: a.referrer }),
    userAgent: a.userAgent,
    referrer: a.referrer,
  }));
  const { alts, _search, ...rest } = it;
  // Server-known reachability (from on-demand checks + the background sweep).
  const h = getHealth(url);
  return { ...rest, url, userAgent: ua, referrer: ref, kind, locked: false, proxyUrl, alternates, online: h ? h.online : null, latency: h?.ms ?? null, checkedAt: h?.checkedAt ?? null };
}

// Unique, non-youtube playable targets for the background health sweep.
export function getSweepTargets() {
  const seen = new Set();
  const out = [];
  for (const it of state.items) {
    if (!it.url || it.kind === 'youtube' || seen.has(it.url)) continue;
    seen.add(it.url);
    out.push({ url: it.url, ua: it.userAgent, ref: it.referrer });
    // A dead primary makes its alternates worth probing: a confirmed-live one is
    // promoted to the playable URL at projection time (liveAlt/project) -- this is
    // how a "dead" channel with a working second feed comes back to life.
    if (getHealth(it.url)?.online === false) {
      for (const a of it.alts || []) {
        if (!a?.url || seen.has(a.url)) continue;
        seen.add(a.url);
        out.push({ url: a.url, ua: a.userAgent, ref: a.referrer });
      }
    }
  }
  return out;
}

export function isPremiumUrl(url) {
  return premiumUrls.has(url);
}

// Audit every channel against the health cache: per-category online/offline/unchecked.
export function auditChannels() {
  const byCategory = {};
  let online = 0, offline = 0, unchecked = 0;
  for (const it of state.items) {
    const h = getHealth(it.url);
    const s = h ? (h.online ? 'online' : 'offline') : 'unchecked';
    if (s === 'online') online++; else if (s === 'offline') offline++; else unchecked++;
    const c = it.categories[0] || 'undefined';
    (byCategory[c] ||= { total: 0, online: 0, offline: 0, unchecked: 0 });
    byCategory[c].total++;
    byCategory[c][s]++;
  }
  return { total: state.total, online, offline, unchecked, byCategory };
}

// Short-TTL cache of filter+sort+slice results (raw items). Bounds health
// staleness to 60s while cutting repeated full-catalog scans under load.
// Cleared on every catalog rebuild (compose()).
const _selCache = new Map();
const SEL_TTL_MS = 60_000;
export function clearSelectCache() { _selCache.clear(); }

// Filter + sort + paginate WITHOUT projecting (raw items). Cacheable per build.
export function selectChannels({ category, country, language, q, foot, page = 1, limit = 60, hideOffline = false, sort = 'smart', langBoost = '' } = {}) {
  const key = [category || '', country || '', language || '', q || '', foot ? 1 : 0, page, limit, hideOffline ? 1 : 0, sort, langBoost].join('|');
  const hit = _selCache.get(key);
  if (hit && Date.now() - hit.ts < SEL_TTL_MS) return hit.result;

  let list = state.items;

  if (category) list = list.filter((it) => it.categories.includes(category));
  if (country) list = list.filter((it) => it.country === country);
  if (language) list = list.filter((it) => it.languages.includes(language));
  if (foot) list = list.filter((it) => it.categories.includes('sports') || FOOT_RE.test(it.name));
  // Drop channels the health sweep has confirmed dead (keeps online + unknown).
  // A dead primary with a confirmed-live alternate stays: it plays via promotion.
  if (hideOffline) list = list.filter((it) => getHealth(it.url)?.online !== false || (it.alts || []).some((a) => isOnline(a.url)));
  // Multi-word search: every token must appear somewhere in the haystack (AND),
  // so "bbc news" matches a channel with both words, in any order.
  const needle = q ? norm(q) : '';
  const qTokens = needle ? needle.split(/\s+/).filter(Boolean) : [];
  if (qTokens.length) {
    list = list.filter((it) => {
      const hay = it._search || norm(`${it.name} ${it.countryName || ''} ${it.categoryNames.join(' ')}`);
      return qTokens.every((tk) => hay.includes(tk));
    });
  }

  // Ordering. 'smart' (default): when searching, RELEVANCE-first (best name match),
  // else online-first + Europe-boosted + quality signals. 'name': alphabetical.
  // 'latency': online channels by ascending probe latency.
  if (sort === 'name') {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'latency') {
    const lat = (x) => { const h = getHealth(x.url); return h?.online ? (h.ms ?? 9000) : 1e9; };
    list = [...list].sort((a, b) => lat(a) - lat(b) || a.name.localeCompare(b.name));
  } else {
    const base = (x) =>
      (effectiveOnline(x) ? 8 : 0) +
      (langBoost && x.languages.includes(langBoost) ? 6 : 0) +
      (x.source === 'custom' ? 4 : 0) +
      (EU_COUNTRIES.has(x.country) ? 3 : 0) +
      (x.logo ? 2 : 0) +
      (x.channelId ? 1 : 0);
    if (needle) {
      // Relevance score on the NAME (exact > prefix > substring > all-tokens),
      // dominating `base` (<=24) so the best-named match wins; online/quality
      // break ties within a tier. Computed once per item (not per comparison).
      const rel = (x) => {
        const n = norm(x.name);
        if (n === needle) return 1000;
        if (n.startsWith(needle)) return 600;
        if (n.includes(needle)) return 400;
        if (qTokens.every((tk) => n.includes(tk))) return 240;
        return 0; // matched only via country/category
      };
      list = list
        .map((x) => ({ x, k: rel(x) + base(x) }))
        .sort((a, b) => b.k - a.k || a.x.name.localeCompare(b.x.name))
        .map((o) => o.x);
    } else {
      list = [...list].sort((a, b) => base(b) - base(a) || a.name.localeCompare(b.name));
    }
  }

  const total = list.length;
  const start = (page - 1) * limit;
  const items = list.slice(start, start + limit);
  const result = { total, page, limit, pages: Math.ceil(total / limit), items };
  if (_selCache.size > 300) _selCache.clear();
  _selCache.set(key, { ts: Date.now(), result });
  return result;
}

// Project (lock + sign URLs) for a specific user. Cheap; run per-request so
// signed proxy URLs are always fresh even when the raw selection is cached.
export function projectChannel(it, premiumOk = false) {
  return project(it, premiumOk);
}

export function queryChannels(opts = {}) {
  const r = selectChannels(opts);
  return { ...r, items: r.items.map((it) => project(it, opts.premiumOk || false)) };
}

// Resolve a (possibly old) channel id: exact primary id, then an id whose URL is now
// one of the channel's alternates, then the persisted alias (id -> tvg-id), then the
// caller's own `channelId` hint. `canonicalId` (additive) tells the client the id to keep.
function resolveId(id, channelId) {
  if (typeof id === 'string' && id.length <= 64) {
    const hit = byId.get(id) || altIdIndex.get(id);
    if (hit) return hit;
    const cid = idAliases.get(id);
    if (cid && channelIdIndex.has(normCid(cid))) return channelIdIndex.get(normCid(cid));
  }
  if (typeof channelId === 'string' && channelId && channelId.length <= 200) return channelIdIndex.get(normCid(channelId)) || null;
  return null;
}

export function getChannelById(id, premiumOk = false, { channelId } = {}) {
  const it = resolveId(id, channelId);
  return it ? { ...project(it, premiumOk), canonicalId: it.id } : null;
}

// First catalog channel matching an EPG tvg-id (used to make programme search results playable).
export function getByChannelId(channelId) {
  if (!channelId) return null;
  // EPG ids carry a @feed suffix and vary in case; match on the bare lowercased id (O(1) via index).
  const it = channelIdIndex.get(normCid(channelId));
  return it ? { id: it.id, name: it.name, logo: it.logo, flag: it.flag, tier: it.tier } : null;
}
