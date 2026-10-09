import { Router } from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { rateLimit } from './ratelimit.js';
import { readJsonArray } from './util.js';
import {
  updateBilling, findUserById, findByStripeCustomer, sanitize, requireUser, isPremium, onBeforeUserDelete,
} from './auth.js';

// Subscription billing. Premium sells FEATURES (see plans()), never content.
//  - 'stripe': hosted Checkout (REST, no SDK); premium is granted by the signed webhook.
//  - 'mock': instant activation with no payment. Fine on localhost / a self-host test,
//    refused in production unless ALLOW_MOCK_BILLING=true (an explicit "free beta").
//  - anything else (e.g. 'none'): checkout is closed.

const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
// Read here (not in config.js) so the flag is evaluated where it is enforced.
const mockAllowed = () => !config.isProd || bool(process.env.ALLOW_MOCK_BILLING);
const stripeReady = () => !!(config.stripeSecret && config.stripePriceId);
export function checkoutAvailable() {
  if (config.billingProvider === 'stripe') return stripeReady();
  if (config.billingProvider === 'mock') return mockAllowed();
  return false;
}

// ── Plan copy: ONE source, three languages ─────────────────────
// Only what the code really delivers today. Premium = the account-level viewing
// preferences behind PUT /me/prefs (pinned + hidden categories, default home page),
// stored on the account so they follow the user to every device. Favorites, the
// multi-screen mosaic (9 tiles), its sync, the TV guide, films and radio are free.
// "No ads" is listed only when ads actually run (ADSENSE_CLIENT set).
const COPY = {
  en: {
    free: 'Free',
    premium: 'Premium',
    freeFeatures: [
      'Every channel, free: sport, films, news, kids, music, radio',
      'Player, favorites, 9-screen mosaic, TV guide',
      'Favorites and mosaic follow you once signed in',
    ],
    freeAds: 'Supported by ads',
    premiumFeatures: [
      'Pin the categories you love, hide the others',
      'Choose the page the app opens on',
      'Your viewing preferences on every device',
      'Support an independent project',
    ],
    premiumNoAds: 'No ads',
    period: { day: 'day', week: 'week', month: 'month', year: 'year', days: (n) => `${n} days` },
    unavailable: 'Payments are not open yet. Every channel stays free.',
    unavailableCta: 'Coming soon',
    mockNotice: 'Test mode: no payment is taken.',
    activated: 'Premium is on. Your preferences now follow you.',
    disclaimer: 'You pay for the service features, never for the public streams. Cancel anytime: Premium stays on until the end of the paid period.',
    alreadyPremium: 'You already have Premium.',
    resumed: 'Premium will renew again.',
    canceled: (d) => `Premium is cancelled. It stays on until ${d}.`,
    canceledNow: 'Premium is cancelled.',
  },
  fr: {
    free: 'Gratuit',
    premium: 'Premium',
    freeFeatures: [
      'Toutes les chaînes, gratuites : sport, films, info, enfants, musique, radio',
      'Lecteur, favoris, mosaïque 9 écrans, guide TV',
      'Favoris et mosaïque vous suivent une fois connecté',
    ],
    freeAds: 'Financé par la publicité',
    premiumFeatures: [
      'Épinglez vos catégories, masquez les autres',
      "Choisissez la page d'ouverture de l'app",
      "Vos préférences d'affichage sur tous vos appareils",
      'Soutenez un projet indépendant',
    ],
    premiumNoAds: 'Sans publicité',
    period: { day: 'jour', week: 'semaine', month: 'mois', year: 'an', days: (n) => `${n} jours` },
    unavailable: 'Les paiements ne sont pas encore ouverts. Toutes les chaînes restent gratuites.',
    unavailableCta: 'Bientôt',
    mockNotice: "Mode test : aucun paiement n'est prélevé.",
    activated: 'Premium est actif. Vos préférences vous suivent.',
    disclaimer: "Vous payez les fonctions du service, jamais les flux publics. Résiliable à tout moment : Premium reste actif jusqu'à la fin de la période payée.",
    alreadyPremium: 'Vous avez déjà Premium.',
    resumed: 'Premium sera de nouveau renouvelé.',
    canceled: (d) => `Premium est résilié. Il reste actif jusqu'au ${d}.`,
    canceledNow: 'Premium est résilié.',
  },
  ru: {
    free: 'Бесплатно',
    premium: 'Premium',
    freeFeatures: [
      'Все каналы бесплатно: спорт, фильмы, новости, детям, музыка, радио',
      'Плеер, избранное, мозаика на 9 экранов, телепрограмма',
      'Избранное и мозаика доступны на всех устройствах после входа',
    ],
    freeAds: 'За счёт рекламы',
    premiumFeatures: [
      'Закрепляйте любимые категории, скрывайте остальные',
      'Выберите стартовую страницу приложения',
      'Ваши настройки просмотра на всех устройствах',
      'Поддержите независимый проект',
    ],
    premiumNoAds: 'Без рекламы',
    period: { day: 'день', week: 'неделя', month: 'месяц', year: 'год', days: (n) => `${n} дн.` },
    unavailable: 'Оплата пока не открыта. Все каналы остаются бесплатными.',
    unavailableCta: 'Скоро',
    mockNotice: 'Тестовый режим: оплата не взимается.',
    activated: 'Premium включён. Ваши настройки теперь с вами.',
    disclaimer: 'Вы платите за функции сервиса, а не за публичные потоки. Отмена в любой момент: Premium действует до конца оплаченного периода.',
    alreadyPremium: 'У вас уже есть Premium.',
    resumed: 'Premium снова будет продлеваться.',
    canceled: (d) => `Premium отменён. Он действует до ${d}.`,
    canceledNow: 'Premium отменён.',
  },
};
const LANGS = Object.keys(COPY);
const LOCALE = { en: 'en-GB', fr: 'fr-FR', ru: 'ru-RU' };

// ?lang= wins, then the first supported Accept-Language entry, then English.
export function pickLang(req) {
  const q = typeof req.query?.lang === 'string' ? req.query.lang.slice(0, 2).toLowerCase() : '';
  if (LANGS.includes(q)) return q;
  for (const part of String(req.headers['accept-language'] || '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (LANGS.includes(code)) return code;
  }
  return 'en';
}

function periodLabel(c, days) {
  if (days === 1) return c.period.day;
  if (days === 7) return c.period.week;
  if (days >= 28 && days <= 31) return c.period.month;
  if (days >= 365 && days <= 366) return c.period.year;
  return c.period.days(days);
}

function plans(lang) {
  const c = COPY[lang] || COPY.en;
  const ads = !!config.adsenseClient;
  const price = Number(config.premiumPrice);
  const days = config.premiumPeriodDays;
  return [
    {
      id: 'free',
      name: c.free,
      price: 0,
      currency: config.premiumCurrency,
      period: '',
      periodDays: 0,
      ads,
      features: ads ? [...c.freeFeatures, c.freeAds] : c.freeFeatures,
    },
    {
      id: 'premium',
      name: c.premium,
      price,
      currency: config.premiumCurrency,
      period: periodLabel(c, days),
      periodDays: days,
      ads: false,
      features: ads ? [c.premiumNoAds, ...c.premiumFeatures] : c.premiumFeatures,
    },
  ];
}

export const billingPublicRouter = Router();
billingPublicRouter.get('/billing/plans', (req, res) => {
  const lang = pickLang(req);
  const c = COPY[lang];
  const available = checkoutAvailable();
  res.json({
    provider: config.billingProvider,
    lang,
    // false = show the Premium CTA disabled with copy.unavailableCta (no payment step exists).
    checkout: available,
    plans: plans(lang),
    copy: {
      notice: !available ? c.unavailable : config.billingProvider === 'mock' ? c.mockNotice : null,
      unavailableCta: c.unavailableCta,
      activated: c.activated,
      disclaimer: c.disclaimer,
    },
  });
});

// ── Stripe REST (form-encoded, no SDK) ─────────────────────────
// STRIPE_API_BASE exists for the test suite (a local fake Stripe); never set it in prod.
const STRIPE_API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1').replace(/\/+$/, '');
async function stripe(method, path, form) {
  const r = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || `stripe HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// Deleting an account must stop the charges: cancel the live subscription first. A
// subscription Stripe no longer knows (404) is already gone, so the deletion goes on.
onBeforeUserDelete(async (user) => {
  if (!user.stripeSubscriptionId || !config.stripeSecret) return;
  try {
    await stripe('DELETE', `/subscriptions/${encodeURIComponent(user.stripeSubscriptionId)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
});

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[billing] route failed:', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

const checkoutLimit = rateLimit({ windowMs: 60_000, max: 10, name: 'checkout' });

export const billingUserRouter = Router();

billingUserRouter.post('/billing/checkout', checkoutLimit, requireUser, wrap(async (req, res) => {
  const { plan } = req.body || {};
  if (plan !== 'premium') return res.status(400).json({ error: 'unknown plan' });
  const c = COPY[pickLang(req)];
  const u = req.user;

  // Already premium: a pending cancellation is undone (resume, no payment involved, so it
  // works even while checkout is closed), anything else is a 409 -- never a second
  // subscription or a silent extension.
  if (isPremium(u)) {
    if (!u.cancelAtPeriodEnd) return res.status(409).json({ error: c.alreadyPremium, code: 'already_premium' });
    if (config.billingProvider === 'stripe' && u.stripeSubscriptionId) {
      try {
        await stripe('POST', `/subscriptions/${encodeURIComponent(u.stripeSubscriptionId)}`, { cancel_at_period_end: 'false' });
      } catch {
        return res.status(502).json({ error: 'stripe unreachable' });
      }
    }
    const user = await updateBilling(u, { cancelAtPeriodEnd: false });
    return res.json({ activated: true, resumed: true, provider: config.billingProvider, message: c.resumed, user });
  }

  if (!checkoutAvailable()) {
    return res.status(503).json({ error: c.unavailable, code: 'checkout_unavailable' });
  }

  if (config.billingProvider === 'stripe') {
    // Hosted Checkout Session. Premium is granted by the webhook once paid, not here.
    const form = {
      mode: 'subscription',
      'line_items[0][price]': config.stripePriceId,
      'line_items[0][quantity]': '1',
      success_url: `${config.publicUrl}/?upgraded=1`,
      cancel_url: `${config.publicUrl}/?canceled=1`,
      client_reference_id: u.id,
      // Stamp our user id everywhere so the webhook can always resolve the user,
      // even on subscription/invoice events that lack client_reference_id.
      'metadata[app_user_id]': u.id,
      'subscription_data[metadata][app_user_id]': u.id,
    };
    // Stripe accepts customer OR customer_email, never both (a returning customer
    // could not resubscribe).
    if (u.stripeCustomerId) form.customer = u.stripeCustomerId;
    else form.customer_email = u.email;
    try {
      const data = await stripe('POST', '/checkout/sessions', form);
      if (!data.url) return res.status(502).json({ error: 'stripe checkout failed' });
      return res.json({ url: data.url, provider: 'stripe' });
    } catch (e) {
      return res.status(502).json({ error: e.status ? e.message : 'stripe unreachable' });
    }
  }

  // Mock provider (dev, or an explicit free beta): instant activation, no payment.
  const user = await updateBilling(u, { plan: 'premium', days: config.premiumPeriodDays, source: 'mock' });
  res.json({ activated: true, provider: 'mock', message: c.activated, user });
}));

// Cancel = stop the renewal, keep what was paid for: Premium stays on until planExpires
// (the CGU promise). Stripe: cancel_at_period_end on the subscription; the webhook's
// customer.subscription.deleted ends it. Mock/admin grants: same flag locally.
billingUserRouter.post('/billing/cancel', requireUser, wrap(async (req, res) => {
  const lang = pickLang(req);
  const c = COPY[lang];
  const u = req.user;
  if (u.role === 'admin') return res.status(400).json({ error: 'admins are always premium' });
  if (!isPremium(u)) {
    const user = u.plan === 'premium' ? await updateBilling(u, { plan: 'free' }) : sanitize(u);
    return res.json({ activated: false, cancelAtPeriodEnd: false, endsAt: null, message: c.canceledNow, user });
  }
  if (u.stripeSubscriptionId && config.stripeSecret) {
    try {
      await stripe('POST', `/subscriptions/${encodeURIComponent(u.stripeSubscriptionId)}`, { cancel_at_period_end: 'true' });
    } catch {
      return res.status(502).json({ error: 'stripe unreachable' });
    }
  }
  if (!u.planExpires) {
    // Nothing to run out (legacy lifetime grant): ends now.
    const user = await updateBilling(u, { plan: 'free' });
    return res.json({ activated: false, cancelAtPeriodEnd: false, endsAt: null, message: c.canceledNow, user });
  }
  const user = await updateBilling(u, { cancelAtPeriodEnd: true });
  const endsAt = u.planExpires;
  const date = new Date(endsAt).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric' });
  res.json({ activated: true, cancelAtPeriodEnd: true, endsAt, message: c.canceled(date), user });
}));

export const billingAdminRouter = Router();

// Admin grants/revokes premium directly (comps, friends, refunds).
billingAdminRouter.post('/users/:id/plan', wrap(async (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { plan, days } = req.body || {};
  // Clamp to 1..3650 days so a negative value can't grant instantly-expired premium.
  const grantDays = Math.min(3650, Math.max(1, Math.floor(Number(days)) || config.premiumPeriodDays));
  const user = await updateBilling(u, { plan: plan === 'premium' ? 'premium' : 'free', days: grantDays, source: 'admin' });
  res.json({ user });
}));

// ── Stripe webhook ─────────────────────────────────────────────
// Verify Stripe's signature scheme (t=timestamp,v1=hmac[,v1=hmac...]) without the SDK.
// During a secret rotation Stripe signs with both secrets: accept if ANY v1 matches.
export function verifyStripeSig(rawBody, header, secret) {
  try {
    let t = null;
    const sigs = [];
    for (const kv of String(header).split(',')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (k === 't') t = v;
      else if (k === 'v1') sigs.push(v);
    }
    if (!t || !sigs.length) return false;
    // Reject stale/future payloads (replay protection), matching Stripe's 300s default.
    const ts = Number(t);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex'));
    return sigs.some((s) => {
      const b = Buffer.from(s);
      return b.length === expected.length && timingSafeEqual(expected, b);
    });
  } catch {
    return false;
  }
}

// Processed event ids (Stripe retries and may deliver twice): bounded, persisted.
const EVENTS_FILE = join(config.dataDir, 'stripe-events.json');
const EVENTS_MAX = 2000;
let seenEvents = null; // Set, loaded lazily on the first webhook
async function loadSeen() {
  if (seenEvents) return;
  // A bounded dedup cache, not account data: a corrupt file is kept as a .bak copy (logged
  // loudly by readJsonArray) and the cache restarts, so webhooks keep being processed.
  const { data } = await readJsonArray(EVENTS_FILE, 'billing');
  seenEvents = new Set((data || []).filter((x) => typeof x === 'string'));
}
let eventsChain = Promise.resolve();
function markSeen(id) {
  seenEvents.add(id);
  while (seenEvents.size > EVENTS_MAX) seenEvents.delete(seenEvents.values().next().value);
  const p = eventsChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${EVENTS_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify([...seenEvents]));
    await rename(tmp, EVENTS_FILE);
  });
  eventsChain = p.catch(() => {});
  return p;
}

// Our user id as stamped at checkout, wherever this object type carries it.
const metaUserId = (obj) =>
  obj.metadata?.app_user_id ||
  obj.subscription_details?.metadata?.app_user_id ||
  obj.parent?.subscription_details?.metadata?.app_user_id ||
  obj.client_reference_id ||
  null;
function resolveUser(obj) {
  const cust = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
  const id = metaUserId(obj);
  return (cust && findByStripeCustomer(cust)) || (id && findUserById(id)) || null;
}
const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);
// Subscription id on an invoice (classic field, or the 2025+ parent block).
const invoiceSub = (obj) => idOf(obj.subscription) || idOf(obj.parent?.subscription_details?.subscription);
// Period end of an invoice: the latest line period end (renewal = the new period).
function invoicePeriodEnd(obj) {
  const ends = (obj.lines?.data || []).map((l) => Number(l?.period?.end)).filter((n) => n > 0);
  return ends.length ? Math.max(...ends) * 1000 : undefined;
}
// Period end of a subscription: top level on older API versions, per item since 2025.
function subPeriodEnd(obj) {
  const top = Number(obj.current_period_end);
  if (top > 0) return top * 1000;
  const ends = (obj.items?.data || []).map((i) => Number(i?.current_period_end)).filter((n) => n > 0);
  return ends.length ? Math.max(...ends) * 1000 : undefined;
}

// Decide what one event changes for this user. Returns the updateBilling() patch, or
// null when there is nothing to do. `fresh` = not older than the last applied event.
function decide(evt, obj, user, fresh) {
  const link = {};
  const cust = idOf(obj.customer);
  if (cust && user.stripeCustomerId !== cust) link.stripeCustomerId = cust;
  const stamp = fresh ? { stripeEventAt: evt.created || 0 } : {};

  switch (evt.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const sub = idOf(obj.subscription);
      if (sub) link.stripeSubscriptionId = sub;
      // Grant only once the money is in. An async method (SEPA) completes the session
      // unpaid; checkout.session.async_payment_succeeded or invoice.paid grants later.
      const paid = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
      if (!paid || !fresh) return Object.keys(link).length ? link : null;
      return { ...link, ...stamp, plan: 'premium', days: config.premiumPeriodDays, source: 'stripe' };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      // An invoice event only ever EXTENDS premium (its status is 'paid', never a
      // subscription status): a renewal must not downgrade anyone.
      const sub = invoiceSub(obj);
      if (sub) link.stripeSubscriptionId = sub;
      if (obj.status && obj.status !== 'paid') return Object.keys(link).length ? link : null;
      if (!fresh) return Object.keys(link).length ? link : null;
      const end = invoicePeriodEnd(obj);
      return { ...link, ...stamp, plan: 'premium', days: config.premiumPeriodDays, expiresAt: end, source: 'stripe', cancelAtPeriodEnd: !!user.cancelAtPeriodEnd };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      if (!fresh) return Object.keys(link).length ? link : null;
      // Events about another (older) subscription than the one we track never change the plan.
      if (user.stripeSubscriptionId && obj.id && obj.id !== user.stripeSubscriptionId && !['active', 'trialing'].includes(obj.status)) {
        return Object.keys(link).length ? link : null;
      }
      if (obj.id) link.stripeSubscriptionId = obj.id;
      if (['active', 'trialing'].includes(obj.status)) {
        return { ...link, ...stamp, plan: 'premium', days: config.premiumPeriodDays, expiresAt: subPeriodEnd(obj), source: 'stripe', cancelAtPeriodEnd: !!obj.cancel_at_period_end };
      }
      // incomplete (first payment pending) and past_due (retrying): leave the plan alone.
      if (['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(obj.status)) {
        return downgrade(user, { ...link, ...stamp });
      }
      return { ...link, ...stamp };
    }
    case 'customer.subscription.deleted': {
      if (!fresh) return Object.keys(link).length ? link : null;
      if (user.stripeSubscriptionId && obj.id && obj.id !== user.stripeSubscriptionId) return Object.keys(link).length ? link : null;
      return downgrade(user, { ...link, ...stamp, stripeSubscriptionId: null });
    }
    default:
      return Object.keys(link).length ? link : null;
  }
}
// A Stripe event never revokes a plan Stripe did not grant (an admin comp stays).
function downgrade(user, patch) {
  if (user.planSource && user.planSource !== 'stripe') return { ...patch, cancelAtPeriodEnd: false };
  return { ...patch, plan: 'free', cancelAtPeriodEnd: false };
}

// Mounted with express.raw() so req.body is the raw Buffer (needed for the HMAC).
// 2xx only once the change is persisted: anything else is a 500 and Stripe retries.
export async function stripeWebhookHandler(req, res) {
  if (config.billingProvider !== 'stripe' || !config.stripeWebhookSecret) return res.status(503).json({ error: 'webhook disabled' });
  if (!Buffer.isBuffer(req.body) || !verifyStripeSig(req.body, req.headers['stripe-signature'] || '', config.stripeWebhookSecret)) {
    return res.status(400).json({ error: 'invalid signature' });
  }
  let evt;
  try {
    evt = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'bad payload' });
  }
  try {
    await loadSeen();
    if (evt.id && seenEvents.has(evt.id)) return res.json({ received: true, duplicate: true });
    const obj = evt.data?.object || {};
    const user = resolveUser(obj);
    if (user) {
      // Stripe does not guarantee order: an event older than the last one applied to this
      // user may still link ids, but never changes the plan.
      const fresh = !(Number(evt.created) < Number(user.stripeEventAt || 0));
      const patch = decide(evt, obj, user, fresh);
      if (patch) await updateBilling(user, patch);
    }
    if (evt.id) await markSeen(evt.id);
    res.json({ received: true });
  } catch (e) {
    console.error('[billing] webhook failed:', e?.message || e);
    res.status(500).json({ error: 'webhook processing failed' });
  }
}

export { sanitize };
