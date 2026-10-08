import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useT } from '@/lib/i18n';
import { isTV } from '@/lib/device';
import { Pill } from './ui';
import { insideTvShell, runningInstalled } from './Install';

const KEY = 'nw.promo.dismissed';

// Dismissible strip under the top bar: Premium for free users, the install
// tip for premium ones. Quiet (no gold, no primary): the page keeps its one
// primary action. Hidden on /admin, once dismissed, and (Premium message) while
// no payment step is open; the install tip is hidden inside the TV app.
export function PromoStrip() {
  const { pathname } = useLocation();
  const user = useAuth((s) => s.user);
  // No payment step open (production without Stripe): do not advertise what cannot be bought.
  const checkout = useAuth((s) => s.config?.billing?.checkout !== false);
  const setPricing = useUI((s) => s.setPricing);
  const setInstall = useUI((s) => s.setInstall);
  const t = useT();
  // Some TV / embedded browsers throw on sessionStorage: never let that crash the shell.
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });

  const premium = !!user?.premium;
  // Premium users only see the install tip, and only where installing makes sense.
  const installTip = premium;
  if (hidden || pathname.startsWith('/admin')) return null;
  if (installTip && (insideTvShell() || isTV() || runningInstalled())) return null;
  if (!installTip && !checkout) return null;

  const close = () => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* storage blocked */
    }
    setHidden(true);
  };

  return (
    <div className="border-b border-line bg-[var(--bg-1)]">
      <div className="mx-auto flex min-h-[44px] w-full max-w-[1760px] items-center gap-3 py-1 pl-[var(--gouttiere)] pr-2">
        <Pill className="hidden shrink-0 sm:inline-flex">{installTip ? t('pill.tip') : t('pill.premium')}</Pill>
        <p className="min-w-0 truncate text-sous text-ink-2">{installTip ? t('promo.installMsg') : t('promo.premiumMsg')}</p>
        <button type="button" onClick={() => (installTip ? setInstall(true) : setPricing(true))} className="btn btn-quiet shrink-0 px-3 text-ink underline-offset-4 hover:underline">
          {installTip ? t('top.install') : t('promo.discover')}
        </button>
        <button type="button" onClick={close} aria-label={t('common.close')} title={t('common.close')} className="btn btn-quiet btn-icon ml-auto shrink-0">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
