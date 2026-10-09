import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, validateConfig, publicConfigAudit } from './config.js';
import {
  ensureCatalog, getMeta, queryChannels, getChannelById, auditChannels, selectChannels, projectChannel,
  loadBlocklist, getBlocklist, addToBlocklist, removeFromBlocklist, loadIdAliases, flushIdAliases, catalogStatus,
} from './catalog.js';
import { hash32 } from './util.js';
import { proxyRouter } from './proxy.js';
import { healthRouter, healthAdminRouter, initHealth, healthStats, flushHealth } from './health.js';
import { sourcesPublicRouter, sourcesAdminRouter, initSources } from './sources.js';
import { epgPublicRouter, epgAdminRouter, initEpg, epgEnabled, hasEpg, epgDay, epgChannelIds } from './epg.js';
import { filmsRouter } from './films.js';
import { radioRouter } from './radio.js';
import { imgRouter } from './img.js';
import { billingPublicRouter, billingUserRouter, billingAdminRouter, stripeWebhookHandler, checkoutAvailable } from './billing.js';
import { rateLimit } from './ratelimit.js';
import {
  initAuth, authenticate, requireAdmin, requireUser, gateContent, isPremium, userFromToken,
  authRouter, adminRouter, prefsRouter, getStats, privateNoStore,
} from './auth.js';

// A streaming proxy hits thousands of flaky CDNs; an upstream socket that drops
// mid-stream can emit an unhandled 'error' event. NEVER let that crash the
// server -- log and keep serving everyone else.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.code || '', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.code || '', reason?.message || reason);
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy); // real client IP for rate limiting behind a reverse proxy
// Baseline security headers (no full CSP -- nginx owns TLS/HSTS, and a strict CSP would
// need careful tuning for AdSense + hls.js). Nothing frames NEOWATCH (the only iframe
// is the YouTube embed INSIDE it), so documents refuse every framer: clickjacking on
// /link?code= would otherwise approve an attacker's TV pairing in one click. This
// covers the Express/Docker path; in prod nginx serves the document (same headers there).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Documents only: the stream proxy sets its own sandbox CSP on relayed bytes.
  if (!req.path.startsWith('/api/')) res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
// Never compress the stream proxy: segments are already compressed media, and an
// aborted compressed response (every channel change) is exactly the leak path.
app.use(compression({ filter: (req, res) => !req.path.startsWith('/api/proxy') && compression.filter(req, res) }));
// Stripe webhook needs the RAW body for signature verification -> mount before json.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);
app.use(express.json({ limit: '256kb' }));
// Keep the API contract JSON even for malformed / oversized bodies (else Express
// returns its default HTML 400 and the web client surfaces a raw HTML blob).
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'invalid request body' });
  }
  next(err);
});
// CORS: only enable for explicitly allow-listed origins. Default = same-origin
// (the SPA is served by this server in prod, and proxied via Vite in dev), so
// no website can call the API / proxy cross-origin unless you opt in.
if (config.allowedOrigins.length) {
  // X-Renewed-Token carries the sliding-session renewal; a cross-origin client must be
  // allowed to read it (same-origin, the prod/TWA case, needs nothing). The middleware
  // runs only for an allow-listed Origin: the cors package would otherwise still emit
  // Access-Control-Expose-Headers (without Allow-Origin) to any origin, and the
  // Vary: Origin stays on every response so a shared cache never mixes the two.
  const corsMw = cors({ origin: config.allowedOrigins, credentials: false, exposedHeaders: ['X-Renewed-Token'] });
  app.use((req, res, next) => {
    res.vary('Origin');
    return config.allowedOrigins.includes(req.headers.origin) ? corsMw(req, res, next) : next();
  });
}
// ── Logo relay ─────────────────────────────────────────────────
// Before authenticate AND every gate: an <img> sends no Authorization, the relay only
// fetches URLs the server itself vends (catalog logos, radio favicons), and its public
// 24 h cache must never carry a renewed session token (img.js).
app.use('/api', imgRouter);

app.use(authenticate); // populates req.user when a token is sent

// ── Stream proxy ───────────────────────────────────────────────
// Access is enforced by the HMAC signature on the URL (only vended to allowed users at
// catalog time), so no credential is needed: <video>/hls.js never send a Bearer token.
// Mounted BEFORE any `app.use('/api', gateContent, ...)`: those gates run for every
// /api request that reaches them, so with REQUIRE_AUTH=true they 401'd every stream.
app.use('/api', proxyRouter);

// Default for every other API answer: per-viewer (tier, account) and short-lived (signed
// URLs, health verdicts), so a shared cache never keeps one and the browser revalidates
// (ETag -> 304). A token hand-off (no-store, set by authenticate) is kept, and a route
// that sets its own Cache-Control overrides this.
app.use('/api', (_req, res, next) => {
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-cache');
  next();
});

// ── Public runtime config (web adapts its UI to this) ──────────
app.get('/api/config', (_req, res) => {
  res.json({
    requireAuth: config.requireAuth,
    allowRegister: config.allowRegister,
    hideNsfw: config.hideNsfw,
    name: 'NEOWATCH',
    epgEnabled: epgEnabled(),
    billing: {
      provider: config.billingProvider,
      price: Number(config.premiumPrice),
      currency: config.premiumCurrency,
      period: config.premiumPeriodDays,
      // false = no payment step is open (mock refused in prod, Stripe keys missing).
      checkout: checkoutAvailable(),
    },
    adsenseClient: config.adsenseClient,
    ...(config.androidApk ? { androidApk: config.androidApk } : {}),
    premiumCategories: config.premiumCategories,
  });
});

// Monitoring (Neo polls it; status < 500 = healthy, key `ok` is frozen). 503 + ok:false
// when the catalog is empty (after the first build settled) or its data is older than
// 2 x TTL (iptv-org unreachable for that long). User counts only for an admin.
const bootAt = Date.now();
app.get('/api/health', (req, res) => {
  ensureCatalog().catch(() => {}); // a poll also kicks a due refresh / cold retry (backoff-gated)
  const c = catalogStatus();
  const warming = c.building && !c.total;
  const tooOld = c.ageMs !== null && c.ageMs > 2 * config.catalogTtlMs;
  const ok = warming || (c.total > 0 && !tooOld);
  const h = healthStats();
  const body = {
    ok,
    uptimeS: Math.floor((Date.now() - bootAt) / 1000),
    catalog: {
      total: c.total, base: c.base, custom: c.custom, updatedAt: c.updatedAt, dataAt: c.dataAt,
      ageMin: c.ageMs === null ? null : Math.floor(c.ageMs / 60000), stale: c.stale, building: c.building,
    },
    epg: { enabled: epgEnabled(), channels: epgChannelIds().size },
    streams: { checked: h.checked, online: h.online, offline: h.offline },
  };
  if (req.user?.role === 'admin') {
    body.catalog.lastError = c.lastError;
    body.users = getStats();
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(ok ? 200 : 503).json(body);
});

// ── Auth + admin ───────────────────────────────────────────────
app.use('/api/auth', authRouter);
// Throttle all admin endpoints (defence-in-depth: caps user enumeration + the
// expensive M3U/EPG import fetches even if an admin token is compromised).
app.use('/api/admin', rateLimit({ windowMs: 60_000, max: 100, name: 'admin' }), privateNoStore);
app.use('/api/admin', requireAdmin, adminRouter);
app.use('/api/admin', requireAdmin, sourcesAdminRouter);
app.use('/api/admin', requireAdmin, billingAdminRouter);
app.use('/api/admin', requireAdmin, healthAdminRouter);

// ── Billing / subscription (requireUser is applied per-route inside) ──
app.use('/api', billingPublicRouter);
app.use('/api', billingUserRouter);

// ── Premium watch preferences (read: any user, write: premium) ──
app.use('/api', prefsRouter);

// Custom M3U sources: list is readable by anyone allowed to see the catalog.
app.use('/api', gateContent, sourcesPublicRouter);

// EPG (program guide): now/next + programme search; admin manages XMLTV sources.
app.use('/api', gateContent, epgPublicRouter);
app.use('/api/admin', requireAdmin, epgAdminRouter);

// Films VOD (Internet Archive public-domain catalog) -- free for everyone.
app.use('/api', gateContent, filmsRouter);

// Internet radio (radio-browser.info community directory) -- free for everyone.
app.use('/api', gateContent, radioRouter);

// ── Catalog (gated when REQUIRE_AUTH=true) ─────────────────────
app.get('/api/catalog/meta', gateContent, async (_req, res) => {
  try {
    await ensureCatalog();
    res.json(getMeta());
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// Repeated query keys arrive as arrays (?q=a&q=b); coerce to a single string so a
// String method downstream can't throw a 503 (and leak the internal error).
const qstr = (v) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
// Bounded integer query param: non-finite (1e400, junk) or 0 -> default, then clamped.
const intParam = (v, def, min, max) => {
  const n = Math.floor(Number(qstr(v)));
  return Number.isFinite(n) && n !== 0 ? Math.min(max, Math.max(min, n)) : def;
};

const Q_MAX = 100; // same cap as /api/epg/search

app.get('/api/catalog/channels', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const category = qstr(req.query.category), country = qstr(req.query.country);
    // q is capped (a long multi-token query was matched against every channel, twice:
    // ~0.4 s of blocked event loop per 8 KB URL). Token count is capped in selectChannels.
    const language = qstr(req.query.language), q = qstr(req.query.q)?.slice(0, Q_MAX);
    const foot = req.query.foot === '1' || req.query.foot === 'true';
    const hideOffline = req.query.hideOffline === '1' || req.query.hideOffline === 'true';
    const sort = ['name', 'latency'].includes(req.query.sort) ? req.query.sort : 'smart';
    const langBoost = LANG3[qstr(req.query.lang)] || '';
    const page = intParam(req.query.page, 1, 1, 10000);
    const limit = intParam(req.query.limit, 60, 1, 120);
    res.json(queryChannels({ category, country, language, q, foot, hideOffline, sort, langBoost, page, limit, premiumOk: isPremium(req.user) }));
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// Curated homepage rails (Netflix/Molotov-style discover), online-first + premium-aware.
// Audience is primarily European: surface big European markets near the top
// (after sport), then the full category set. Country codes are iptv-org ISO codes.
// Titles per UI language (?lang=en|fr|ru, default en); `hero` = the category whose
// artwork fits a spotlight taken from this rail (country rails use the channel's own).
const HOME_RAILS = [
  { key: 'foot', title: { en: 'Football & Sport', fr: 'Football & Sport', ru: 'Футбол и спорт' }, icon: '⚽', q: { foot: true }, hero: 'sports' },
  { key: 'fr', title: { en: 'France', fr: 'France', ru: 'Франция' }, icon: '🇫🇷', q: { country: 'FR' } },
  { key: 'uk', title: { en: 'United Kingdom', fr: 'Royaume-Uni', ru: 'Великобритания' }, icon: '🇬🇧', q: { country: 'UK' } },
  { key: 'de', title: { en: 'Germany', fr: 'Allemagne', ru: 'Германия' }, icon: '🇩🇪', q: { country: 'DE' } },
  { key: 'it', title: { en: 'Italy', fr: 'Italie', ru: 'Италия' }, icon: '🇮🇹', q: { country: 'IT' } },
  { key: 'es', title: { en: 'Spain', fr: 'Espagne', ru: 'Испания' }, icon: '🇪🇸', q: { country: 'ES' } },
  { key: 'news', title: { en: 'Live news', fr: 'News en direct', ru: 'Новости в прямом эфире' }, icon: '📰', q: { category: 'news' }, hero: 'news' },
  { key: 'movies', title: { en: 'Movies', fr: 'Films', ru: 'Фильмы' }, icon: '🎬', q: { category: 'movies' }, hero: 'movies' },
  { key: 'series', title: { en: 'Series', fr: 'Séries', ru: 'Сериалы' }, icon: '📺', q: { category: 'series' }, hero: 'series' },
  { key: 'kids', title: { en: 'Kids', fr: 'Enfants', ru: 'Детям' }, icon: '🧸', q: { category: 'kids' }, hero: 'kids' },
  { key: 'music', title: { en: 'Music', fr: 'Musique', ru: 'Музыка' }, icon: '🎵', q: { category: 'music' }, hero: 'music' },
  { key: 'documentary', title: { en: 'Documentaries', fr: 'Documentaires', ru: 'Документальные' }, icon: '🌍', q: { category: 'documentary' }, hero: 'documentary' },
  { key: 'entertainment', title: { en: 'Entertainment', fr: 'Divertissement', ru: 'Развлечения' }, icon: '✨', q: { category: 'entertainment' }, hero: 'entertainment' },
  { key: 'general', title: { en: 'Popular channels', fr: 'Généralistes populaires', ru: 'Популярные каналы' }, icon: '📡', q: { category: 'general' }, hero: 'general' },
];
const HOME_LANGS = ['en', 'fr', 'ru'];

// Cache the expensive filter+sort selection per catalog build; project (sign
// URLs) per build+tier. Signed proxy URLs expire after 2h (signing.js), but the
// catalog build cadence is 12h -- so the projected payload must be refreshed well
// inside the signature TTL or home would serve expired (403) proxy URLs.
const HOME_PROJ_TTL_MS = 90 * 60 * 1000; // re-sign the home payload every 90 min (< 2h sig TTL)
// The health sweep flips verdicts all day: re-rank the rails (online first) when the
// verdicts moved, at most every 5 min (a sweep batch must not rebuild every request).
const HOME_RAW_MIN_MS = 5 * 60 * 1000;
const HOME_RAIL_LEN = 16; // rows show 8 + See all; the spare covers hidden categories
const HOME_POOL_LEN = 120; // spotlight candidates per rail (not just the rail's first 30)
const EMPTY_FILTER = { category: null, country: null, language: null, q: '', foot: false, favoritesOnly: false, onlineOnly: false, hideGeoBlocked: false };
// UI language -> iptv-org ISO-639 language code used to boost matching channels
// so the home feels localized for the viewer's language.
const LANG3 = { fr: 'fra', en: 'eng', ru: 'rus' };
// Per language: raw filtered+sorted selection (cached per build). Projection
// (URL signing / premium lock) is cached per language+tier.
const homeRawByLang = new Map();   // lang -> { builtAt, at, sig, gen, rails }
const homeProjected = new Map();   // `${lang}:${tier}` -> { gen, projAt, payload }
let homeGen = 0;
const healthSig = () => { const h = healthStats(); return `${h.checked}:${h.online}:${h.offline}`; };

function buildHomeRaw(lang) {
  return HOME_RAILS
    .map((r) => {
      // No language boost inside a country rail: it would put the English feeds of
      // France ahead of the French channels for an English viewer.
      const sel = selectChannels({ ...r.q, page: 1, limit: HOME_POOL_LEN, langBoost: r.q.country ? '' : LANG3[lang] });
      // Send a COMPLETE Filters object so the client replaces (not merges) state.
      return { key: r.key, title: r.title[lang], icon: r.icon, hero: r.hero || null, filter: { ...EMPTY_FILTER, ...r.q }, total: sel.total, raw: sel.items.slice(0, HOME_RAIL_LEN), pool: sel.items };
    })
    .filter((r) => r.raw.length);
}

// Spotlight tie-break, never alphabetical: confirmed online only, then HD, then a
// rotation that is stable for a whole (UTC) day and different the next one.
const qualityRank = (q) => { const n = parseInt(q, 10); return !n ? 1 : n >= 720 ? 2 : 0; };
const dayRotation = (key) => hash32(`${new Date().toISOString().slice(0, 10)}|${key}`) / 2 ** 32;
function pickSpotlight(rail, premiumOk, seen) {
  let best = null, bestK = -1;
  for (const it of rail.pool) {
    if (!it.logo || seen.has(it.url)) continue;
    const c = projectChannel(it, premiumOk);
    if (c.online !== true || c.locked || !c.url) continue;
    const k = qualityRank(c.quality) + dayRotation(c.id);
    if (k > bestK) { best = c; bestK = k; }
  }
  return best;
}

function buildHomePayload(rawRails, premiumOk) {
  const rails = rawRails.map((r) => ({
    key: r.key, title: r.title, icon: r.icon, filter: r.filter, total: r.total,
    channels: r.raw.map((it) => projectChannel(it, premiumOk)),
  }));
  // Hero spotlights: one confirmed-online channel per rail (an offline one is never
  // shown as live). `heroCategory` lets the client pick artwork that matches it.
  const featured = [];
  const seen = new Set();
  for (const r of rawRails) {
    if (featured.length >= 6) break;
    const pick = pickSpotlight(r, premiumOk, seen);
    if (!pick) continue;
    seen.add(pick.url);
    const heroCategory = r.hero || (pick.categories || []).find((c) => c !== 'undefined') || 'general';
    featured.push({ ...pick, railKey: r.key, railTitle: r.title, railIcon: r.icon, heroCategory });
  }
  return { rails, featured };
}

app.get('/api/catalog/home', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const builtAt = getMeta().updatedAt;
    const lang = HOME_LANGS.includes(req.query.lang) ? req.query.lang : 'en';
    const now = Date.now();
    let raw = homeRawByLang.get(lang);
    const due = raw && raw.builtAt === builtAt && now - raw.at > HOME_RAW_MIN_MS;
    const sig = !raw || raw.builtAt !== builtAt || due ? healthSig() : raw.sig;
    if (!raw || raw.builtAt !== builtAt || (due && sig !== raw.sig)) {
      raw = { builtAt, at: now, sig, gen: ++homeGen, rails: buildHomeRaw(lang) };
      homeRawByLang.set(lang, raw);
    } else if (due) {
      raw.at = now; // verdicts unchanged: check again in 5 min
    }
    const tier = isPremium(req.user) ? 'premium' : 'free';
    const pk = `${lang}:${tier}`;
    let proj = homeProjected.get(pk);
    if (!proj || proj.gen !== raw.gen || (now - proj.projAt) > HOME_PROJ_TTL_MS) {
      proj = { gen: raw.gen, projAt: now, payload: buildHomePayload(raw.rails, tier === 'premium') };
      homeProjected.set(pk, proj);
    }
    res.json(proj.payload);
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

app.get('/api/catalog/channel/:id', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    // ?channelId=<tvg-id> (optional, additive): last-resort fallback for an id that no
    // longer resolves (alternate index + id aliases are tried first, see catalog.js).
    const ch = getChannelById(req.params.id, isPremium(req.user), { channelId: qstr(req.query.channelId) });
    if (!ch) return res.status(404).json({ error: 'not found' });
    res.json(ch);
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// A random playable channel -- powers the one-click "Surprise me" watch (great on TV:
// no browsing, just press a button and something good is on). Online + unlocked only.
app.get('/api/catalog/random', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const premiumOk = isPremium(req.user);
    // hideOffline (NOT onlineOnly -- selectChannels reads hideOffline) so "Surprise
    // me" never lands on a channel the health sweep has confirmed dead.
    const pool = selectChannels({ hideOffline: true, sort: 'smart', page: 1, limit: 250 }).items;
    if (!pool.length) return res.status(404).json({ error: 'no channel available' });
    for (let i = 0; i < 15; i++) {
      const ch = projectChannel(pool[Math.floor(Math.random() * pool.length)], premiumOk);
      if (ch.url && !ch.locked) return res.json(ch);
    }
    res.status(404).json({ error: 'no playable channel' });
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// EPG grid (Programme TV page): channels that have a guide, with today's schedule,
// filterable by country/category. Powers the 24h grid view.
app.get('/api/epg/grid', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const country = qstr(req.query.country), category = qstr(req.query.category);
    const premiumOk = isPremium(req.user);
    const sel = selectChannels({ category, country, sort: 'smart', page: 1, limit: 400 });
    const channels = [];
    for (const it of sel.items) {
      if (channels.length >= 60) break;
      if (!it.channelId || !hasEpg(it.channelId)) continue;
      const ch = projectChannel(it, premiumOk);
      channels.push({ id: ch.id, name: ch.name, logo: ch.logo, flag: ch.flag, channelId: ch.channelId, locked: ch.locked, programmes: epgDay(it.channelId, 40) });
    }
    res.json({ channels, enabled: epgEnabled() });
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// Admin: takedown blocklist -- hide a stream instantly on a rights-holder request.
app.get('/api/admin/blocklist', requireAdmin, (_req, res) => res.json({ urls: getBlocklist() }));
// A failed save answers 500 (the takedown still applies in memory until the restart).
app.post('/api/admin/blocklist', requireAdmin, async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : (req.body?.url ? [req.body.url] : []);
  if (!urls.length) return res.status(400).json({ error: 'url or urls[] required' });
  if (urls.length > 1000) return res.status(400).json({ error: 'too many urls (max 1000)' });
  try {
    res.json(await addToBlocklist(urls));
  } catch {
    res.status(500).json({ error: 'blocklist not saved' });
  }
});
app.delete('/api/admin/blocklist', requireAdmin, async (req, res) => {
  const url = qstr(req.body?.url) || qstr(req.query?.url);
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    res.json(await removeFromBlocklist(url));
  } catch {
    res.status(500).json({ error: 'blocklist not saved' });
  }
});

// Admin: configuration audit + channel-health audit (per category).
app.get('/api/admin/config', requireAdmin, (_req, res) => res.json(publicConfigAudit()));
app.get('/api/admin/channels/audit', requireAdmin, async (_req, res) => {
  try {
    await ensureCatalog();
    res.json(auditChannels());
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

app.post('/api/catalog/refresh', requireAdmin, async (_req, res) => {
  try {
    await ensureCatalog(true);
    res.json(getMeta());
  } catch (err) {
    res.status(503).json({ error: 'refresh failed', detail: String(err?.message || err) });
  }
});

// ── Stream health checks (LIVE / OFFLINE badges) ───────────────
app.use('/api', gateContent, healthRouter);

// Unknown API route: keep the JSON contract (never the SPA, never Express's HTML).
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// ── Serve built web app in production ──────────────────────────
if (existsSync(config.webDist)) {
  // A missing hashed chunk (an old tab after a deploy) must be a real 404: answered
  // with index.html it fails as a module AND gets cached as JS by the service worker.
  // Hashed file names: cacheable forever (the Docker/self-host path has no nginx to add it).
  app.use('/assets', express.static(join(config.webDist, 'assets'), { fallthrough: false, index: false, immutable: true, maxAge: '1y' }));
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(config.webDist, 'index.html'));
  });
}

// Last resort: JSON, no stack trace or path (Express's default handler prints both
// outside NODE_ENV=production). A bad URI escape is a 400, a missing asset a 404.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // mid-stream: let Express drop the socket
  const st = Number(err?.status || err?.statusCode);
  const status = st >= 400 && st < 600 ? st : 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err?.message || err);
  res.status(status).json({ error: status === 404 ? 'not found' : status < 500 ? 'bad request' : 'server error' });
});

async function start() {
  // Prod / SaaS must set an explicit JWT_SECRET (so tokens + signed URLs survive
  // restarts). In dev a strong random secret is generated per boot (config.js).
  if ((config.requireAuth || config.isProd) && !config.jwtSecretExplicit) {
    console.error('\n  FATAL: set an explicit JWT_SECRET (>=32 chars) in .env before running with REQUIRE_AUTH=true or NODE_ENV=production.\n');
    process.exit(1);
  }
  // Configuration audit at boot.
  const warnings = validateConfig();
  for (const w of warnings) console.log(`[config:${w.level}] ${w.key}: ${w.msg}`);

  try {
    await initAuth();
  } catch (e) {
    // A corrupt/unreadable users.json: never boot on an empty store (it would be saved over).
    console.error(`\n  FATAL: ${e.message}. Accounts were NOT touched. Repair the file (a .bak copy is kept next to it) and restart.\n`);
    process.exit(1);
  }
  await loadBlocklist(); // before the first catalog build so takedowns apply immediately
  await loadIdAliases();
  // Custom M3U sources + EPG do not need the iptv-org base (setCustomItems composes
  // with an empty one), so a failed warm-up never skips them. The health sweep probes
  // catalog URLs, so it starts once the warm-up settled, whatever its outcome.
  initSources().catch((e) => console.error('[sources] init failed:', e.message));
  initEpg().catch((e) => console.error('[epg] init failed:', e.message));
  ensureCatalog()
    .catch((e) => console.error('[catalog] warm-up failed:', e.message))
    .finally(() => initHealth().catch((e) => console.error('[health] init failed:', e.message)));
  const server = app.listen(config.port, () => {
    console.log(`\n  NEOWATCH server  →  http://localhost:${config.port}`);
    console.log(`  auth: ${config.requireAuth ? 'REQUIRED (SaaS mode)' : 'public (dev)'} | register: ${config.allowRegister ? 'on' : 'off'}\n`);
  });
  // A port clash must kill the process (systemd restarts it); the global
  // uncaughtException guard would otherwise keep a zombie that serves nothing.
  server.on('error', (e) => {
    console.error(`[listen] ${e.code || ''} ${e.message}`);
    process.exit(1);
  });
  // Graceful stop (systemd / Docker): refuse new connections, write pending state,
  // and exit within 3s even if long-lived streams are still open.
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig}: shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();
    let closed = false, flushed = false;
    const done = () => closed && flushed && process.exit(0);
    server.close(() => { closed = true; done(); });
    server.closeIdleConnections?.();
    Promise.allSettled([flushIdAliases(), flushHealth()]).finally(() => { flushed = true; done(); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start();
