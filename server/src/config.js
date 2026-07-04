import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import dotenv from 'dotenv';

// Load .env from the repo root (one level above /server).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
dotenv.config({ path: resolve(ROOT, '.env') });

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
};

export const config = {
  root: ROOT,
  port: Number(process.env.PORT) || 8787,
  catalogTtlMs: (Number(process.env.CATALOG_TTL_HOURS) || 12) * 3600 * 1000,
  apiBase: (process.env.IPTV_API_BASE || 'https://iptv-org.github.io/api').replace(/\/$/, ''),
  hideNsfw: bool(process.env.HIDE_NSFW, true),
  accessPassword: process.env.ACCESS_PASSWORD || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  cacheDir: resolve(__dirname, '../.cache'),
  dataDir: resolve(__dirname, '../.data'),
  webDist: resolve(ROOT, 'web/dist'),
  isProd: process.env.NODE_ENV === 'production',

  // ── Auth / SaaS ──────────────────────────────────────────────
  // When false, the catalog/proxy are public (great for localhost). Set true
  // for a shared/VPS deployment so only logged-in users can watch.
  requireAuth: bool(process.env.REQUIRE_AUTH, false),
  // Allow visitors to self-register a free account. Admins are created from env.
  allowRegister: bool(process.env.ALLOW_REGISTER, true),
  // No hardcoded default: if unset, generate a strong random secret per boot
  // (tokens are unforgeable but ephemeral in dev). Prod must set one explicitly
  // so tokens/signed URLs survive restarts -- enforced at boot in index.js.
  jwtSecret: process.env.JWT_SECRET || randomBytes(48).toString('base64url'),
  jwtSecretExplicit: !!process.env.JWT_SECRET,
  // Shorter default reduces the blast radius of a leaked token (no revocation list yet).
  jwtTtl: process.env.JWT_TTL || '7d',
  // Separate key for HMAC URL signing (key separation from JWT). Derived from the
  // JWT secret with a distinct label so it survives restarts without a new env var,
  // or set SIGNING_SECRET explicitly.
  signingSecret: process.env.SIGNING_SECRET ||
    createHmac('sha256', process.env.JWT_SECRET || 'neowatch-dev').update('neowatch:url-signing:v1').digest('hex'),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@neowatch.local',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Allow admin M3U sources to point at private/LAN hosts (e.g. your own
  // provider on the local network). Off by default (SSRF-safe).
  allowPrivateSources: bool(process.env.ALLOW_PRIVATE_SOURCES, false),
  // ── Monetization ─────────────────────────────────────────────
  // Channels in these categories require a paid (premium) plan; everything
  // else is free (ad-supported). Custom M3U sources are premium by default.
  premiumCategories: (process.env.PREMIUM_CATEGORIES || 'sports,movies,series')
    .split(',').map((s) => s.trim()).filter(Boolean),
  customIsPremium: bool(process.env.CUSTOM_PREMIUM, true),
  // Billing provider: 'mock' (instant activation, dev/self-host) or 'stripe'.
  billingProvider: process.env.BILLING_PROVIDER || 'mock',
  premiumPrice: process.env.PREMIUM_PRICE || '4.99',
  premiumCurrency: process.env.PREMIUM_CURRENCY || 'EUR',
  premiumPeriodDays: Number(process.env.PREMIUM_PERIOD_DAYS) || 30,
  // Google AdSense publisher id (e.g. ca-pub-XXXX) shown to FREE users only.
  adsenseClient: process.env.ADSENSE_CLIENT || '',
  stripeSecret: process.env.STRIPE_SECRET || '',
  stripePriceId: process.env.STRIPE_PRICE_ID || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  publicUrl: process.env.PUBLIC_URL || 'https://neowatch.soclose.co',

  // Express "trust proxy" setting so req.ip is the real client behind nginx.
  // e.g. TRUST_PROXY=1 (one hop) or TRUST_PROXY=loopback. Default off.
  trustProxy: (() => {
    const v = process.env.TRUST_PROXY;
    if (v === undefined || v === '') return false;
    if (/^\d+$/.test(v)) return Number(v);
    // Avoid trusting the entire X-Forwarded-For chain ("true"); 1 hop is the safe default.
    if (v === 'true') return 1;
    if (v === 'false') return false;
    return v; // e.g. "loopback", a specific subnet
  })(),
  // Default timezone offset (minutes) applied to XMLTV timestamps that omit one.
  epgDefaultTzMinutes: Number(process.env.EPG_DEFAULT_TZ_MINUTES) || 0,
  // Background health sweep: proactively probe channels so working ones surface
  // first with instant badges. Off by default (it makes many outbound requests);
  // enable on a deployed instance, or trigger once from the admin panel.
  healthSweep: bool(process.env.HEALTH_SWEEP, false),
  healthSweepIntervalMs: (Number(process.env.HEALTH_SWEEP_INTERVAL_HOURS) || 6) * 3600 * 1000,
  sweepBatch: Number(process.env.SWEEP_BATCH_SIZE) || 60,
  sweepConcurrency: Number(process.env.SWEEP_CONCURRENCY) || 8,
  // Optional default XMLTV EPG loaded at boot (your provider's guide, or a public
  // aggregated XMLTV). Programmes map to channels by tvg-id.
  epgDefaultUrl: process.env.EPG_DEFAULT_URL || '',
};

// Audit the effective configuration and return actionable warnings. Run at boot
// (logged) and exposed read-only to admins via GET /api/admin/config.
export function validateConfig() {
  const warn = [];
  const add = (level, key, msg) => warn.push({ level, key, msg });

  if (!config.jwtSecretExplicit) {
    add(config.isProd || config.requireAuth ? 'error' : 'info', 'JWT_SECRET',
      config.isProd || config.requireAuth ? 'Missing in prod/gated mode (boot refuses).' : 'Auto-generated (dev): tokens reset on restart. Set JWT_SECRET to persist sessions.');
  } else if (config.jwtSecret.length < 32) {
    add('warn', 'JWT_SECRET', 'Shorter than 32 chars; use a long random secret.');
  }
  if (config.requireAuth && config.allowRegister) {
    add('info', 'ALLOW_REGISTER', 'Open registration while REQUIRE_AUTH is on: anyone can self-create an account.');
  }
  for (const o of config.allowedOrigins) {
    if (!/^https?:\/\//i.test(o)) add('warn', 'ALLOWED_ORIGINS', `"${o}" is not a valid http(s) origin.`);
  }
  if (config.billingProvider === 'stripe' && (!config.stripeSecret || !config.stripePriceId)) {
    add('warn', 'BILLING_PROVIDER', 'Set to "stripe" but STRIPE_SECRET / STRIPE_PRICE_ID are missing (checkout will 503).');
  }
  if (config.billingProvider === 'mock' && (config.isProd || config.requireAuth)) {
    add('warn', 'BILLING_PROVIDER', 'Using mock billing on a gated/prod instance: premium activates with no real payment.');
  }
  if (config.adsenseClient && !/^ca-pub-\d+/.test(config.adsenseClient)) {
    add('warn', 'ADSENSE_CLIENT', 'Does not look like a "ca-pub-..." publisher id.');
  }
  if (!(Number(config.premiumPrice) > 0)) add('warn', 'PREMIUM_PRICE', 'Not a positive number.');
  if (!config.premiumCategories.length) add('info', 'PREMIUM_CATEGORIES', 'Empty: every channel is free.');
  if (config.allowPrivateSources) add('warn', 'ALLOW_PRIVATE_SOURCES', 'Enabled: SSRF guard is bypassed for source/EPG fetches.');
  if ((config.isProd || config.requireAuth) && !config.allowedOrigins.length && config.trustProxy === false) {
    add('info', 'TRUST_PROXY', 'Behind a reverse proxy? Set TRUST_PROXY so rate limiting sees real client IPs.');
  }
  return warn;
}

// Effective config with secrets redacted (for the admin audit endpoint).
export function publicConfigAudit() {
  return {
    port: config.port,
    isProd: config.isProd,
    requireAuth: config.requireAuth,
    allowRegister: config.allowRegister,
    hideNsfw: config.hideNsfw,
    catalogTtlHours: config.catalogTtlMs / 3600000,
    premiumCategories: config.premiumCategories,
    customIsPremium: config.customIsPremium,
    billingProvider: config.billingProvider,
    premiumPrice: config.premiumPrice,
    premiumCurrency: config.premiumCurrency,
    adsenseConfigured: !!config.adsenseClient,
    stripeConfigured: !!(config.stripeSecret && config.stripePriceId),
    jwtSecretExplicit: config.jwtSecretExplicit,
    trustProxy: config.trustProxy,
    allowedOrigins: config.allowedOrigins,
    allowPrivateSources: config.allowPrivateSources,
    healthSweep: config.healthSweep,
    warnings: validateConfig(),
  };
}
