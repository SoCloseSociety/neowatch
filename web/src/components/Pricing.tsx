import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { X, Check, Crown, Loader2, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useCatalog } from '@/store/catalogStore';
import { useEscapeClose } from './ui';
import { useT, useI18n } from '@/lib/i18n';
import type { Plan } from '@/types';

// GET /billing/plans: plans + copy come localized from the server (one source).
// checkout=false: no payment step exists right now -> the CTA is shown disabled.
interface PlansResponse {
  plans: Plan[];
  checkout?: boolean;
  copy?: { notice: string | null; unavailableCta: string; activated: string; disclaimer: string };
}

export function Pricing() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const open = useUI((s) => s.pricingOpen);
  const setPricing = useUI((s) => s.setPricing);
  const setLogin = useUI((s) => s.setLogin);
  const { user, refresh, isPremium } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [checkout, setCheckout] = useState(true);
  const [copy, setCopy] = useState<PlansResponse['copy']>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    api.get<PlansResponse>(`/billing/plans?lang=${lang}`).then((r) => {
      setPlans(r.plans);
      setCheckout(r.checkout !== false);
      setCopy(r.copy);
    }).catch(() => {});
  }, [open, lang]);
  useEscapeClose(open, () => setPricing(false));

  if (!open) return null;

  const upgrade = async () => {
    if (!user) {
      setPricing(false);
      setLogin(true);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ activated?: boolean; url?: string; message?: string }>(`/billing/checkout?lang=${lang}`, { plan: 'premium' });
      if (r.url) {
        // Stripe: redirect to hosted checkout (premium granted by the webhook).
        window.location.href = r.url;
        return;
      }
      if (r.activated) {
        await refresh();
        await useCatalog.getState().loadMeta();
        await useCatalog.getState().loadChannels();
        setMsg(r.message || copy?.activated || null);
        setTimeout(() => setPricing(false), 1200);
      }
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Paiement indisponible");
    } finally {
      setBusy(false);
    }
  };

  const premium = plans.find((p) => p.id === 'premium');

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/80 p-4" onClick={() => setPricing(false)}>
      <div className="my-auto w-full max-w-2xl rounded-2xl border border-white/10 bg-panel p-6 shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <Crown className="text-amber-400" size={20} />
          <h2 className="text-lg font-bold text-ink">Passez à NEOWATCH Premium</h2>
          <button onClick={() => setPricing(false)} className="ml-auto rounded-lg p-1.5 text-ink/50 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>
        <p className="mb-5 text-sm text-ink/50">{t('pricing.description')}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <div
              key={p.id}
              className={clsx(
                'relative flex flex-col rounded-2xl border p-4',
                p.id === 'premium'
                  ? 'border-accent/50 bg-gradient-to-b from-accent/[0.12] to-accent/[0.02] shadow-xl shadow-accent/10 ring-1 ring-accent/20'
                  : 'border-white/[0.08] bg-white/[0.02]'
              )}
            >
              {p.id === 'premium' && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-bold text-black shadow-lg">
                  RECOMMANDÉ
                </span>
              )}
              <div className="flex items-center gap-2">
                {p.id === 'premium' ? <Crown size={16} className="text-amber-400" /> : <Sparkles size={16} className="text-ink/50" />}
                <h3 className="font-semibold text-ink">{p.name}</h3>
              </div>
              <div className="my-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold text-ink">{p.price === 0 ? 'Gratuit' : `${p.price} ${p.currency}`}</span>
                {p.period && <span className="text-xs text-ink/40">/{p.period}</span>}
              </div>
              <ul className="mb-4 flex-1 space-y-1.5">
                {p.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px] text-ink/70">
                    <Check size={13} className={clsx('mt-0.5 shrink-0', p.id === 'premium' ? 'text-accent' : 'text-ink/40')} />
                    {f}
                  </li>
                ))}
              </ul>
              {p.id === 'premium' ? (
                <button
                  onClick={upgrade}
                  disabled={busy || isPremium() || !checkout}
                  className="flex items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Crown size={16} />}
                  {isPremium() ? 'Déjà Premium' : !checkout ? copy?.unavailableCta : user ? 'Passer Premium' : 'Se connecter pour souscrire'}
                </button>
              ) : (
                <div className="rounded-lg border border-white/10 py-2.5 text-center text-xs text-ink/40">Plan actuel par défaut</div>
              )}
            </div>
          ))}
        </div>

        {msg && <p className="mt-4 rounded-lg bg-white/[0.04] px-3 py-2 text-center text-sm text-ink/80">{msg}</p>}
        {copy?.notice && !isPremium() && <p className="mt-4 text-center text-sm text-ink/60">{copy.notice}</p>}
        {premium && copy?.disclaimer && (
          <p className="mt-3 text-center text-[11px] text-ink/30">{copy.disclaimer}</p>
        )}
      </div>
    </div>
  );
}
