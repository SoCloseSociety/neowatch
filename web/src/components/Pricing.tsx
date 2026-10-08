import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { X, Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useUI, toast } from '@/store/uiStore';
import { useCatalog } from '@/store/catalogStore';
import { Button, Overline, Pill, Spinner, useEscapeClose } from './ui';
import { useT, useI18n, LOCALES, type Lang } from '@/lib/i18n';
import type { Plan } from '@/types';

// GET /billing/plans: plans + their feature lists come localized from the server
// (one source for what Premium really contains). checkout=false: no payment step
// exists right now, so the CTA is shown disabled ("Coming soon").
interface PlansResponse {
  plans: Plan[];
  checkout?: boolean;
  provider?: string;
  copy?: { notice: string | null; unavailableCta: string; activated: string; disclaimer: string };
}

/** sessionStorage flag: "the visitor asked for Premium, then had to sign in first". */
export const PREMIUM_INTENT_KEY = 'nw.intent.premium';
function setIntent(on: boolean) {
  try {
    if (on) sessionStorage.setItem(PREMIUM_INTENT_KEY, '1');
    else sessionStorage.removeItem(PREMIUM_INTENT_KEY);
  } catch { /* storage blocked: the intent is simply not kept */ }
}
function hasIntent() {
  try { return sessionStorage.getItem(PREMIUM_INTENT_KEY) === '1'; } catch { return false; }
}

function money(n: number, currency: string, lang: Lang) {
  try {
    return new Intl.NumberFormat(LOCALES[lang], { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

export function Pricing() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const open = useUI((s) => s.pricingOpen);
  const setPricing = useUI((s) => s.setPricing);
  const setLogin = useUI((s) => s.setLogin);
  const loginOpen = useUI((s) => s.loginOpen);
  const user = useAuth((s) => s.user);
  const refresh = useAuth((s) => s.refresh);
  const [data, setData] = useState<PlansResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prevUser = useRef(user?.id);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setFailed(false);
    api.get<PlansResponse>(`/billing/plans?lang=${lang}`).then(setData).catch(() => setFailed(true));
  }, [open, lang]);
  useEscapeClose(open, () => setPricing(false));

  // Purchase intent survives the sign-in: back on the plans once signed in (WEB-17).
  useEffect(() => {
    const was = prevUser.current;
    prevUser.current = user?.id;
    if (!was && user && hasIntent()) {
      setIntent(false);
      setPricing(true);
    }
  }, [user, setPricing]);
  // Sign-in closed without signing in: the intent is dropped.
  useEffect(() => {
    if (!loginOpen && !user && hasIntent() && !open) setIntent(false);
  }, [loginOpen, user, open]);

  if (!open) return null;

  const premium = !!user?.premium;
  const pending = !!user?.cancelAtPeriodEnd;
  const checkout = data?.checkout !== false;
  const close = () => setPricing(false);

  const upgrade = async () => {
    if (!user) {
      setIntent(true);
      setPricing(false);
      setLogin(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ activated?: boolean; resumed?: boolean; url?: string }>(`/billing/checkout?lang=${lang}`, { plan: 'premium' });
      if (r.url) {
        // Stripe: hosted checkout (Premium is granted by the webhook).
        window.location.href = r.url;
        return;
      }
      if (r.activated) {
        await refresh();
        await useCatalog.getState().loadMeta();
        await useCatalog.getState().loadChannels();
        toast(t(r.resumed ? 'pages.pricing.resumed' : 'toast.premiumOn'), { ok: true });
        setPricing(false);
      }
    } catch (e) {
      const code = e instanceof ApiError ? (e.data as { code?: string } | null)?.code : null;
      setErr(code === 'checkout_unavailable' ? t('pages.pricing.closed') : code === 'already_premium' ? t('pricing.isOn') : t('pages.pricing.failed'));
    } finally {
      setBusy(false);
    }
  };

  // The one primary of this dialog, by state.
  const cta = premium && !pending ? null
    : pending ? { label: t('pages.pricing.resume'), disabled: false }
      : !checkout ? { label: t('pages.pricing.soon'), disabled: true }
        : user ? { label: t('pricing.start'), disabled: false }
          : { label: t('pricing.signInToStart'), disabled: false };

  const notice = !checkout ? t('pages.pricing.closed') : data?.provider === 'mock' ? t('pages.pricing.test') : null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-title"
        className="my-auto w-full max-w-2xl rounded-card border border-line bg-[var(--surface-panneau)] p-[var(--pad-panneau)] shadow-menu animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Overline>{t('pricing.overline')}</Overline>
            <h2 id="pricing-title" className="m-0 mt-1 text-titre2 font-semibold text-ink">{t('pages.pricing.title')}</h2>
          </div>
          <Button variant="quiet" iconOnly onClick={close} aria-label={t('common.close')} title={t('common.close')} icon={<X size={18} aria-hidden="true" />} />
        </div>
        <p className="mb-5 mt-2 text-corps text-ink-2">{t('pricing.description')}</p>

        {!data && !failed ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : failed || !data ? (
          <p className="rounded-field border border-line px-4 py-6 text-center text-sous text-ink-2">{t('pages.pricing.loadFailed')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.plans.map((p) => {
              const isPremiumPlan = p.id === 'premium';
              const mine = isPremiumPlan ? premium : !premium;
              return (
                <section
                  key={p.id}
                  aria-labelledby={`plan-${p.id}`}
                  className={clsx('flex flex-col rounded-card border p-4', isPremiumPlan ? 'border-line-strong bg-[var(--bg-2)]' : 'border-line bg-[var(--bg-1)]')}
                >
                  <div className="flex items-center gap-2">
                    <h3 id={`plan-${p.id}`} className="m-0 text-carte font-semibold text-ink" translate="no">{p.name}</h3>
                    {mine && <Pill tone="ok" className="ml-auto">{t('pill.currentPlan')}</Pill>}
                  </div>
                  <p className="my-2 flex items-baseline gap-1.5">
                    <span className="text-titre2 font-semibold text-ink">{money(p.price, p.currency, lang)}</span>
                    {p.price > 0 && p.period && <span className="text-sous text-ink-3" translate="no">/ {p.period}</span>}
                  </p>
                  {/* Feature lists are the server's localized copy (one source for EN/FR/RU). */}
                  <ul className="mb-4 mt-0 flex-1 list-none space-y-2 p-0" translate="no">
                    {p.features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-sous text-ink-2">
                        <Check size={14} className="mt-1 shrink-0 text-ink-3" aria-hidden="true" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {isPremiumPlan && (cta ? (
                    <Button
                      variant="primary"
                      onClick={upgrade}
                      disabled={busy || cta.disabled}
                      aria-disabled={cta.disabled || undefined}
                      aria-label={cta.label}
                      className="w-full"
                    >
                      {busy && <Spinner className="h-4 w-4" />}
                      {cta.label}
                    </Button>
                  ) : (
                    <p className="m-0 text-center text-sous text-ink-2">{t('pricing.isOn')}</p>
                  ))}
                </section>
              );
            })}
          </div>
        )}

        {err && <p role="alert" className="mb-0 mt-4 rounded-field border border-[var(--red)] px-3 py-2 text-center text-sous text-red">{err}</p>}
        {notice && !premium && <p className="mb-0 mt-4 text-center text-sous text-ink-2">{notice}</p>}
        <p className="mb-0 mt-3 text-center text-meta text-ink-3">{t('pricing.footer')}</p>
      </div>
    </div>
  );
}
