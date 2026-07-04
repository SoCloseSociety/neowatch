import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, validateConfig, publicConfigAudit } from './config.js';
import { ensureCatalog, getMeta, queryChannels, getChannelById, isPremiumUrl, auditChannels, selectChannels, projectChannel, loadBlocklist, getBlocklist, addToBlocklist, removeFromBlocklist } from './catalog.js';
import { proxyRouter } from './proxy.js';
import { healthRouter, healthAdminRouter, initHealth } from './health.js';
import { sourcesPublicRouter, sourcesAdminRouter, initSources } from './sources.js';
import { epgPublicRouter, epgAdminRouter, initEpg, epgEnabled, hasEpg, epgDay } from './epg.js';
import { filmsRouter } from './films.js';
import { radioRouter } from './radio.js';
import { billingPublicRouter, billingUserRouter, billingAdminRouter, stripeWebhookHandler } from './billing.js';
import { rateLimit } from './ratelimit.js';
import {
  initAuth, authenticate, requireAdmin, requireUser, gateContent, isPremium, userFromToken,
  authRouter, adminRouter, prefsRouter, getStats,
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
// Baseline security headers (no CSP -- nginx owns TLS/HSTS, and a strict CSP would
// need careful tuning for AdSense + hls.js). These are safe defaults.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(compression());
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
  app.use(cors({ origin: config.allowedOrigins, credentials: false }));
}
app.use(authenticate); // populates req.user when a token is sent

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
    },
    adsenseClient: config.adsenseClient,
    premiumCategories: config.premiumCategories,
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ...getStats() }));

// ── Auth + admin ───────────────────────────────────────────────
app.use('/api/auth', authRouter);
// Throttle all admin endpoints (defence-in-depth: caps user enumeration + the
// expensive M3U/EPG import fetches even if an admin token is compromised).
app.use('/api/admin', rateLimit({ windowMs: 60_000, max: 100, name: 'admin' }));
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

app.get('/api/catalog/channels', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const category = qstr(req.query.category), country = qstr(req.query.country);
    const language = qstr(req.query.language), q = qstr(req.query.q);
    const foot = req.query.foot === '1' || req.query.foot === 'true';
    const hideOffline = req.query.hideOffline === '1' || req.query.hideOffline === 'true';
    const sort = ['name', 'latency'].includes(req.query.sort) ? req.query.sort : 'smart';
    const langBoost = LANG3[qstr(req.query.lang)] || '';
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const limit = Math.min(120, Math.max(1, Math.floor(Number(req.query.limit)) || 60));
    res.json(queryChannels({ category, country, language, q, foot, hideOffline, sort, langBoost, page, limit, premiumOk: isPremium(req.user) }));
  } catch {
    res.status(503).json({ error: 'catalog unavailable' });
  }
});

// Curated homepage rails (Netflix/Molotov-style discover), online-first + premium-aware.
// Audience is primarily European: surface big European markets near the top
// (after sport), then the full category set. Country codes are iptv-org ISO codes.
const HOME_RAILS = [
  { key: 'foot', title: 'Football & Sport', icon: '⚽', q: { foot: true } },
  { key: 'fr', title: 'France', icon: '🇫🇷', q: { country: 'FR' } },
  { key: 'uk', title: 'Royaume-Uni', icon: '🇬🇧', q: { country: 'UK' } },
  { key: 'de', title: 'Allemagne', icon: '🇩🇪', q: { country: 'DE' } },
  { key: 'it', title: 'Italie', icon: '🇮🇹', q: { country: 'IT' } },
  { key: 'es', title: 'Espagne', icon: '🇪🇸', q: { country: 'ES' } },
  { key: 'news', title: 'News en direct', icon: '📰', q: { category: 'news' } },
  { key: 'movies', title: 'Films', icon: '🎬', q: { category: 'movies' } },
  { key: 'series', title: 'Séries', icon: '📺', q: { category: 'series' } },
  { key: 'kids', title: 'Enfants', icon: '🧸', q: { category: 'kids' } },
  { key: 'music', title: 'Musique', icon: '🎵', q: { category: 'music' } },
  { key: 'documentary', title: 'Documentaires', icon: '🌍', q: { category: 'documentary' } },
  { key: 'entertainment', title: 'Divertissement', icon: '✨', q: { category: 'entertainment' } },
  { key: 'general', title: 'Généralistes populaires', icon: '📡', q: { category: 'general' } },
];

// Cache the expensive filter+sort selection per catalog build; project (sign
// URLs) per build+tier. Signed proxy URLs expire after 2h (signing.js), but the
// catalog build cadence is 12h -- so the projected payload must be refreshed well
// inside the signature TTL or home would serve expired (403) proxy URLs.
const HOME_PROJ_TTL_MS = 90 * 60 * 1000; // re-sign the home payload every 90 min (< 2h sig TTL)
const EMPTY_FILTER = { category: null, country: null, language: null, q: '', foot: false, favoritesOnly: false, onlineOnly: false, hideGeoBlocked: false };
// UI language -> iptv-org ISO-639 language code used to boost matching channels
// so the home feels localized for the viewer's language.
const LANG3 = { fr: 'fra', en: 'eng', ru: 'rus' };
// Per language: raw filtered+sorted selection (cached per build). Projection
// (URL signing / premium lock) is cached per language+tier.
const homeRawByLang = new Map();   // lang -> { builtAt, rails }
const homeProjected = new Map();   // `${lang}:${tier}` -> { builtAt, payload }

function buildHomeRaw(langBoost) {
  return HOME_RAILS
    .map((r) => {
      const sel = selectChannels({ ...r.q, page: 1, limit: 30, langBoost });
      // Send a COMPLETE Filters object so the client replaces (not merges) state.
      return { key: r.key, title: r.title, icon: r.icon, filter: { ...EMPTY_FILTER, ...r.q }, total: sel.total, raw: sel.items };
    })
    .filter((r) => r.raw.length);
}
function buildHomePayload(rawRails, premiumOk) {
  const rails = rawRails.map((r) => ({
    key: r.key, title: r.title, icon: r.icon, filter: r.filter, total: r.total,
    channels: r.raw.map((it) => projectChannel(it, premiumOk)),
  }));
  // Hero spotlights: prefer online+logo, then fall back to any logo'd channel.
  const featured = [];
  const seen = new Set();
  for (const pass of [(c) => c.online && c.logo && !c.locked, (c) => c.logo && !c.locked]) {
    for (const rail of rails) {
      if (featured.length >= 6) break;
      const pick = rail.channels.find((c) => !seen.has(c.url) && pass(c));
      if (pick) {
        seen.add(pick.url);
        featured.push({ ...pick, railKey: rail.key, railTitle: rail.title, railIcon: rail.icon });
      }
    }
    if (featured.length >= 6) break;
  }
  return { rails, featured };
}

app.get('/api/catalog/home', gateContent, async (req, res) => {
  try {
    await ensureCatalog();
    const builtAt = getMeta().updatedAt;
    const lang = ['fr', 'en', 'ru'].includes(req.query.lang) ? req.query.lang : 'fr';
    let raw = homeRawByLang.get(lang);
    if (!raw || raw.builtAt !== builtAt) {
      raw = { builtAt, rails: buildHomeRaw(LANG3[lang]) };
      homeRawByLang.set(lang, raw);
    }
    const tier = isPremium(req.user) ? 'premium' : 'free';
    const pk = `${lang}:${tier}`;
    let proj = homeProjected.get(pk);
    if (!proj || proj.builtAt !== builtAt || (Date.now() - proj.projAt) > HOME_PROJ_TTL_MS) {
      proj = { builtAt, projAt: Date.now(), payload: buildHomePayload(raw.rails, tier === 'premium') };
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
    const ch = getChannelById(req.params.id, isPremium(req.user));
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
app.post('/api/admin/blocklist', requireAdmin, async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : (req.body?.url ? [req.body.url] : []);
  if (!urls.length) return res.status(400).json({ error: 'url or urls[] required' });
  res.json(await addToBlocklist(urls));
});
app.delete('/api/admin/blocklist', requireAdmin, async (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  res.json(await removeFromBlocklist(String(url)));
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

// ── Stream proxy ───────────────────────────────────────────────
// Access is enforced by the HMAC signature on the URL (only vended to allowed
// users at catalog time), so no credential is needed in the query string.
app.use('/api', proxyRouter);

// ── Serve built web app in production ──────────────────────────
if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(config.webDist, 'index.html'));
  });
}

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

  await initAuth();
  await loadBlocklist(); // before the first catalog build so takedowns apply immediately
  // Warm the catalog, then load custom M3U sources + EPG + health. Each step is
  // independent: one failing must not block the others (allSettled).
  ensureCatalog()
    .then(() => Promise.allSettled([
      initSources().catch((e) => console.error('[sources] init failed:', e.message)),
      initEpg().catch((e) => console.error('[epg] init failed:', e.message)),
      initHealth().catch((e) => console.error('[health] init failed:', e.message)),
    ]))
    .catch((e) => console.error('[catalog] warm-up failed:', e.message));
  app.listen(config.port, () => {
    console.log(`\n  NEOWATCH server  →  http://localhost:${config.port}`);
    console.log(`  auth: ${config.requireAuth ? 'REQUIRED (SaaS mode)' : 'public (dev)'} | register: ${config.allowRegister ? 'on' : 'off'}\n`);
  });
}

start();
