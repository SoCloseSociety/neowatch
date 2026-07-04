import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { setPlan, findUserById, findByStripeCustomer, setStripeCustomer, sanitize, requireUser } from './auth.js';

// Subscription billing. Provider 'mock' activates premium instantly (great for
// localhost / self-host). Provider 'stripe' is a documented seam: it needs
// STRIPE_SECRET + STRIPE_PRICE_ID and a webhook to confirm payment before
// granting premium (not wired without the operator's keys).

function plans() {
  return [
    {
      id: 'free',
      name: 'Free',
      price: 0,
      currency: config.premiumCurrency,
      period: '',
      ads: true,
      features: [
        'TOUT le catalogue en accès libre : sport, films, séries, news, kids, musique, radios...',
        'Lecteur HLS, favoris, multi-écran, guide TV',
        'Financé par la publicité',
      ],
    },
    {
      id: 'premium',
      name: 'Premium',
      price: Number(config.premiumPrice),
      currency: config.premiumCurrency,
      period: 'mois',
      ads: false,
      features: [
        'Aucune publicité',
        'Multi-écran étendu + synchronisation de vos préférences entre appareils',
        'Vos propres playlists M3U / IPTV + guide EPG personnalisé',
        'Curation et confort : catégories épinglées, qualité max',
      ],
    },
  ];
}

export const billingPublicRouter = Router();
billingPublicRouter.get('/billing/plans', (_req, res) => {
  res.json({ provider: config.billingProvider, plans: plans() });
});

export const billingUserRouter = Router();

billingUserRouter.post('/billing/checkout', requireUser, async (req, res) => {
  const { plan } = req.body || {};
  if (plan !== 'premium') return res.status(400).json({ error: 'unknown plan' });

  if (config.billingProvider === 'stripe') {
    if (!config.stripeSecret || !config.stripePriceId) {
      return res.status(503).json({ error: 'stripe not configured (set STRIPE_SECRET, STRIPE_PRICE_ID)' });
    }
    // Create a real Stripe Checkout Session (REST, no SDK). Premium is granted
    // by the webhook on checkout.session.completed, not here.
    try {
      const body = new URLSearchParams();
      body.set('mode', 'subscription');
      body.set('line_items[0][price]', config.stripePriceId);
      body.set('line_items[0][quantity]', '1');
      body.set('success_url', `${config.publicUrl}/?upgraded=1`);
      body.set('cancel_url', `${config.publicUrl}/?canceled=1`);
      body.set('client_reference_id', req.user.id);
      body.set('customer_email', req.user.email);
      // Stamp our user id everywhere so the webhook can always resolve the user,
      // even on subscription/invoice events that lack client_reference_id.
      body.set('metadata[app_user_id]', req.user.id);
      body.set('subscription_data[metadata][app_user_id]', req.user.id);
      if (req.user.stripeCustomerId) body.set('customer', req.user.stripeCustomerId);
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.stripeSecret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      if (!r.ok || !data.url) return res.status(502).json({ error: data?.error?.message || 'stripe checkout failed' });
      return res.json({ url: data.url, provider: 'stripe' });
    } catch (e) {
      return res.status(502).json({ error: 'stripe unreachable' });
    }
  }

  // Mock provider: instant activation.
  const user = await setPlan(req.user, 'premium', config.premiumPeriodDays);
  res.json({ activated: true, provider: 'mock', user });
});

billingUserRouter.post('/billing/cancel', requireUser, async (req, res) => {
  const user = await setPlan(req.user, 'free');
  res.json({ activated: false, user });
});

export const billingAdminRouter = Router();

// Admin grants/revokes premium directly (comps, friends, refunds).
billingAdminRouter.post('/users/:id/plan', async (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { plan, days } = req.body || {};
  // Clamp to 1..3650 days so a negative value can't grant instantly-expired premium.
  const grantDays = Math.min(3650, Math.max(1, Math.floor(Number(days)) || config.premiumPeriodDays));
  const user = await setPlan(u, plan === 'premium' ? 'premium' : 'free', grantDays);
  res.json({ user });
});

// ── Stripe webhook ─────────────────────────────────────────────
// Verify Stripe's signature scheme (t=timestamp,v1=hmac) without the SDK.
function verifyStripeSig(rawBody, header, secret) {
  try {
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')));
    if (!parts.t || !parts.v1) return false;
    // Reject stale/future payloads (replay protection), matching Stripe's 300s default.
    const ts = Number(parts.t);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const signed = `${parts.t}.${rawBody.toString('utf8')}`;
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Resolve our user from any Stripe object (customer id, our metadata, or session ref).
function resolveUser(obj) {
  return (
    (obj.customer && findByStripeCustomer(obj.customer)) ||
    (obj.metadata?.app_user_id && findUserById(obj.metadata.app_user_id)) ||
    (obj.client_reference_id && findUserById(obj.client_reference_id)) ||
    null
  );
}
const expiryFrom = (obj) => (obj.current_period_end ? obj.current_period_end * 1000 : undefined);

// Mounted with express.raw() so req.body is the raw Buffer (needed for the HMAC).
export async function stripeWebhookHandler(req, res) {
  if (config.billingProvider !== 'stripe' || !config.stripeWebhookSecret) return res.status(503).json({ error: 'webhook disabled' });
  if (!verifyStripeSig(req.body, req.headers['stripe-signature'] || '', config.stripeWebhookSecret)) {
    return res.status(400).json({ error: 'invalid signature' });
  }
  let evt;
  try {
    evt = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'bad payload' });
  }
  const obj = evt.data?.object || {};
  try {
    const user = resolveUser(obj);
    switch (evt.type) {
      case 'checkout.session.completed': {
        // Only grant once payment is actually collected (delayed methods come later).
        if (user && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required' || obj.mode === 'subscription')) {
          if (obj.customer) await setStripeCustomer(user, obj.customer);
          await setPlan(user, 'premium', config.premiumPeriodDays);
        } else if (user && obj.customer) {
          await setStripeCustomer(user, obj.customer); // link for later events
        }
        break;
      }
      // Renewals + activation: extend premium to the real period end.
      case 'invoice.payment_succeeded':
      case 'invoice.paid':
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const status = obj.status; // present on subscription events
        const active = !status || ['active', 'trialing'].includes(status);
        if (user && active) await setPlan(user, 'premium', config.premiumPeriodDays, expiryFrom(obj));
        else if (user && !active && status !== 'past_due') await setPlan(user, 'free');
        break;
      }
      case 'customer.subscription.deleted':
        if (user) await setPlan(user, 'free');
        break;
    }
  } catch {
    /* never fail the webhook on our side */
  }
  res.json({ received: true });
}

export { sanitize };
