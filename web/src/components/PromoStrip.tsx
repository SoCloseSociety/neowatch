import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useT } from '@/lib/i18n';

const KEY = 'nw.promo.dismissed';

// Dismissible promo strip under the top bar (design: "01 · promo strip").
export function PromoStrip() {
  const { pathname } = useLocation();
  const user = useAuth((s) => s.user);
  const { setPricing, setInstall } = useUI();
  const t = useT();
  // Guard storage: some TV/embedded browsers throw on sessionStorage access, and
  // PromoStrip renders unconditionally -- an unguarded read would crash the app.
  const [hidden, setHidden] = useState(() => {
    try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
  });

  if (hidden || pathname.startsWith('/admin')) return null;

  const close = () => {
    try { sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked */ }
    setHidden(true);
  };
  const premium = !!user?.premium;

  return (
    <div className="relative flex h-[34px] items-center justify-center gap-3 border-b border-white/[0.07] bg-gold/[0.06] px-4 text-[12px] font-medium text-ink-2 sm:px-10">
      <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-gold">{premium ? t('promo.tip') : t('promo.offer')}</span>
      <span className="opacity-40">·</span>
      <span className="hidden truncate sm:inline">
        {premium ? t('promo.installMsg') : t('promo.premiumMsg')}
      </span>
      <span className="truncate sm:hidden">{premium ? t('promo.installMsg') : t('promo.premiumMsg')}</span>
      <button
        onClick={() => (premium ? setInstall(true) : setPricing(true))}
        className="font-bold text-accent hover:underline"
      >
        {premium ? t('top.install') : t('promo.discover')} ›
      </button>
      <button onClick={close} aria-label="Fermer" className="absolute right-3 top-1/2 grid -translate-y-1/2 place-items-center p-1 text-ink-3 hover:text-ink">
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  );
}
