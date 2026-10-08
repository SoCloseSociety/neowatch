import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '@/store/authStore';
import { useT } from '@/lib/i18n';
import { isTV } from '@/lib/device';
import { insideTvShell } from './Install';

// A real Google AdSense unit for free / anonymous users, only when the server
// configures a client id. Mounted by the Films and Radios pages only (never on
// Home or the channel grid); the Premium upsell lives in PromoStrip. No ad on
// TV: a remote cannot dismiss it and the unit is not D-pad friendly.

const CLIENT_ID = /^ca-pub-\d{10,20}$/;

// Consent (legal page, section 3): the ad script and its cookies load only after
// the visitor accepts. The answer is kept on this device; "No thanks" hides the
// banner for good.
const CONSENT_KEY = 'nw.adConsent';
type Consent = 'yes' | 'no' | null;
function readConsent(): Consent {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}
function writeConsent(v: 'yes' | 'no') {
  try { localStorage.setItem(CONSENT_KEY, v); } catch { /* storage blocked: asks again next visit */ }
}

export function AdBanner() {
  const user = useAuth((s) => s.user);
  const config = useAuth((s) => s.config);
  const t = useT();
  const [closed, setClosed] = useState(false);
  const [consent, setConsent] = useState<Consent>(readConsent);
  const adsense = config?.adsenseClient && CLIENT_ID.test(config.adsenseClient) ? config.adsenseClient : null;
  const eligible = !user?.premium && !closed && !!adsense && !isTV() && !insideTvShell() && consent !== 'no';
  const show = eligible && consent === 'yes';

  useEffect(() => {
    if (!show || !adsense) return;
    const id = 'adsbygoogle-js';
    if (!document.getElementById(id)) {
      const s = document.createElement('script');
      s.id = id;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adsense)}`;
      document.head.appendChild(s);
    }
    try {
      const w = window as Window & { adsbygoogle?: unknown[] };
      (w.adsbygoogle = w.adsbygoogle || []).push({});
    } catch {
      /* blocked / not ready */
    }
  }, [show, adsense]);

  if (!eligible) return null;

  if (!show) {
    const answer = (v: 'yes' | 'no') => {
      writeConsent(v);
      setConsent(v);
    };
    return (
      <aside aria-label={t('home.adLabel')} className="mx-[var(--gouttiere)] my-3 flex flex-wrap items-center gap-3 rounded-card border border-line bg-[var(--bg-1)] px-4 py-3">
        <p className="m-0 min-w-0 flex-1 text-sous text-ink-2">{t('ads.consentBody')}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => answer('yes')} className="btn btn-secondary">
            {t('ads.accept')}
          </button>
          <button type="button" onClick={() => answer('no')} className="btn btn-quiet">
            {t('ads.decline')}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside aria-label={t('home.adLabel')} className="relative mx-[var(--gouttiere)] my-3 overflow-hidden rounded-card border border-line bg-[var(--bg-1)]">
      <div className="flex items-center justify-between px-3 pt-1.5">
        <span className="overline">{t('home.adLabel')}</span>
        <button type="button" onClick={() => setClosed(true)} className="btn btn-quiet btn-icon min-h-[36px] w-9" aria-label={t('common.close')} title={t('common.close')}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <ins
        className="adsbygoogle block"
        style={{ display: 'block', minHeight: 60 }}
        data-ad-client={adsense!}
        data-ad-slot="auto"
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}
